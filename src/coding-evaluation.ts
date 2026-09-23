import { mkdtemp, mkdir, writeFile, rm, readdir, lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { idSchema, specialistSchema } from "./config.js";
import type { CodingModel } from "./llm.js";
import type { Project } from "./registry.js";
import { run, RUNTIME_POLICY_VERSION, type RunResult } from "./runtime.js";
import { Workspace, digest, excluded, readText } from "./workspace.js";
import { BlockedError, errorMessage } from "./errors.js";
import { readJevKey } from "./jev-key.js";
import { verifierCheckSchema, verifierLimitsSchema, verifyCodingFixture, type Verification } from "./coding-verifier.js";
import { summarizeReportedCosts } from "./budget.js";

const fixturePath = z.string().max(240).refine((value) =>
  /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
  !excluded(value) && value.split("/").at(-1)?.toLowerCase() !== "agents.md",
"Use a normalized, non-protected fixture path");
const filesSchema = z.record(fixturePath, z.string().max(64_000)).refine((files) =>
  Object.keys(files).length <= 100 && JSON.stringify(files).length <= 500_000, "Fixture exceeds file or size limit");

const codingTaskSchema = z.object({
  id: idSchema,
  task: z.string().min(1).max(20_000),
  files: filesSchema,
  writablePaths: z.array(fixturePath).min(1).max(30),
  requiredChangedPaths: z.array(fixturePath).min(1).max(30),
  checks: z.array(verifierCheckSchema).min(1).max(30),
  expectedInitialFailures: z.array(idSchema).min(1).max(30),
}).strict().superRefine((task, context) => {
  for (const [field, values] of [
    ["writablePaths", task.writablePaths], ["requiredChangedPaths", task.requiredChangedPaths],
    ["expectedInitialFailures", task.expectedInitialFailures], ["checks", task.checks.map((check) => check.id)],
  ] as const) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [field], message: "Duplicate entries" });
  }
  if (task.requiredChangedPaths.some((name) => !task.writablePaths.includes(name))) {
    context.addIssue({ code: "custom", message: "Required changes must be writable paths" });
  }
  if (task.expectedInitialFailures.some((id) => !task.checks.some((check) => check.id === id))) {
    context.addIssue({ code: "custom", message: "Initial failures must name acceptance checks" });
  }
  const paths = [...new Set([...Object.keys(task.files), ...task.writablePaths])].sort();
  const lowercase = paths.map((name) => name.toLowerCase());
  if (new Set(lowercase).size !== paths.length ||
    lowercase.some((name) => lowercase.some((other) => other.startsWith(`${name}/`)))) {
    context.addIssue({ code: "custom", message: "Fixture paths collide (including case-insensitive filesystems)" });
  }
});

export const codingBenchmarkSchema = z.object({
  version: z.literal(1),
  split: z.enum(["development", "heldout"]),
  feature: z.enum(["skills", "delegation", "routing"]),
  repetitions: z.number().int().min(1).max(20).default(3),
  seed: z.number().int().min(1).max(2_147_483_646).default(42),
  dynamicCapabilities: z.enum(["off", "identical"]).default("off"),
  instructions: z.string().max(24_000).default(""),
  capabilities: z.object({
    skills: z.array(z.object({
      id: idSchema, description: z.string().min(1).max(2000), instructions: z.string().min(1).max(24_000),
    }).strict()).max(20).default([]),
    specialists: z.array(specialistSchema.refine((specialist) =>
      specialist.model === undefined &&
      specialist.tools.every((tool) => ["list_files", "read_file", "search_files", "write_file", "replace_text"].includes(tool)),
    "Benchmark specialists must use the same model and cannot execute commands")).max(20).default([]),
  }).strict(),
  verifier: verifierLimitsSchema,
  tasks: z.array(codingTaskSchema).min(1).max(50),
}).strict().superRefine((suite, context) => {
  for (const entries of [suite.tasks, suite.capabilities.skills, suite.capabilities.specialists]) {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
      context.addIssue({ code: "custom", message: "Duplicate task or capability IDs" });
    }
  }
  for (const specialist of suite.capabilities.specialists) {
    if (specialist.skills.some((id) => !suite.capabilities.skills.some((skill) => skill.id === id))) {
      context.addIssue({ code: "custom", message: `Unknown skill for specialist ${specialist.id}` });
    }
  }
  if ((suite.feature === "skills" && !suite.capabilities.skills.length) ||
    (suite.feature === "delegation" && !suite.capabilities.specialists.length) ||
    (!suite.capabilities.skills.length && !suite.capabilities.specialists.length)) {
    context.addIssue({ code: "custom", message: "The selected feature requires eligible suite-owned capabilities" });
  }
});

