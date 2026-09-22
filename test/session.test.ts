import test from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../src/llm.js";
import { restoreSession, saveSession } from "../src/session.js";
import { run } from "../src/runtime.js";
import { fixture, scripted, options, call, final } from "./helpers.js";

test("follow-up turns retain prior evidence and replace mandatory instructions with current guidance", async (t) => {
  const project = await fixture(t);
  const conversation: Message[] = [];
  const model = scripted([final("The answer was cobalt"), final("Still cobalt")], (messages, _tools, index) => {
    if (index === 1) {
      assert.equal(messages.filter((message) => message.role === "system").length, 1);
      assert.match(messages[0]!.content!, /Updated project rule/);
      assert.ok(messages.some((message) => message.content === "The answer was cobalt"));
      assert.equal(messages.at(-1)!.content, "What was the answer?");
    }
  });
  assert.equal((await run(project, options(model, { conversation, task: "Remember cobalt" }))).status, "completed");
  project.instructions = "Updated project rule";
  assert.equal((await run(project, options(model, { conversation, task: "What was the answer?" }))).status, "completed");
});

test("denied and interrupted batches receive matching error results without replaying actions", async (t) => {
  const project = await fixture(t);
  const conversation: Message[] = [];
  const response = call("write_file", { path: "not-created", content: "no", expectedHash: null });
  response.message.tool_calls!.push({
    id: "second", type: "function", function: { name: "read_file", arguments: '{"path":"not-created"}' },
  });
  const model = scripted([response, final("The action was not completed.")], (messages, _tools, index) => {
    if (index === 1) {
      const results = messages.filter((message) => message.role === "tool");
      assert.equal(results.length, 2);
      assert.deepEqual(results.map((message) => message.tool_call_id), ["call-1", "second"]);
      assert.ok(results.every((message) => JSON.parse(message.content!).error));
    }
  });
  const first = await run(project, options(model, { conversation, permissions: { write: true, commands: false } }));
  assert.equal(first.status, "blocked");
  const next = await run(project, options(model, { conversation, task: "What happened?" }));
  assert.equal(next.status, "completed");
  assert.equal(next.metrics.toolCalls, 0);
  await assert.rejects(project.workspace.read("not-created"), /ENOENT/);
});

test("private snapshot round trips and refuses wrong provider, malformed pairs, traversal, and public permissions", async (t) => {
  const project = await fixture(t);
  const model = scripted([]);
  const messages: Message[] = [{ role: "user", content: "private task" }, { role: "assistant", content: "private answer" }];
  const id = await saveSession(project, messages, model);
  assert.deepEqual(await restoreSession(project, id, model), messages);
  const filename = path.join(project.workspace.root, `.jev/sessions/${id}.json`);
  project.config.llm.model = "different";
  await assert.rejects(restoreSession(project, id, model), /original workspace, provider, and model/);
  project.config.llm.model = "gpt-4.1-mini";
  await assert.rejects(restoreSession(project, "../bad", model), /UUID/);
  if (process.platform !== "win32") {
    await chmod(filename, 0o644);
    await assert.rejects(restoreSession(project, id, model), /private/);
    await chmod(filename, 0o600);
  }
  const snapshot = JSON.parse(await readFile(filename, "utf8"));
  snapshot.messages.push({ role: "tool", tool_call_id: "missing", content: "{}" });
  await writeFile(filename, JSON.stringify(snapshot));
  await assert.rejects(restoreSession(project, id, model), /Invalid saved tool result/);
  await writeFile(filename, "private malformed content");
  await assert.rejects(restoreSession(project, id, model), (error: unknown) =>
    error instanceof Error && !error.message.includes("private malformed content"));
});
