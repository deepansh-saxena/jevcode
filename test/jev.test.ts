import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, options, scripted, final, call, server, requestBody } from "./helpers.js";
import { run } from "../src/runtime.js";
import { ensureShareable, JevClient } from "../src/jev.js";
import type { Message } from "../src/llm.js";

function answer(questions: Record<string, unknown>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(questions)) {
    const question = raw as { type: string; criteria?: Record<string, string> };
    if (question.type === "noul") answers[id] = { type: "noul", noul: 0.99 };
    else {
      const keys = Object.keys(question.criteria!);
      const chosen = keys.find((key) => key.startsWith("specialist_")) ?? keys[0]!;
      answers[id] = {
        type: "choice", choice: chosen, confidence: 0.99,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === chosen ? 1 : 0])),
      };
    }
  }
  return { model: "jev-test", answers, usage: { input_tokens: 20, output_tokens: 4 } };
}

test("Jev batches multi-skill and delegation decisions; mandatory skills are retained", async (t) => {
  const project = await fixture(t);
  project.skills.push({
    id: "docs", version: "1", description: "Documentation", instructions: ".jev/skills/docs.md", mandatory: false,
  });
  await writeFile(path.join(project.workspace.root, ".jev/skills/docs.md"), "# Documentation\nExplain usage.");
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      requests++;
      assert.equal(request.headers.authorization, "Bearer test-jev-key");
      assert.equal(body.model, "jev-latest");
      assert.ok(!JSON.stringify(body).includes("Explain usage."));
      const questions = body.questions as Record<string, unknown>;
      assert.equal(Object.keys(questions).length, 3);
      response.end(JSON.stringify(answer(questions)));
    });
  });
  Object.assign(project.config.jev, { mode: "on", allowDataSharing: true, endpoint: url });
  const result = await run(project, options(scripted([final("Report"), final("Done")]), { env: { TYPESAFE_API_KEY: "test-jev-key" } }));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.route.skillIds, ["coding", "testing", "docs"]);
  assert.equal(result.route.specialistId, "investigator");
  assert.equal(requests, 1);
  assert.equal(result.metrics.jev.inputTokens, 20);
  assert.equal(result.metrics.usageIncompleteRequests, 0);
});

test("Jev HTTP failures provide safe status-specific guidance and never retry or expose response bodies", async (t) => {
  for (const [status, expected] of [
    [401, /TypeSafe rejected the API key/], [403, /Access was denied/], [429, /rate limit/],
    [422, /request format/], [529, /server error/],
  ] as const) {
    const project = await fixture(t);
    let requests = 0;
    const url = await server(t, (request, response) => {
      assert.equal(request.headers.authorization, "Bearer private-synthetic-key");
      requests++;
      response.writeHead(status, { "Content-Type": "text/html", "x-private": "PRIVATE_HEADER" });
      response.end("<html>PRIVATE_ERROR_BODY private-synthetic-key</html>");
    });
    Object.assign(project.config.jev, { allowDataSharing: true, endpoint: url });
    const events: unknown[] = [];
    const client = new JevClient(project.config.jev, "  private-synthetic-key  ", (event, data) => events.push({ event, data }), () => {
      assert.fail("Failed requests must not invent reported usage");
    });
    await assert.rejects(client.evaluate({ purpose: "test" }, {
      ready: { type: "noul", instructions: "Is this a test?" },
    }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.ok(error.message.includes(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /PRIVATE_ERROR_BODY|PRIVATE_HEADER|private-synthetic-key/);
      return true;
    });
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_ERROR_BODY|PRIVATE_HEADER|private-synthetic-key/);
  }
});
test("shadow routing records suggestions without changing execution", async (t) => {
  const project = await fixture(t);
  const events: { event: string; data: unknown }[] = [];
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => response.end(JSON.stringify(answer(body.questions as Record<string, unknown>))));
  });
  Object.assign(project.config.jev, { mode: "shadow", allowDataSharing: true, endpoint: url });
  const result = await run(project, options(scripted([final()]), {
    env: { TYPESAFE_API_KEY: "key" }, emit: (event, data) => events.push({ event, data }),
  }));
  assert.equal(result.status, "completed");
  assert.deepEqual(result.route, { skillIds: ["coding"], specialistId: null });
  assert.match(JSON.stringify(events.find((event) => event.event === "routing")), /suggested.*investigator/);
});