type CodingTask = z.infer<typeof codingTaskSchema>;
type Variant = "baseline" | "jev";
export interface CodingBenchmarkOptions {
  allowVerifierCode?: boolean;
  model?: CodingModel;
  env?: NodeJS.ProcessEnv;
}

class FixtureWorkspace extends Workspace {
  constructor(root: string, private readonly writablePaths: string[]) { super(root); }
  override async path(relative: string, writing = false): Promise<string> {
    if (writing && !this.writablePaths.includes(relative)) throw new BlockedError("Only explicit benchmark fixture paths may be edited");
    return super.path(relative, writing);
  }
}

function treeHash(files: Record<string, string>): string {
  return digest(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))));
}

async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const stat = await lstat(path.join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Fixture contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) Object.assign(files, await snapshot(root, relative));
    else if (stat.isFile()) files[relative] = await readText(path.join(root, relative), 100_000);
    else throw new Error(`Fixture contains a non-regular file: ${relative}`);
  }
  return files;
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const filename = path.join(root, relative);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await writeFile(filename, content, { flag: "wx", mode: 0o600 });
  }
}

function expectedFailure(task: CodingTask, verification: Verification): boolean {
  return verification.status === "failed" &&
    verification.checks.every((check) => check.status ===
      (task.expectedInitialFailures.includes(check.id) ? "assertion_failed" : "passed"));
}

function requireVerifierConsent(options: Pick<CodingBenchmarkOptions, "allowVerifierCode">): void {
  if (!options.allowVerifierCode) throw new Error(
    "Coding benchmarks execute suite and model-written JavaScript with your OS permissions, NOT in a sandbox. " +
    "Review the suite and explicitly consent with --allow-verifier-code.");
}

export async function preflightCodingBenchmark(input: unknown, signal: AbortSignal,
  options: Pick<CodingBenchmarkOptions, "allowVerifierCode"> = {}) {
  const suite = codingBenchmarkSchema.parse(input);
  requireVerifierConsent(options);
  const tasks: { taskId: string; valid: boolean; initialTreeHash: string; verifier: Verification }[] = [];
  for (const task of suite.tasks) {
    if (signal.aborted) break;
    const verifier = await verifyCodingFixture(task.files, task.checks, { ...suite.verifier, allowVerifierCode: true }, signal);
    tasks.push({ taskId: task.id, valid: expectedFailure(task, verifier), initialTreeHash: treeHash(task.files), verifier });
  }
  return {
    valid: !signal.aborted && tasks.length === suite.tasks.length && tasks.every((task) => task.valid),
    cancelled: signal.aborted, suiteHash: digest(JSON.stringify(suite)), tasks,
  };
}

