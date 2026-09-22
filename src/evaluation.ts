import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { CodingModel } from "./llm.js";
import { initialize } from "./init.js";
import { loadProject, type Project } from "./registry.js";
import { readText, resolvePath, digest } from "./workspace.js";
import { run, RUNTIME_POLICY_VERSION, type RunResult } from "./runtime.js";
import { JevClient, scopeQuestion } from "./jev.js";
import { readJevKey } from "./jev-key.js";
import { errorMessage } from "./errors.js";

const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  task: z.string().min(1).max(20_000),
  files: z.record(z.string(), z.string().max(100_000)),
  answerIncludes: z.array(z.string().min(1)).min(1),
  answerExcludes: z.array(z.string().min(1)).default([]),
  minToolCalls: z.number().int().min(0).max(40).default(1),
}).strict();

export const benchmarkSchema = z.object({
  version: z.literal(1), split: z.enum(["development", "heldout"]),
  feature: z.enum(["skills", "delegation", "routing"]),
  repetitions: z.number().int().min(1).max(20).default(3),
  seed: z.number().int().min(1).max(2_147_483_647).default(42),
  tasks: z.array(taskSchema).min(1).max(50),
}).strict();

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

export function summarizeTrials(rows: { result: RunResult; acceptancePassed: boolean; jevMs: number }[]): unknown {
  return {
    trials: rows.length, acceptancePassed: rows.filter((row) => row.acceptancePassed).length,
    incompleteUsageTrials: rows.filter((row) => row.result.metrics.usageIncompleteRequests > 0).length,
    medianMs: percentile(rows.map((row) => row.result.metrics.durationMs), 0.5),
    p95Ms: percentile(rows.map((row) => row.result.metrics.durationMs), 0.95),
    medianJevMs: percentile(rows.map((row) => row.jevMs), 0.5),
    tokens: rows.reduce((sum, row) => sum + row.result.metrics.llm.inputTokens + row.result.metrics.llm.outputTokens +
      row.result.metrics.jev.inputTokens + row.result.metrics.jev.outputTokens, 0),
    costUsd: null, costPerAcceptedTaskUsd: null,
  };
}

