import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, scripted, options, call, final } from "./helpers.js";
import { run } from "../src/runtime.js";
import { digest } from "../src/workspace.js";
import type { Message } from "../src/llm.js";

test("main agent reads files, receives mandatory skills, and records usage without content", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "file.txt"), "private source content");
  const events: unknown[] = [];
  let second: Message[] = [];
  const model = scripted([call("read_file", { path: "file.txt" }), final("Read it.")], (messages, tools, index) => {
    assert.match(messages[0]!.content!, /# Coding/);
    assert.ok(!tools.some((tool) => tool.function.name === "write_file"));
    if (index === 1) second = structuredClone(messages);
  });
  const result = await run(project, options(model, { emit: (event, data) => events.push({ event, data }) }));
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.toolCalls, 1);
  assert.deepEqual(result.metrics.llm, { inputTokens: 20, outputTokens: 10 });
  assert.equal(result.metrics.usageIncompleteRequests, 0);
  assert.equal(result.metrics.costUsd, null);
  assert.match(second.at(-1)!.content!, /private source content/);
  assert.ok(!JSON.stringify(events).includes("private source content"));
});

test("multi-file investigations continue within the original context limit and log only pruning metadata", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxContextChars = 24_000;
  const content = "CONTEXT_PRIVATE_CONTENT\n".repeat(600);
  for (const file of ["one.txt", "two.txt", "three.txt"]) {
    await writeFile(path.join(project.workspace.root, file), content);
  }
  const events: { event: string; data: Record<string, unknown> }[] = [];
  const model = scripted([
    call("read_file", { path: "one.txt", lineCount: 500 }),
    call("read_file", { path: "two.txt", lineCount: 500 }),
    call("read_file", { path: "three.txt", lineCount: 500 }),
    final("Architecture explained from the inspected files."),
  ], (messages, tools, index) => {
    assert.ok(JSON.stringify({ messages, tools }).length <= 24_000);
    assert.match(messages[0]!.content!, /# Coding/);
    if (index === 3) {
      const results = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content!));
      assert.equal(results.length, 3);
      assert.ok(results.some((result) => result.contextPruned === true));
      assert.ok(results.every((result) => result.sha256 === digest(content)));
      assert.equal(results.at(-1).contextPruned, undefined);
    }
  });
  const result = await run(project, options(model, { emit: (event, data) => events.push({ event, data: data ?? {} }) }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.metrics.turns, 4);
  assert.equal(result.metrics.toolCalls, 3);
  assert.ok(events.some(({ event }) => event === "context_pruned"));
  assert.ok(!JSON.stringify(events).includes("CONTEXT_PRIVATE_CONTENT"));
});

test("mutations require approval and fail closed when denied", async (t) => {
  const project = await fixture(t);
  let approvals = 0;
  const model = scripted([call("write_file", { path: "created.txt", content: "yes", expectedHash: null })]);
  const result = await run(project, options(model, {
    permissions: { write: true, commands: false },
    approve: async () => { approvals++; return false; },
  }));
  assert.equal(result.status, "blocked");
  assert.equal(approvals, 1);
  await assert.rejects(project.workspace.read("created.txt"), /ENOENT/);
});

test("approved exact action persists and stale hash errors return to the model", async (t) => {
  const project = await fixture(t);
  const model = scripted([
    call("write_file", { path: "created.txt", content: "yes", expectedHash: null }),
    call("replace_text", { path: "created.txt", oldText: "yes", newText: "no", expectedHash: digest("stale") }),
    final("Created the file; the stale edit was not applied."),
  ], (messages, _tools, index) => {
    if (index === 2) assert.match(messages.at(-1)!.content!, /expectedHash/);
  });
  const result = await run(project, options(model, {
    permissions: { write: true, commands: false }, approve: async () => true,
  }));
  assert.equal(result.status, "completed");
  assert.equal(await project.workspace.read("created.txt"), "yes");
});

test("specialists have isolated contexts, inherited skills, and intersected tools", async (t) => {
  const project = await fixture(t);
  const model = scripted([final("Evidence: file.ts has a bug."), final("Integrated findings.")], (messages, tools, index) => {
    if (index === 0) {
      assert.match(messages[0]!.content!, /Specialist role/);
      assert.match(messages[0]!.content!, /# Testing/);
      assert.ok(!tools.some((tool) => tool.function.name === "write_file"));
      assert.equal(messages.length, 2);
    } else {
      assert.doesNotMatch(messages[0]!.content!, /Specialist role/);
      assert.match(messages.at(-1)!.content!, /Evidence: file.ts/);
      assert.equal(messages.length, 3);
    }
  });
  const result = await run(project, options(model, {
    specialistId: "investigator", permissions: { write: true, commands: false },
  }));
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.turns, 2);
});

test("specialists cannot escalate permissions or spawn nested agents", async (t) => {
  for (const tool of ["write_file", "delegate"]) {
    const project = await fixture(t);
    const result = await run(project, options(scripted([call(tool, {})]), {
      specialistId: "investigator", permissions: { write: true, commands: true },
    }));
    assert.equal(result.status, "blocked");
    assert.match(result.text, /Unavailable tool/);
  }
});

test("specialist local limits return an explicit partial report to the main agent", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.maxTurns = 1;
  const model = scripted([call("list_files", {}), final("Continuing without complete specialist findings.")], (messages, _tools, index) => {
    if (index === 1) assert.match(messages.at(-1)!.content!, /limited/);
  });
  const result = await run(project, options(model, { specialistId: "investigator" }));
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.turns, 2);
});

test("shared turn, tool, token and context limits stop execution", async (t) => {
  for (const which of ["turn", "tool", "token", "context"]) {
    const project = await fixture(t);
    if (which === "turn") project.config.limits.maxTurns = 1;
    if (which === "tool") project.config.limits.maxToolCalls = 1;
    if (which === "token") project.config.limits.maxTokens = 1;
    if (which === "context") project.config.limits.maxContextChars = 1;
    const result = await run(project, options(scripted([call("list_files", {}), call("list_files", {}), final()])));
    assert.equal(result.status, "limited", which);
    if (which === "token" || which === "context") assert.equal(result.metrics.toolCalls, 0);
  }
});

test("model truncation never executes partial tool calls", async (t) => {
  const project = await fixture(t);
  const truncated = call("write_file", { path: "no.txt", content: "no", expectedHash: null });
  truncated.finishReason = "length";
  const result = await run(project, options(scripted([truncated]), {
    permissions: { write: true, commands: false }, approve: async () => true,
  }));
  assert.equal(result.status, "limited");
  assert.equal(result.metrics.toolCalls, 0);
});

test("cancellation and deadlines abort in-flight model calls", async (t) => {
  for (const kind of ["cancel", "deadline"]) {
    const project = await fixture(t);
    project.config.limits.maxDurationMs = 100;
    const controller = new AbortController();
    const result = await run(project, options({
      async complete(_messages, _tools, _model, signal) {
        if (kind === "cancel") controller.abort(new Error("User cancellation"));
        signal.throwIfAborted();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    }, { signal: controller.signal }));
    assert.equal(result.status, kind === "cancel" ? "cancelled" : "limited");
    assert.equal(result.metrics.usageIncompleteRequests, 1);
  }
});
