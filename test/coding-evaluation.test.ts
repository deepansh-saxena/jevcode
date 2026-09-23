import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdtemp, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { benchmarkCode, codingBenchmarkSchema, preflightCodingBenchmark } from "../src/coding-evaluation.js";
import { verifyCodingFixture } from "../src/coding-verifier.js";
import type { CodingModel } from "../src/llm.js";
import { digest } from "../src/workspace.js";
import { fixture, server, requestBody, call, final } from "./helpers.js";

const signal = (): AbortSignal => new AbortController().signal;
const consent = { allowVerifierCode: true };
const env = { TYPESAFE_API_KEY: "offline-test-key" };
const fixes: Record<string, Record<string, string>> = {
  "cart-quantity": {
    "cart.cjs": "exports.cartTotal = lines => lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0);\n",
  },
  "retry-boundary-regression": {
    "retry.cjs": "exports.canRetry = (attempt, maxAttempts) => attempt < maxAttempts;\n",
    "retry.test.cjs": "module.exports = (assert, canRetry) => {\n  assert.equal(canRetry(2,3), true);\n  assert.equal(canRetry(3,3), false);\n  assert.equal(canRetry(0,0), false);\n};\n",
  },
  "discounted-shipping": {
    "src/checkout.cjs": "const {subtotal} = require('./lines.cjs');\nconst {discounted} = require('./discount.cjs');\nconst {shipping} = require('./shipping.cjs');\nexports.checkout = (lines, percentOff = 0) => {\n  const net = discounted(subtotal(lines), percentOff);\n  return net + shipping(net);\n};\n",
    "src/shipping.cjs": "exports.shipping = merchandiseCents => merchandiseCents >= 5000 ? 0 : 500;\n",
  },
};

async function example() {
  return codingBenchmarkSchema.parse(JSON.parse(await readFile(new URL("../examples/coding-benchmark.json", import.meta.url), "utf8")));
}

async function projectWithJev(t: TestContext, outage = false, delegate = false) {
  const project = await fixture(t);
  const url = await server(t, (request, response) => {
    if (outage) { response.writeHead(503); response.end(); return; }
    void requestBody(request).then((body) => {
      const questions = body.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
      response.end(JSON.stringify({
        model: "jev-test",
        answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
          const choice = delegate ? "specialist_flow-investigator" : "direct";
          return [id, question.type === "choice" ? {
            type: "choice", choice, confidence: 1,
            probabilities: Object.fromEntries(Object.keys(question.criteria!).map((name) => [name, name === choice ? 1 : 0])),
          } : { type: "noul", noul: 1 }];
        })),
        usage: { input_tokens: 2, output_tokens: 1 },
      }));
    });
  });
  Object.assign(project.config.jev, { allowDataSharing: true, endpoint: url });
  return project;
}

function editingModel(suite: Awaited<ReturnType<typeof example>>,
  replacements = fixes, inspectTools = true): CodingModel {
  return {
    async complete(messages, tools) {
      if (inspectTools) {
        assert.ok(tools.some((tool) => tool.function.name === "write_file"));
        assert.ok(tools.some((tool) => tool.function.name === "replace_text"));
        assert.ok(!tools.some((tool) => ["run_command", "execute_shell", "create_skill", "delegate_task"].includes(tool.function.name)));
      }
      const prompt = messages.find((message) => message.role === "user")!.content!;
      const task = suite.tasks.find((task) => prompt.startsWith(task.task))!;
      const changes = Object.entries(replacements[task.id]!);
      const returned = messages.filter((message) => message.role === "tool");
      const change = changes[Math.floor(returned.length / 2)];
      if (!change) return final("Done. Acceptance checks were not available to run.");
      const [filename, content] = change;
      if (returned.length % 2 === 0) return call("read_file", { path: filename });
      const read = JSON.parse(returned.at(-1)!.content!);
      assert.equal(read.sha256, digest(task.files[filename]!));
      return call("write_file", { path: filename, content, expectedHash: read.sha256 });
    },
  };
}

