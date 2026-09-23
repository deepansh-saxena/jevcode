import test from "node:test";
import assert from "node:assert/strict";
import { configSchema } from "../src/config.js";
import { RunBudget } from "../src/budget.js";
import { run } from "../src/runtime.js";
import { fixture, options, scripted, final, call, server, requestBody } from "./helpers.js";

const config = () => configSchema.parse({ version: 1, llm: { model: "test" },
  limits: { maxTurns: 6, maxTokens: 1000 }, spend: { models: { "openai-compatible/test": {
    inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  } } } });

test("parallel scopes deterministically partition tokens and turns without multiplying ceilings", () => {
  const budget = new RunBudget(config());
  const [a, b] = budget.allocate([5, 5]);
  const main = budget.reserve("llm", "test", 100, 200);
  const first = a!.reserve("llm", "test", 100, 200);
  const second = b!.reserve("llm", "test", 100, 200);
  for (const scope of [budget, a!, b!]) assert.throws(() => scope.reserve("llm", "test", 40, 1), /token/);
  second.settle({ inputTokens: 100, outputTokens: 200 });
  main.settle({ inputTokens: 100, outputTokens: 200 });
  first.settle({ inputTokens: 100, outputTokens: 200 });
  a!.release(); b!.release();
  assert.equal(budget.turns, 3);
  assert.throws(() => budget.reserve("llm", "test", 101, 1), /token/);
  assert.doesNotThrow(() => budget.reserve("llm", "test", 50, 50).settle({ inputTokens: 50, outputTokens: 50 }));
});

test("scope release refunds unused capacity once, but never while requests remain in flight", () => {
  const budget = new RunBudget(config());
  const [child] = budget.allocate([2]);
  const request = child!.reserve("llm", "test", 200, 200);
  assert.throws(() => child!.release(), /in flight/);
  request.settle({ inputTokens: 10, outputTokens: 10 });
  child!.release(); child!.release();
  const remaining = budget.reserve("llm", "test", 500, 480);
  remaining.settle({ inputTokens: 500, outputTokens: 480 });
  assert.throws(() => child!.reserve("llm", "test", 1, 1), /closed/);
});

test("unknown usage retains its allowance and makes aggregate cost unknown", () => {
  const budget = new RunBudget(config());
  const request = budget.reserve("llm", "test", 200, 200);
  request.fail(); request.fail();
  assert.equal(budget.costUsd, null);
  assert.throws(() => budget.reserve("llm", "test", 601, 1), /token/);
  budget.reserve("llm", "test", 300, 300).settle({ inputTokens: 300, outputTokens: 300 });
  assert.equal(budget.costUsd, null);
  assert.ok(Math.abs(budget.reportedCostUsd - 0.0009) < 1e-12);
});

test("reported costs require explicit provider/model rates; missing prices stay unknown or block capped calls", () => {
  const uncapped = config();
  uncapped.spend.models = {};
  const budget = new RunBudget(uncapped);
  budget.reserve("llm", "test", 100, 100).settle({ inputTokens: 10, outputTokens: 20 });
  assert.equal(budget.costUsd, null);
  uncapped.spend.maxUsd = 1;
  const capped = new RunBudget(uncapped);
  assert.throws(() => capped.reserve("llm", "test", 1, 1), /price is unknown/);
  assert.throws(() => capped.reserve("jev", "jev-latest", 1, 1), /price is unknown/);
});

test("monetary reservations are shared, refund unused output, and reject excess concurrent admission", () => {
  const settings = config();
  settings.spend.maxUsd = 0.0006;
  const budget = new RunBudget(settings);
  const one = budget.reserve("llm", "test", 100, 200);
  assert.throws(() => budget.reserve("llm", "test", 100, 100), /spend cap/);
  one.settle({ inputTokens: 10, outputTokens: 20 });
  budget.reserve("llm", "test", 100, 200).settle({ inputTokens: 100, outputTokens: 200 });
  assert.ok(Math.abs(budget.costUsd! - 0.00055) < 1e-12);
});