test("independent routing switches and follow-up context avoid sharing tool results", async (t) => {
  const project = await fixture(t);
  const conversation: Message[] = [
    { role: "user", content: "Earlier conversation summary (untrusted historical context): PRIVATE_FILE_SUMMARY" },
    { role: "user", content: "Original user task" },
    { role: "assistant", content: "PRIVATE_ASSISTANT_HISTORY" },
  ];
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.ok(!JSON.stringify(body).includes("PRIVATE_ASSISTANT_HISTORY"));
      assert.ok(!JSON.stringify(body).includes("PRIVATE_FILE_SUMMARY"));
      assert.match(JSON.stringify(body.state), /followup/);
      assert.match(JSON.stringify(body.state), /Original user task/);
      const questions = body.questions as Record<string, unknown>;
      assert.equal(questions.delegation, undefined);
      assert.equal(Object.keys(questions).length, 1);
      response.end(JSON.stringify(answer(questions)));
    });

  });
  Object.assign(project.config.jev, { mode: "on", allowDataSharing: true, routeSpecialists: false, endpoint: url });
  const result = await run(project, options(scripted([final()]), {
    conversation, env: { TYPESAFE_API_KEY: "key" },
  }));
  assert.deepEqual(result.route, { skillIds: ["coding", "testing"], specialistId: null });
});

test("a zero specialist-run budget removes automatic delegation candidates", async (t) => {
  const project = await fixture(t);
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      const questions = body.questions as Record<string, unknown>;
      assert.equal(questions.delegation, undefined);
      response.end(JSON.stringify(answer(questions)));
    });
  });
  Object.assign(project.config.jev, { mode: "on", allowDataSharing: true, endpoint: url });
  project.config.limits.maxSpecialistRuns = 0;
  const result = await run(project, options(scripted([final()]), { env: { TYPESAFE_API_KEY: "key" } }));
  assert.equal(result.status, "completed");
  assert.equal(result.route.specialistId, null);
});