test("all public fixtures reproduce exact assertion failures and their fixes execute successfully offline", async () => {
  const suite = await example();
  const before = await preflightCodingBenchmark(suite, signal(), consent);
  assert.equal(before.valid, true, JSON.stringify(before));
  assert.equal(before.tasks.length, 3);
  for (const task of suite.tasks) {
    const after = await verifyCodingFixture({ ...task.files, ...fixes[task.id] }, task.checks,
      { ...suite.verifier, allowVerifierCode: true }, signal());
    assert.equal(after.status, "passed", JSON.stringify(after));
    assert.equal(after.checks.length, task.checks.length);
  }
});

test("paired coding trials really edit fresh trees with identical policy, deterministic order and unknown prices", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.repetitions = 2;
  await writeFile(path.join(project.workspace.root, "workspace-secret.txt"), "must-not-be-copied");
  const original = await readdir(project.workspace.root);
  const options = { ...consent, env, model: editingModel(suite) };
  const report = await benchmarkCode(project, suite, signal(), options);
  assert.equal(report.validComparison, true, JSON.stringify(report));
  assert.equal(report.trials.length, 12);
  assert.equal(report.baseline.accepted, 6, JSON.stringify(report.trials));
  assert.equal(report.jev.accepted, 6, JSON.stringify(report.trials));
  assert.equal(report.paired.bothPassed, 6);
  assert.equal(report.paired.incomplete, 0);
  assert.equal(report.baseline.costUsd, null);
  assert.equal(report.jev.costPerAcceptedTaskUsd, null);
  assert.equal(report.policy.workspaceFilesCopied, false);
  assert.deepEqual(report.policy.permissions, { write: true, commands: false, execution: false, external: false });
  assert.equal(report.policy.verifier.sandboxed, false);
  assert.ok(report.trials.every((trial) => trial.initialTreeHash !== trial.finalTreeHash &&
    trial.machineMs === trial.wallMs - trial.approvalWaitMs && trial.verifier?.status === "passed"));
  assert.ok(report.trials.filter((trial) => trial.variant === "baseline").every((trial) => trial.routingRequests === 0));
  assert.ok(report.trials.filter((trial) => trial.variant === "jev").every((trial) =>
    trial.routingRequests === 1 && trial.route!.skillIds.includes("money-flow")));
  assert.ok(report.trials.every((trial) => trial.changedPaths.length === suite.tasks.find((task) => task.id === trial.taskId)!.requiredChangedPaths.length));
  assert.deepEqual(await readdir(project.workspace.root), original);
  assert.equal(await readFile(path.join(project.workspace.root, "workspace-secret.txt"), "utf8"), "must-not-be-copied");
  const rerun = await benchmarkCode(project, suite, signal(), options);
  assert.deepEqual(report.trials.map((trial) => [trial.taskId, trial.repetition, trial.variant]),
    rerun.trials.map((trial) => [trial.taskId, trial.repetition, trial.variant]));
  assert.equal(rerun.baseline.accepted, 6);
  assert.equal(rerun.jev.accepted, 6);
});

test("confident answers, wrong patches, broken syntax, and empty generated tests never count as coding success", async (t) => {
  const project = await projectWithJev(t);
  for (const kind of ["answer-only", "wrong-code", "syntax-error", "empty-tests"] as const) {
    await t.test(kind, async () => {
      const suite = await example();
      suite.repetitions = 1;
      suite.tasks = suite.tasks.filter((task) => task.id === (kind === "empty-tests" ? "retry-boundary-regression" : "cart-quantity"));
      const replacements = structuredClone(fixes);
      if (kind === "wrong-code") replacements["cart-quantity"]!["cart.cjs"] = "exports.cartTotal = () => 535;\n";
      if (kind === "syntax-error") replacements["cart-quantity"]!["cart.cjs"] = "module.exports = ;\n";
      if (kind === "empty-tests") replacements["retry-boundary-regression"]!["retry.test.cjs"] = "module.exports = () => {};\n";
      const model = kind === "answer-only" ? { complete: async () => final("All tests passed! Fixed everything.") } : editingModel(suite, replacements);
      const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model });
      assert.equal(report.baseline.accepted, 0);
      assert.equal(report.jev.accepted, 0);
      assert.ok(report.trials.every((trial) => !trial.acceptancePassed));
      assert.ok(report.trials.every((trial) => trial.status === "completed"));
      assert.ok(report.trials.every((trial) => trial.verifier?.status !== "passed"));
    });
  }
});

