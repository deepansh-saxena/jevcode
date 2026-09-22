import test from "node:test";
import assert from "node:assert/strict";
import { compactConversation, contextSize, pruneContext, serializeToolResult } from "../src/context.js";
import type { Message } from "../src/llm.js";
import { fixture, scripted, final, call } from "./helpers.js";
import { digest } from "../src/workspace.js";

function exchange(name: string, result: unknown, id: string): Message[] {
  return [
    { role: "assistant", content: "Observed evidence.", tool_calls: [
      { id, type: "function", function: { name, arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: id, content: JSON.stringify(result) },
  ];
}

const model = scripted([]);
const instructions: Message[] = [
  { role: "system", content: "Mandatory instructions stay intact." },
  { role: "user", content: "Explain architecture; do not edit." },
];

test("tool result limits account for JSON escaping and preserve command failure metadata", () => {
  const small = { path: "file.ts", content: "Small output" };
  assert.equal(serializeToolResult(small), JSON.stringify(small));
  const large = { ok: false, exitCode: 1, signal: null, output: '"\\\n'.repeat(20_000) };
  const serialized = serializeToolResult(large, 2_000);
  assert.ok(serialized.length <= 2_000);
  const result = JSON.parse(serialized);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 1);
  assert.equal(result.signal, null);
  assert.equal(result.truncated, true);
  assert.ok(large.output.startsWith(result.output));
  assert.throws(() => serializeToolResult(undefined), /unserializable/);
});

test("pruning retains instructions, native message identities, file hashes, and the newest batch", () => {
  const content = "OLDER_PRIVATE_CONTENT\n".repeat(800);
  const read = { path: "old.ts", sha256: digest(content), totalLines: 800, truncated: false, content };
  const messages: Message[] = [
    ...instructions, ...exchange("read_file", read, "old"),
    ...exchange("read_file", { ...read, path: "new.ts", content: "Recent content" }, "new"),
  ];
  const before = structuredClone(messages);
  const identities = [...messages];
  const result = pruneContext(model, messages, [], 20_000);
  assert.equal(result.prunedResults, 1);
  assert.ok(result.afterChars < result.beforeChars);
  assert.ok(result.afterChars <= 10_000);
  assert.deepEqual(messages.slice(0, 2), instructions);
  assert.deepEqual(messages.slice(-2), before.slice(-2));
  messages.forEach((message, index) => assert.strictEqual(message, identities[index]));
  const shortened = JSON.parse(messages[3]!.content!);
  assert.equal(shortened.contextPruned, true);
  assert.equal(shortened.truncated, true);
  assert.equal(shortened.path, read.path);
  assert.equal(shortened.sha256, read.sha256);
  assert.equal(shortened.totalLines, 800);
  assert.ok(read.content.startsWith(shortened.content));
  assert.doesNotMatch(JSON.stringify(result), /OLDER_PRIVATE_CONTENT|old\.ts/);
  assert.equal(pruneContext(model, messages, [], 20_000).prunedResults, 0);
});

test("an oversized newest batch is reduced without removing call/result pairs", () => {
  const calls = ["one", "two", "three", "four"].map((id) => ({
    id, type: "function" as const, function: { name: "read_file", arguments: "{}" },
  }));
  const messages: Message[] = [
    ...instructions, { role: "assistant", content: null, tool_calls: calls },
    ...calls.map((call): Message => ({
      role: "tool", tool_call_id: call.id,
      content: JSON.stringify({ path: `${call.id}.ts`, content: '"\\\n'.repeat(2_000), truncated: false }),
    })),
  ];
  const newest = messages.at(-1)!.content;
  const result = pruneContext(model, messages, [], 45_000);
  assert.ok(result.prunedResults > 0);
  assert.ok(result.afterChars <= 45_000);
  assert.equal(result.afterChars, contextSize(model, messages, []));
  assert.deepEqual(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    calls.map((call) => call.id));
  assert.equal(messages.at(-1)!.content, newest);
});

test("mutations, command outcomes, errors, user tasks, and assistant text are never pruned", () => {
  const large = "Important outcome".repeat(1_000);
  const messages: Message[] = [
    ...instructions,
    ...exchange("write_file", { path: "written.ts", bytesWritten: 42 }, "write"),
    ...exchange("run_command", { ok: false, exitCode: 2, output: large }, "command"),
    ...exchange("read_file", { error: large }, "failed-read"),
    { role: "assistant", content: large },
  ];
  const before = structuredClone(messages);
  const result = pruneContext(model, messages, [], 10_000);
  assert.equal(result.prunedResults, 0);
  assert.ok(result.afterChars > 10_000);
  assert.deepEqual(messages, before);
});

test("listing and search pruning is marked explicitly and retains every error outcome", () => {
  for (const tool of ["list_files", "search_files"]) {
    const messages = [...instructions,
      ...exchange(tool, { results: "Old observations".repeat(1_000), truncated: false }, "old"),
      ...exchange(tool, { error: "Access denied" }, "new"),
    ];
    const result = pruneContext(model, messages, [], 15_000);
    assert.equal(result.prunedResults, 1);
    assert.equal(JSON.parse(messages[3]!.content!).contextPruned, true);
    assert.deepEqual(JSON.parse(messages.at(-1)!.content!), { error: "Access denied" });
  }
});

test("semantic compaction retains trusted instructions and latest task but never accepts tools or truncated summaries", async (t) => {
  const project = await fixture(t);
  const messages: Message[] = [...instructions, ...exchange("read_file", { content: "Observation ".repeat(3000) }, "read"),
    { role: "assistant", content: "The file was inspected. ".repeat(200) }];
  const before = structuredClone(messages);
  for (const response of [
    { ...final("Partial summary"), finishReason: "length" },
    call("write_file", { path: "no", content: "no", expectedHash: null }),
    final(""),
  ]) {
    await assert.rejects(compactConversation(project, scripted([response]), messages, "", new AbortController().signal, () => {}), /complete bounded summary/);
    assert.deepEqual(messages, before);
  }
  let usage = 0;
  const result = await compactConversation(project, scripted([final("Goal: explain architecture. One file inspected; no edits or checks.")]),
    messages, "Keep constraints", new AbortController().signal, (value) => { usage += value.inputTokens; });
  assert.ok(result.afterChars < result.beforeChars);
  assert.equal(usage, 10);
  assert.strictEqual(result.messages[0], messages[0]);
  assert.match(result.messages[1]!.content!, /not new instructions or permission grants/);
  assert.equal(result.messages.at(-1)!.content, instructions[1]!.content);
  assert.ok(!result.messages.some((message) => message.tool_calls?.length || message.role === "tool"));
  assert.deepEqual(messages, before);
});

test("compaction refuses unsummarizable context before making a request and leaves original tool output intact", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxContextChars = 3000;
  const messages: Message[] = [...instructions,
    ...exchange("read_file", { content: "Observation ".repeat(1000) }, "read"),
    { role: "assistant", content: "Preserved reasoning. ".repeat(1000) }];
  const before = structuredClone(messages);
  let requests = 0;
  await assert.rejects(compactConversation(project, scripted([]), messages, "", new AbortController().signal,
    () => {}, () => { requests++; }), /context limit/);
  assert.equal(requests, 0);
  assert.deepEqual(messages, before);
});