export interface CodingTrial {
  taskId: string;
  repetition: number;
  variant: Variant;
  status: RunResult["status"] | "fixture_error";
  acceptancePassed: boolean;
  integrityPassed: boolean;
  failureReasons: string[];
  initialTreeHash: string;
  finalTreeHash: string | null;
  changedPaths: string[];
  verifier: Verification | null;
  route: RunResult["route"] | null;
  metrics: RunResult["metrics"] | null;
  wallMs: number;
  machineMs: number;
  approvalWaitMs: number;
  jevMs: number;
  routingRequests: number;
  fallbacks: number;
  errors: { event: string; reason: string }[];
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function summarize(trials: CodingTrial[]) {
  return {
    trials: trials.length, accepted: trials.filter((trial) => trial.acceptancePassed).length,
    acceptanceRate: trials.length ? trials.filter((trial) => trial.acceptancePassed).length / trials.length : null,
    medianMachineMs: percentile(trials.map((trial) => trial.machineMs), 0.5),
    p95MachineMs: percentile(trials.map((trial) => trial.machineMs), 0.95),
    medianApprovalWaitMs: percentile(trials.map((trial) => trial.approvalWaitMs), 0.5),
    medianJevMs: percentile(trials.map((trial) => trial.jevMs), 0.5),
    observedTokens: trials.reduce((sum, trial) => sum + (trial.metrics ?
      trial.metrics.llm.inputTokens + trial.metrics.llm.outputTokens +
      trial.metrics.jev.inputTokens + trial.metrics.jev.outputTokens : 0), 0),
    incompleteUsageTrials: trials.filter((trial) => !trial.metrics || trial.metrics.usageIncompleteRequests > 0).length,
    ...summarizeReportedCosts(trials.map((trial) => trial.metrics), trials.filter((trial) => trial.acceptancePassed).length),
  };
}

export async function benchmarkCode(project: Project, input: unknown, signal: AbortSignal,
  options: CodingBenchmarkOptions = {}) {
  const suite = codingBenchmarkSchema.parse(input);
  requireVerifierConsent(options);
  if (!project.config.jev.allowDataSharing) throw new Error("Benchmark Jev trials require explicit data-sharing consent");
  if (suite.feature === "delegation" && project.config.limits.maxSpecialistRuns === 0) {
    throw new Error("Delegation benchmark requires a nonzero specialist budget");
  }
  const key = (options.env ?? process.env)[project.config.jev.apiKeyEnv] ?? (!options.env ? await readJevKey() : undefined);
  if (!key) throw new Error(`Missing ${project.config.jev.apiKeyEnv}; configure Jev before benchmarking`);
  const config = structuredClone(project.config);
  config.commands = {};
  config.protectedPaths = [];
  config.jev.guardrail = "off";
  config.jev.routeSkills = suite.feature !== "delegation";
  config.jev.routeSpecialists = suite.feature !== "skills";
  const resources = Object.fromEntries(suite.capabilities.skills.map((skill) =>
    [`.jev/skills/${skill.id}.md`, skill.instructions]));
  const skills = suite.capabilities.skills.map((skill) => ({
    id: skill.id, description: skill.description, instructions: `.jev/skills/${skill.id}.md`,
    version: "benchmark-1", mandatory: false,
  }));
  const { tasks: preflight } = await preflightCodingBenchmark(suite, signal, options);
  const permissions = { write: true, commands: false, execution: false, external: false };
  const order = suite.tasks.filter((task) => preflight.some((check) => check.taskId === task.id && check.valid))
    .flatMap((task) => Array.from({ length: suite.repetitions }, (_, repetition) =>
      (["baseline", "jev"] as const).map((variant) => ({ task, repetition, variant })))).flat();
  let seed = suite.seed;
  for (let index = order.length - 1; index > 0; index--) {
    seed = seed * 16807 % 2147483647;
    const other = seed % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  const trials: CodingTrial[] = [];
  for (const { task, repetition, variant } of order) {
    if (signal.aborted) break;
    const started = performance.now();
    const root = await mkdtemp(path.join(await realpath(tmpdir()), "jev-code-benchmark-"));
    const row: CodingTrial = {
      taskId: task.id, repetition, variant, status: "fixture_error", acceptancePassed: false, integrityPassed: false,
      failureReasons: [], initialTreeHash: treeHash(task.files), finalTreeHash: null, changedPaths: [],
      verifier: null, route: null, metrics: null, wallMs: 0, machineMs: 0, approvalWaitMs: 0,
      jevMs: 0, routingRequests: 0, fallbacks: 0, errors: [],
    };
    try {
      await writeTree(root, { ...task.files, ...resources });
      const before = await snapshot(root);
      if (treeHash(before) !== treeHash({ ...task.files, ...resources })) throw new Error("Initial fixture tree mismatch");
      const instance: Project = {
        workspace: new FixtureWorkspace(root, task.writablePaths), config: structuredClone(config),
        skills: structuredClone(skills), specialists: structuredClone(suite.capabilities.specialists),
        instructions: suite.instructions,
      };
      instance.config.jev.mode = variant === "baseline" ? "off" : "on";
      const result = await run(instance, {
        task: `${task.task}\n\nBenchmark fixture policy: edit only ${task.writablePaths.join(", ")} using write_file or replace_text. ` +
          "Commands and capability creation are disabled. Fixed acceptance tests are run independently after your final response. " +
          "Do not claim to have run those tests.",
        permissions, signal,
        ...{ backgroundSpecialists: false },
        dynamicCapabilities: suite.dynamicCapabilities === "identical",
        ...(options.model ? { model: options.model } : {}),
        env: { ...(options.env ?? process.env), [project.config.jev.apiKeyEnv]: key },
        async approve(action, approvalSignal) {
          approvalSignal.throwIfAborted();
          return (action.name === "write_file" || action.name === "replace_text") &&
            typeof action.details.path === "string" && task.writablePaths.includes(action.details.path);
        },
        emit(event, data) {
          if (event === "jev_request") row.routingRequests++;
          if (event === "jev_response" || event === "jev_error") row.jevMs += Number(data?.durationMs ?? 0);
          if (event === "routing_fallback") row.fallbacks++;
          if (["routing_fallback", "jev_error", "tool_error", "specialist_limit", "specialist_report_invalid"].includes(event)) {
            row.errors.push({ event, reason: String(data?.reason ?? event).slice(0, 2000) });
          }
        },
      });
      row.status = result.status;
      row.metrics = result.metrics;
      row.route = result.route;
      row.approvalWaitMs = result.metrics.approvalWaitMs;
      if (result.status !== "completed") row.failureReasons.push(`Agent ${result.status}: ${result.text.slice(0, 2000)}`);
      const after = await snapshot(root);
      row.finalTreeHash = treeHash(Object.fromEntries(Object.entries(after).filter(([name]) => !name.startsWith(".jev/"))));
      row.changedPaths = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((name) => before[name] !== after[name]).sort();
      row.integrityPassed = row.changedPaths.every((name) => task.writablePaths.includes(name));
      for (const name of row.changedPaths) {
        if (!task.writablePaths.includes(name)) row.failureReasons.push(`Changed forbidden path: ${name}`);
      }
      for (const name of task.requiredChangedPaths) {
        if (!row.changedPaths.includes(name) || !after[name]?.trim()) row.failureReasons.push(`Required changed file missing or empty: ${name}`);
      }
      const candidateFiles = Object.fromEntries(Object.entries(after).filter(([name]) => !name.startsWith(".jev/")));
      row.verifier = await verifyCodingFixture(candidateFiles, task.checks, { ...suite.verifier, allowVerifierCode: true }, signal);
      if (row.verifier.status !== "passed") row.failureReasons.push(`Acceptance verifier ${row.verifier.status}`);
      row.acceptancePassed = row.failureReasons.length === 0;
    } catch (error) {
      row.status = signal.aborted ? "cancelled" : "fixture_error";
      row.failureReasons.push(errorMessage(error).slice(0, 2000));
    } finally {
      await rm(root, { recursive: true, force: true });
      row.wallMs = Math.round(performance.now() - started);
      row.machineMs = Math.max(0, row.wallMs - row.approvalWaitMs);
    }
    trials.push(row);
  }
  const pairs = suite.tasks.flatMap((task) => Array.from({ length: suite.repetitions }, (_, repetition) => {
    const baseline = trials.find((trial) => trial.taskId === task.id && trial.repetition === repetition && trial.variant === "baseline");
    const jev = trials.find((trial) => trial.taskId === task.id && trial.repetition === repetition && trial.variant === "jev");
    return {
      taskId: task.id, repetition, complete: Boolean(baseline && jev),
      baselinePassed: baseline?.acceptancePassed ?? null, jevPassed: jev?.acceptancePassed ?? null,
      machineDeltaMs: baseline && jev ? jev.machineMs - baseline.machineMs : null,
    };
  }));
  const validComparison = !signal.aborted && preflight.length === suite.tasks.length &&
    preflight.every((check) => check.valid) && trials.length === suite.tasks.length * suite.repetitions * 2 &&
    trials.every((trial) => trial.integrityPassed &&
      !["fixture_error", "failed", "cancelled"].includes(trial.status) && trial.fallbacks === 0 &&
      (trial.variant !== "jev" || trial.routingRequests > 0));
  return {
    version: 1, kind: "coding", suiteHash: digest(JSON.stringify(suite)), configHash: digest(JSON.stringify(config)),
    policyVersion: RUNTIME_POLICY_VERSION, split: suite.split, feature: suite.feature, seed: suite.seed,
    repetitions: suite.repetitions, provider: config.llm.provider, model: config.llm.model,
    capabilitiesHash: digest(JSON.stringify(suite.capabilities)), instructionsHash: digest(suite.instructions),
    policy: {
      permissions, dynamicCapabilities: suite.dynamicCapabilities,
      capabilityCreation: false, backgroundSpecialists: false,
      workspaceConfigCopied: false, workspaceFilesCopied: false,
      guardrail: "off", limits: config.limits, maxOutputTokens: config.llm.maxOutputTokens,
      approval: "automated exact fixture-path edits only; not normal run mode",
      verifier: { ...suite.verifier, sandboxed: false, environment: "empty", modules: "relative fixture CommonJS only" },
    },
    validComparison, cancelled: signal.aborted,
    acceptance: "Fixed external executable checks plus expected assertion failures before editing and changed-file constraints. " +
      "These checks measure this suite, not general coding quality. Node VM/process isolation is NOT a security sandbox.",
    timing: "machineMs = full trial wall time (setup, agent, verification, cleanup) minus approval wait; preflight is separate. Automated approval is not human latency.",
    baseline: summarize(trials.filter((trial) => trial.variant === "baseline")),
    jev: summarize(trials.filter((trial) => trial.variant === "jev")),
    paired: {
      bothPassed: pairs.filter((pair) => pair.baselinePassed === true && pair.jevPassed === true).length,
      jevOnlyPassed: pairs.filter((pair) => pair.baselinePassed === false && pair.jevPassed === true).length,
      baselineOnlyPassed: pairs.filter((pair) => pair.baselinePassed === true && pair.jevPassed === false).length,
      neitherPassed: pairs.filter((pair) => pair.baselinePassed === false && pair.jevPassed === false).length,
      incomplete: pairs.filter((pair) => !pair.complete).length,
    },
    preflight, pairs, trials,
  };
}