test("suite-owned skills load when the OS temporary directory has a symlink ancestor", {
  skip: process.platform === "win32",
}, async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "jev-temp-alias-test-"));
  const alias = path.join(root, "alias");
  const previous = process.env.TMPDIR;
  try {
    await symlink(root, alias, "dir");
    process.env.TMPDIR = alias;
    assert.notEqual(tmpdir(), await realpath(tmpdir()));
    const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: editingModel(suite) });
    assert.equal(report.validComparison, true, JSON.stringify(report.trials));
    assert.equal(report.baseline.accepted, 1, JSON.stringify(report.trials));
    assert.equal(report.jev.accepted, 1, JSON.stringify(report.trials));
    assert.deepEqual(await readdir(root), ["alias"]);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("exact fixture permissions block forbidden writes, test replacement, secrets, and capability persistence", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  for (const target of ["NOTES.txt", "../acceptance.cjs", "acceptance.cjs", ".jev/skills/boundary-tests.md", ".env"]) {
    await t.test(target, async () => {
      const existing = suite.tasks[0]!.files[target];
      const report = await benchmarkCode(project, suite, signal(), {
        ...consent, env,
        model: { complete: async () => call("write_file", { path: target, content: "all tests passed", expectedHash: existing ? digest(existing) : null }) },
      });
      assert.ok(report.trials.every((trial) => trial.status === "blocked" && !trial.acceptancePassed));
      assert.ok(report.trials.every((trial) => trial.changedPaths.length === 0));
    });
  }
  const inaccessible = await benchmarkCode(project, suite, signal(), { ...consent, env,
    model: { complete: async (messages) => messages.at(-1)?.role === "user" ?
      call("read_file", { path: "workspace-secret.txt" }) : final("Missing file observed") },
  });
  assert.ok(inaccessible.trials.every((trial) => trial.errors.some((error) => error.event === "tool_error")));
  suite.dynamicCapabilities = "identical";
  const creation = await benchmarkCode(project, suite, signal(), { ...consent, env,
    model: { complete: async () => call("create_skill", { id: "cheat", description: "cheat", instructions: "cheat" }) },
  });
  assert.ok(creation.trials.every((trial) => trial.status === "blocked" && !trial.acceptancePassed));
});

test("identical dynamic capability policy exposes only suite-owned catalogs to both arms", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  suite.dynamicCapabilities = "identical";
  const toolsSeen: string[][] = [];
  const editor = editingModel(suite, fixes, false);
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: {
    async complete(messages, tools, model, abort, onText) {
      const results = messages.filter((message) => message.role === "tool");
      if (!results.length) {
        toolsSeen.push(tools.map((tool) => tool.function.name).sort());
        return call("list_capabilities", {});
      }
      if (results.length === 1) {
        const catalog = JSON.parse(results[0]!.content!);
        assert.deepEqual(catalog.skills.map((skill: { id: string }) => skill.id), suite.capabilities.skills.map((skill) => skill.id));
        assert.deepEqual(catalog.specialists.map((specialist: { id: string }) => specialist.id),
          suite.capabilities.specialists.map((specialist) => specialist.id));
        return call("load_skill", { skillId: "money-flow" });
      }
      return editor.complete(messages.filter((message) => message !== results[0] && message !== results[1]), tools, model, abort, onText);
    },
  } });
  assert.equal(report.validComparison, true);
  assert.equal(report.baseline.accepted, 1);
  assert.equal(report.jev.accepted, 1);
  assert.deepEqual(toolsSeen[0], toolsSeen[1]);
  assert.equal(report.policy.backgroundSpecialists, false);
});