export async function benchmark(project: Project, input: unknown, signal: AbortSignal, model?: CodingModel,
  env?: NodeJS.ProcessEnv): Promise<unknown> {
  const suite = benchmarkSchema.parse(input);
  if (!project.config.jev.allowDataSharing) throw new Error("Benchmark Jev trials require explicit data-sharing consent");
  const key = (env ?? process.env)[project.config.jev.apiKeyEnv] ?? (!env ? await readJevKey() : undefined);
  if (!key) throw new Error(`Missing ${project.config.jev.apiKeyEnv}; run jevcode jev setup before benchmarking`);
  if (new Set(suite.tasks.map((task) => task.id)).size !== suite.tasks.length) throw new Error("Duplicate benchmark task IDs");
  const resources: Record<string, string> = {};
  for (const skill of project.skills) {
    for (const relative of [skill.instructions, ...(skill.resources ?? [])]) {
      resources[relative] = await readText(await resolvePath(project.workspace.root, relative), 100_000);
    }
  }
  let seed = suite.seed;
  const order = suite.tasks.flatMap((task) => Array.from({ length: suite.repetitions }, (_, repetition) =>
    (["baseline", "jev"] as const).map((variant) => ({ task, repetition, variant })))).flat();
  for (let index = order.length - 1; index > 0; index--) {
    seed = seed * 16807 % 2147483647;
    const other = seed % (index + 1);
    [order[index], order[other]] = [order[other]!, order[index]!];
  }
  const rows: {
    taskId: string; repetition: number; variant: "baseline" | "jev";
    result: RunResult; acceptancePassed: boolean; jevMs: number; fallbacks: number;
  }[] = [];
  for (const trial of order) {
    signal.throwIfAborted();
    const root = await mkdtemp(path.join(tmpdir(), "jev-benchmark-"));
    try {
      await initialize(root);
      const config = structuredClone(project.config);
      config.jev.mode = trial.variant === "baseline" ? "off" : "on";
      config.jev.routeSkills = suite.feature !== "delegation";
      config.jev.routeSpecialists = suite.feature !== "skills";
      await writeFile(path.join(root, ".jev/config.json"), JSON.stringify(config), { mode: 0o600 });
      // Replace only the generated fixture registries, never user workspace directories.
      await rm(path.join(root, ".jev/skills"), { recursive: true });
      await rm(path.join(root, ".jev/specialists"), { recursive: true });
      await mkdir(path.join(root, ".jev/skills"), { mode: 0o700 });
      await mkdir(path.join(root, ".jev/specialists"), { mode: 0o700 });
      for (const [relative, content] of Object.entries(resources)) {
        const filename = await resolvePath(root, relative, true);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, content, { mode: 0o600 });
      }
      for (const [kind, items] of [["skills", project.skills], ["specialists", project.specialists]] as const) {
        for (const item of items) {
          await writeFile(path.join(root, ".jev", kind, `${item.id}.json`), JSON.stringify(item), { mode: 0o600 });
        }
      }
      const instance = await loadProject(root);
      instance.instructions = project.instructions;
      for (const [relative, content] of Object.entries(trial.task.files)) {
        const filename = await instance.workspace.path(relative, true);
        await mkdir(path.dirname(filename), { recursive: true });
        await writeFile(filename, content, { flag: "wx", mode: 0o600 });
      }
      let jevMs = 0;
      let fallbacks = 0;
      const result = await run(instance, {
        task: trial.task.task, permissions: { write: false, commands: false }, signal, approve: async () => false,
        dynamicCapabilities: false,
        ...(model ? { model } : {}), env: { ...(env ?? process.env), [project.config.jev.apiKeyEnv]: key },
        emit(event, data) {
          if (event === "jev_response" || event === "jev_error") jevMs += Number(data?.durationMs ?? 0);
          if (event === "routing_fallback") fallbacks++;
        },
      });
      const acceptancePassed = result.status === "completed" &&
        result.metrics.toolCalls >= trial.task.minToolCalls &&
        trial.task.answerIncludes.every((text) => result.text.includes(text)) &&
        trial.task.answerExcludes.every((text) => !result.text.includes(text));
      rows.push({ taskId: trial.task.id, repetition: trial.repetition, variant: trial.variant, result, acceptancePassed, jevMs, fallbacks });
      signal.throwIfAborted();
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  return {
    version: 1, suiteHash: digest(JSON.stringify(suite)), configHash: digest(JSON.stringify(project.config)),
    policyVersion: RUNTIME_POLICY_VERSION,
    registryHash: digest(JSON.stringify({ skills: project.skills, specialists: project.specialists, resources, instructions: project.instructions })),
    split: suite.split, seed: suite.seed, feature: suite.feature,
    provider: project.config.llm.provider, model: project.config.llm.model,
    validRoutingComparison: !rows.some((row) => row.variant === "jev" && row.fallbacks > 0),
    acceptance: "Literal answer checks and minimum tool count, not a proof of coding correctness; human review remains required.",
    baseline: summarizeTrials(rows.filter((row) => row.variant === "baseline")),
    jev: summarizeTrials(rows.filter((row) => row.variant === "jev")),
    trials: rows.map(({ result, ...row }) => ({ ...row, status: result.status, route: result.route, metrics: result.metrics })),
  };
}

export const guardrailSuiteSchema = z.object({
  version: z.literal(1), split: z.enum(["development", "heldout"]),
  cases: z.array(z.object({
    id: z.string().min(1), task: z.string().min(1), action: z.unknown().refine((value) => value !== undefined),
    expected: z.enum(["allow", "block"]),
  }).strict()).min(1).max(200),
}).strict();

export async function evaluateGuardrails(project: Project, input: unknown, signal: AbortSignal,
  env = process.env): Promise<unknown> {
  const suite = guardrailSuiteSchema.parse(input);
  if (!project.config.jev.allowDataSharing) throw new Error("Guardrail evaluation requires explicit data-sharing consent");
  const key = env[project.config.jev.apiKeyEnv] ?? await readJevKey();
  if (!key) throw new Error(`Missing ${project.config.jev.apiKeyEnv}; run jevcode jev setup before evaluating guardrails`);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const client = new JevClient(project.config.jev, key, () => {}, (tokens) => {
    usage.inputTokens += tokens.inputTokens; usage.outputTokens += tokens.outputTokens;
  });
  const rows = [];
  for (const entry of suite.cases) {
    signal.throwIfAborted();
    const started = performance.now();
    try {
      const answers = await client.evaluate({ task: entry.task, proposedAction: entry.action }, { scope: scopeQuestion }, signal);
      const score = answers.scope?.type === "noul" ? answers.scope.noul : null;
      rows.push({ id: entry.id, expected: entry.expected, score, predicted: score !== null && score >= project.config.jev.guardrailThreshold ? "allow" : "block",
        durationMs: Math.round(performance.now() - started), error: null });
    } catch (error) {
      signal.throwIfAborted();
      rows.push({ id: entry.id, expected: entry.expected, score: null, predicted: "block",
        durationMs: Math.round(performance.now() - started), error: errorMessage(error) });
    }
  }
  return {
    version: 1, split: suite.split, suiteHash: digest(JSON.stringify(suite)), threshold: project.config.jev.guardrailThreshold,
    falseAllows: rows.filter((row) => row.expected === "block" && row.predicted === "allow").length,
    falseBlocks: rows.filter((row) => row.expected === "allow" && row.predicted === "block").length,
    errors: rows.filter((row) => row.error !== null).length,
    allowedCases: rows.filter((row) => row.expected === "allow").length,
    blockedCases: rows.filter((row) => row.expected === "block").length,
    medianMs: percentile(rows.map((row) => row.durationMs), 0.5), p95Ms: percentile(rows.map((row) => row.durationMs), 0.95),
    usage, costUsd: null, cases: rows,
  };
}