test("turns are globally reserved, provider overshoot is explicit, and usage cannot be settled twice", () => {
  const settings = config();
  settings.limits.maxTurns = 1;
  const budget = new RunBudget(settings);
  const first = budget.reserve("llm", "test", 10, 10);
  assert.throws(() => budget.reserve("llm", "test", 1, 1), /turn budget/);
  assert.throws(() => first.settle({ inputTokens: 10, outputTokens: 11 }), /overshoot/);
  assert.throws(() => first.settle({ inputTokens: 1, outputTokens: 1 }), /already settled/);
  assert.equal(budget.turns, 1);
});

test("runtime known spend uses reported tokens only and a hard cap blocks unknown model prices before sending", async (t) => {
  const project = await fixture(t);
  const key = `${project.config.llm.provider}/${project.config.llm.model}`;
  project.config.spend.models[key] = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  const result = await run(project, options(scripted([final()])));
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.costUsd, 0.00002);
  delete project.config.spend.models[key];
  project.config.spend.maxUsd = 1;
  const capped = await run(project, options({ async complete() { assert.fail("Unpriced model request must not be sent"); } }));
  assert.equal(capped.status, "limited");
  assert.match(capped.text, /price is unknown/);
  assert.equal(capped.metrics.turns, 0);
});

test("Jev and coding costs use separate explicit rates and share the same cap", async (t) => {
  const endpoint = await server(t, async (request, response) => {
    const body = await requestBody(request);
    response.end(JSON.stringify({ model: "jev-latest", answers: Object.fromEntries(
      Object.keys(body.questions as Record<string, unknown>).map((key) => [key, { type: "noul", noul: 1 }])
    ), usage: { input_tokens: 20, output_tokens: 2 } }));
  });
  const project = await fixture(t);
  project.config.jev = { ...project.config.jev, mode: "off", guardrail: "all", allowDataSharing: true, endpoint };
  project.config.spend.maxUsd = 10;
  project.config.spend.models[`${project.config.llm.provider}/${project.config.llm.model}`] = {
    inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  };
  project.config.spend.jev = { inputUsdPerMillion: 2, outputUsdPerMillion: 3 };
  const result = await run(project, options(scripted([call("list_files", {}), final()]), { env: { TYPESAFE_API_KEY: "test-key" } }));
  assert.equal(result.status, "completed", result.text);
  assert.ok(Math.abs(result.metrics.costUsd! - 0.000086) < 1e-12);
  delete project.config.spend.jev;
  const blocked = await run(project, options(scripted([call("list_files", {})]), { env: { TYPESAFE_API_KEY: "test-key" } }));
  assert.equal(blocked.status, "limited");
  assert.match(blocked.text, /Jev.*price is unknown/);
});

test("pre-run work can share one explicit budget with runtime without resetting turn or spend ceilings", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxTurns = 1;
  const budget = new RunBudget(project.config);
  budget.reserve("llm", project.config.llm.model, 100, 100).settle({ inputTokens: 10, outputTokens: 10 });
  const result = await run(project, options({ async complete() { assert.fail("compaction already consumed the sole shared turn"); } }, { budget }));
  assert.equal(result.status, "limited");
  assert.match(result.text, /turn budget/);
});

test("invalid reservation bounds cannot increase shared allowances", () => {
  const budget = new RunBudget(config());
  for (const values of [[-10, 20], [1.5, 10], [Infinity, 1], [NaN, 1]]) {
    assert.throws(() => budget.reserve("llm", "test", values[0]!, values[1]!), /integer token bounds/);
  }
  for (const limits of [[], [-1], [0], [1.5]]) assert.throws(() => budget.allocate(limits), /integer turn limits/);
  budget.reserve("llm", "test", 500, 500).settle({ inputTokens: 500, outputTokens: 500 });
  assert.throws(() => budget.reserve("llm", "test", 1, 1), /token budget/);
});

test("a supplied budget cannot silently bypass the run's configured limits or rates", async (t) => {
  const project = await fixture(t);
  const budget = new RunBudget(project.config);
  project.config.limits.maxTurns = 1;
  const result = await run(project, options({ async complete() { assert.fail("Mismatched budget must not run"); } }, { budget }));
  assert.equal(result.status, "limited");
  assert.match(result.text, /does not match/);
});