test("full-tree integrity catches out-of-band excluded-file tampering even with a correct patch and cleans trial roots", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  const marker = randomUUID();
  suite.tasks[0]!.files["test-owner-marker.txt"] = marker;
  const roots = new Set<string>();
  const editor = editingModel(suite);
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: {
    async complete(messages, tools, model, abort, onText) {
      if (!messages.some((message) => message.role === "tool")) {
        // Simulate an external writer, not an agent tool permission. Match only this test's exact marker.
        for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("jev-code-benchmark-")) continue;
          const root = path.join(tmpdir(), entry.name);
          if (!(await readdir(root)).includes("test-owner-marker.txt")) continue;
          if (await readFile(path.join(root, "test-owner-marker.txt"), "utf8") !== marker) continue;
          roots.add(root);
          await writeFile(path.join(root, ".jev/skills/money-flow.md"), "tampered");
        }
      }
      return editor.complete(messages, tools, model, abort, onText);
    },
  } });
  assert.equal(roots.size, 2);
  assert.equal(report.validComparison, false);
  assert.ok(report.trials.every((trial) => !trial.integrityPassed));
  assert.ok(report.trials.every((trial) => trial.verifier?.status === "passed" && !trial.acceptancePassed));
  assert.ok(report.trials.every((trial) => trial.failureReasons.includes("Changed forbidden path: .jev/skills/money-flow.md")));
  for (const root of roots) await assert.rejects(readdir(root), /ENOENT/);
});

test("delegation arm executes suite-owned specialists on the same model and shared budgets", async (t) => {
  const project = await projectWithJev(t, false, true);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  suite.feature = "delegation";
  const editor = editingModel(suite);
  const models = new Set<string>();
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: {
    async complete(messages, tools, model, abort, onText) {
      models.add(model);
      if (!tools.some((tool) => tool.function.name === "write_file")) {
        return messages.some((message) => message.role === "tool") ? final("Quantity is not multiplied in cart.cjs.") :
          call("read_file", { path: "cart.cjs" });
      }
      return editor.complete(messages, tools, model, abort, onText);
    },
  } });
  assert.equal(report.validComparison, true);
  assert.equal(report.jev.accepted, 1);
  assert.equal(report.baseline.accepted, 1);
  assert.deepEqual([...models], [project.config.llm.model]);
  assert.equal(report.trials.find((trial) => trial.variant === "baseline")!.route!.specialistId, null);
  const delegated = report.trials.find((trial) => trial.variant === "jev")!;
  assert.equal(delegated.route!.specialistId, "flow-investigator");
  assert.equal(delegated.metrics!.turns, 5);
  assert.equal(report.trials.find((trial) => trial.variant === "baseline")!.metrics!.turns, 3);
});

test("a passing patch after budget exhaustion is not accepted as a completed coding trial", async (t) => {
  const project = await projectWithJev(t);
  project.config.limits.maxTurns = 2;
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: editingModel(suite) });
  assert.ok(report.trials.every((trial) => trial.status === "limited" && !trial.acceptancePassed && trial.verifier?.status === "passed"));
});

test("replace_text is approved only for exact declared fixture paths", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.tasks = [suite.tasks[0]!];
  suite.repetitions = 1;
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: {
    async complete(messages) {
      const tools = messages.filter((message) => message.role === "tool");
      if (!tools.length) return call("read_file", { path: "cart.cjs" });
      if (tools.length === 1) return call("replace_text", { path: "cart.cjs",
        oldText: "total + line.unitPriceCents", newText: "total + line.unitPriceCents * line.quantity",
        expectedHash: JSON.parse(tools[0]!.content!).sha256 });
      return final();
    },
  } });
  assert.equal(report.baseline.accepted, 1);
  assert.equal(report.jev.accepted, 1);
});

test("invalid initial fixtures and vacuous check stubs never invoke a coding model", async (t) => {
  const project = await projectWithJev(t);
  for (const code of [
    "console.log('tests passed');",
    "require('./missing.cjs');",
    "const = ;",
    "while (true) {}",
  ]) {
    const suite = await example();
    suite.repetitions = 1;
    suite.tasks = [suite.tasks[0]!];
    suite.tasks[0]!.checks = [{ id: "failure", code }];
    suite.tasks[0]!.expectedInitialFailures = ["failure"];
    suite.verifier.timeoutMs = 200;
    let requests = 0;
    const report = await benchmarkCode(project, suite, signal(), { ...consent, env,
      model: { complete: async () => { requests++; return final(); } } });
    assert.equal(requests, 0);
    assert.equal(report.validComparison, false);
    assert.equal(report.preflight[0]!.valid, false);
    assert.equal(report.trials.length, 0);
    assert.equal(report.paired.incomplete, 1);
  }
});