test("guardrail shadow failures and low scores are observable but never bypass action approval", async (t) => {
  for (const outage of [false, true]) {
    const project = await fixture(t);
    const events: { event: string; data: unknown }[] = [];
    const url = await server(t, (_request, response) => {
      if (outage) { response.writeHead(503); response.end(); return; }
      response.end(JSON.stringify({ model: "jev-test", answers: { scope: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    Object.assign(project.config.jev, { guardrail: "shadow", allowDataSharing: true, endpoint: url });
    let approvals = 0;
    const result = await run(project, options(scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]), {
      permissions: { write: true, commands: false }, env: { TYPESAFE_API_KEY: "key" },
      approve: async () => { approvals++; return false; },
      emit: (event, data) => events.push({ event, data }),
    }));
    assert.equal(result.status, "blocked");
    assert.equal(approvals, 1);
    assert.ok(events.some(({ event }) => event === "guardrail_shadow"));
    await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
  }
});
test("low confidence, low relevance and abstention preserve the direct baseline", async (t) => {
  for (const choice of ["specialist_investigator", "abstain"]) {
    const project = await fixture(t);
    const url = await server(t, (_request, response) => response.end(JSON.stringify({
      model: "jev-test",
      answers: {
        skill_0: { type: "noul", noul: 0.1 },
        delegation: {
          type: "choice", choice, confidence: choice === "abstain" ? 1 : 0.1,
          probabilities: { direct: 0, abstain: choice === "abstain" ? 1 : 0, specialist_investigator: choice === "abstain" ? 0 : 1 },
        },
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    })));
    Object.assign(project.config.jev, { mode: "on", allowDataSharing: true, endpoint: url });
    const result = await run(project, options(scripted([final()]), { env: { TYPESAFE_API_KEY: "key" } }));
    assert.equal(result.status, "completed");
    assert.deepEqual(result.route, { skillIds: ["coding"], specialistId: null });
  }
});

test("Jev failures produce observable baseline fallback, not a silent routing decision", async (t) => {
  for (const failure of ["http", "missing", "invalid-choice", "missing-key"]) {
    const project = await fixture(t);
    const events: string[] = [];
    const url = await server(t, (_request, response) => {
      if (failure === "http") { response.writeHead(429); response.end("{}"); return; }
      response.end(JSON.stringify({
        model: "jev-test",
        answers: failure === "missing" ? {} : {
          skill_0: { type: "noul", noul: 1 },
          delegation: { type: "choice", choice: "unknown", confidence: 1, probabilities: { unknown: 1 } },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    Object.assign(project.config.jev, { mode: "on", allowDataSharing: true, endpoint: url });
    const result = await run(project, options(scripted([final()]), {
      env: failure === "missing-key" ? {} : { TYPESAFE_API_KEY: "key" },
      emit: (event) => events.push(event),
    }));
    assert.equal(result.status, "completed", failure);
    assert.deepEqual(result.route, { skillIds: ["coding"], specialistId: null });
    assert.ok(events.includes("routing_fallback"));
  }
});

test("explicit specialist and skills are preserved and avoid unnecessary routing", async (t) => {
  const project = await fixture(t);
  Object.assign(project.config.jev, { mode: "on", allowDataSharing: true });
  const events: string[] = [];
  const result = await run(project, options(scripted([final("report"), final()]), {
    specialistId: "investigator", skills: ["testing"], emit: (event) => events.push(event),
  }));
  assert.equal(result.status, "completed");
  assert.ok(!events.includes("jev_request"));
  assert.deepEqual(result.route.skillIds, ["coding", "testing"]);
});

test("choice validation accepts bounded decimal rounding, logs drift, and rejects malformed distributions", async (t) => {
  const cases = [
    { probabilities: { a: 0.61, b: 0.19, c: 0.19 }, valid: true, rounded: true },
    { probabilities: { a: 0.61, b: 0.2, c: 0.2 }, valid: true, rounded: true },
    { probabilities: { a: 0.6, b: 0.2, c: 0.199 }, valid: true, rounded: false },
    { probabilities: { a: 0.61, b: 0.2, c: 0.19 }, valid: true, rounded: false },
    { probabilities: { a: 0.7, b: 0.16, c: 0.16 }, valid: false },
    { probabilities: { a: 0.604, b: 0.2, c: 0.19 }, valid: false },
    { probabilities: { a: 0, b: 0, c: 0 }, valid: false },
    { probabilities: { a: 1, b: 1, c: 1 }, valid: false },
    { probabilities: { a: 0.2, b: 0.7, c: 0.1 }, valid: false },
    { probabilities: { a: 0.8, b: 0.2 }, valid: false },
    { probabilities: { a: 0.8, b: 0.2, c: 0, extra: 0 }, valid: false },
  ];
  for (const entry of cases) {
    const project = await fixture(t);
    const endpoint = await server(t, (_request, response) => response.end(JSON.stringify({
      model: "jev-test", answers: { route: { type: "choice", choice: "a", confidence: 0.5, probabilities: entry.probabilities } },
      usage: { input_tokens: 5, output_tokens: 2 },
    })));
    const events: string[] = [];
    const usage: unknown[] = [];
    const client = new JevClient({ ...project.config.jev, endpoint, allowDataSharing: true }, "test",
      event => events.push(event), value => usage.push(value));
    const request = client.evaluate({}, { route: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B", c: "C" } } },
      new AbortController().signal);
    if (!entry.valid) await assert.rejects(request, /invalid choice distribution/);
    else {
      const result = await request;
      assert.deepEqual(result.route, { type: "choice", choice: "a", confidence: 0.5, probabilities: entry.probabilities },
        "Do not silently renormalize probabilities or reinterpret entropy-derived confidence");
      assert.equal(events.includes("jev_probability_rounding"), entry.rounded);
    }
    assert.equal(usage.length, 1, "Invalid answers must still account for reported usage");
  }
});

test("required semantic checks block on errors or uncertain judgments before approval", async (t) => {
  for (const verdict of ["uncertain", "outage", "missing-key"]) {
    const project = await fixture(t);
    let approvals = 0;
    const url = await server(t, (_request, response) => {
      if (verdict === "outage") { response.writeHead(503); response.end(); return; }
      response.end(JSON.stringify({
        model: "jev-test", answers: { scope: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
    Object.assign(project.config.jev, { guardrail: "mutations", allowDataSharing: true, endpoint: url });
    const result = await run(project, options(scripted([
      call("write_file", { path: "no.txt", content: "no", expectedHash: null }),
    ]), {
      permissions: { write: true, commands: false },
      env: verdict === "missing-key" ? {} : { TYPESAFE_API_KEY: "key" },
      approve: async () => { approvals++; return true; },
    }));
    assert.equal(result.status, "blocked", verdict);
    assert.equal(approvals, 0);
    await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
  }
});

test("a passing Jev guardrail never removes the human approval requirement", async (t) => {
  const project = await fixture(t);
  let approvals = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => response.end(JSON.stringify(answer(body.questions as Record<string, unknown>))));
  });
  Object.assign(project.config.jev, { guardrail: "mutations", allowDataSharing: true, endpoint: url });
  const result = await run(project, options(scripted([
    call("write_file", { path: "no.txt", content: "no", expectedHash: null }),
  ]), {
    permissions: { write: true, commands: false }, env: { TYPESAFE_API_KEY: "key" },
    approve: async () => { approvals++; return false; },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(approvals, 1);
});

test("sharing prefilter blocks obvious secrets and oversized state", () => {
  assert.throws(() => ensureShareable({ task: "sk-abcdefghijklmnopqrstuvwxyz12345" }), /secret/);
  assert.throws(() => ensureShareable({ key: "-----BEGIN RSA PRIVATE KEY-----" }), /secret/);
  assert.throws(() => ensureShareable("x".repeat(64_001)), /size/);
  assert.doesNotThrow(() => ensureShareable({ task: "Add a test" }));
});