test("Jev outages preserve actual coding acceptance but invalidate routing comparison and usage completeness", async (t) => {
  const project = await projectWithJev(t, true);
  const suite = await example();
  suite.repetitions = 1;
  suite.tasks = [suite.tasks[0]!];
  const report = await benchmarkCode(project, suite, signal(), { ...consent, env, model: editingModel(suite) });
  assert.equal(report.validComparison, false);
  assert.equal(report.jev.accepted, 1);
  assert.equal(report.jev.incompleteUsageTrials, 1);
  assert.equal(report.jev.costUsd, null);
  assert.equal(report.trials.find((trial) => trial.variant === "jev")!.fallbacks, 1);
  assert.ok(report.trials.find((trial) => trial.variant === "jev")!.errors.some((error) => error.event === "jev_error"));
});

test("consent and schema validation precede executable code; no real credentials are needed for preflight", async (t) => {
  const suite = await example();
  const project = await fixture(t);
  await assert.rejects(preflightCodingBenchmark(suite, signal()), /explicitly consent/);
  await assert.rejects(benchmarkCode(project, suite, signal()), /explicitly consent/);
  await assert.rejects(benchmarkCode(project, suite, signal(), consent), /data-sharing consent/);
  const invalid = structuredClone(suite);
  invalid.tasks[0]!.writablePaths.push("../outside.cjs");
  assert.equal(codingBenchmarkSchema.safeParse(invalid).success, false);
  invalid.tasks[0]!.writablePaths = ["cart.cjs"];
  invalid.tasks[0]!.files["CART.cjs"] = "collision";
  assert.equal(codingBenchmarkSchema.safeParse(invalid).success, false);
  assert.equal((await preflightCodingBenchmark(suite, signal(), consent)).valid, true);
});

test("controlled verifier rejects crashes, zero exit without check evidence, imports and output abuse; cancellation is bounded", async () => {
  const limits = { timeoutMs: 500, maxOutputBytes: 1024, allowVerifierCode: true as const };
  const checks = [{ id: "answer", code: "const assert = require('node:assert/strict'); assert.equal(require('./answer.cjs'), 42);" }];
  for (const [code, expected] of [
    ["module.exports = 42;", "passed"],
    ["module.exports = 41;", "failed"],
    ["module.exports = ;", "error"],
    ["require('node:fs');", "error"],
    // Demonstrates why VM restrictions are not a sandbox. A zero process exit is not a passing oracle.
    ["module.constructor.constructor('return process')().exit(0);", "error"],
    ["while(true) {}", "timeout"],
    ["console.log('x'.repeat(2000)); module.exports = 42;", "output_limit"],
  ] as const) {
    const result = await verifyCodingFixture({ "answer.cjs": code }, checks, limits, signal());
    assert.equal(result.status, expected, JSON.stringify(result));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    const result = await verifyCodingFixture({ "answer.cjs": "while(true) {}" }, checks,
      { ...limits, timeoutMs: 10_000 }, controller.signal);
    assert.equal(result.status, "cancelled");
    assert.ok(result.durationMs < 3000);
  } finally { clearTimeout(timer); }
});

test("cancelled coding trials and model outages are not accepted and leave partial reports", async (t) => {
  const project = await projectWithJev(t);
  const suite = await example();
  suite.repetitions = 1;
  suite.tasks = [suite.tasks[0]!];
  const controller = new AbortController();
  const cancelled = await benchmarkCode(project, suite, controller.signal, { ...consent, env, model: {
    async complete() { controller.abort(new Error("test cancellation")); return final(); },
  } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.validComparison, false);
  assert.equal(cancelled.trials.length, 1);
  assert.equal(cancelled.trials[0]!.acceptancePassed, false);
  assert.equal(cancelled.paired.incomplete, 1);
  const outage = await benchmarkCode(project, suite, signal(), { ...consent, env, model: {
    async complete() { throw new Error("test provider outage"); },
  } });
  assert.equal(outage.validComparison, false);
  assert.ok(outage.trials.every((trial) => trial.status === "failed" && !trial.acceptancePassed));
  assert.equal(outage.baseline.incompleteUsageTrials, 1);
});
