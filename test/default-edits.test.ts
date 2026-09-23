import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { run } from "../src/runtime.js";
import { ChatController } from "../src/chat-controller.js";
import { newChatMetrics, handleChatCommand, type ChatState } from "../src/chat-commands.js";
import { ExecutionSession } from "../src/lifecycle.js";
import { ExtensionHost } from "../src/extensions.js";
import { BlockedError } from "../src/errors.js";
import { fixture, options, scripted, call, final } from "./helpers.js";

test("automatic edits retain checkpoints and do not ask for per-edit approval", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  let approvals = 0;
  const events: string[] = [];
  const result = await run(project, options(scripted([call("write_file", { path: "auto.txt", content: "automatic", expectedHash: null }), final()]), {
    editApproval: "auto", permissions: { write: true, commands: false }, session,
    approve: async () => { approvals++; return false; }, emit: (event) => { events.push(event); },
  }));
  assert.equal(result.status, "completed");
  assert.equal(approvals, 0);
  assert.equal(await project.workspace.read("auto.txt"), "automatic");
  assert.ok(events.includes("edit_authorized"));
  assert.equal(session.checkpoints.list().length, 1);
});

test("automatic edits never preapprove configured commands or persistent capability creation", async (t) => {
  const project = await fixture(t);
  project.config.commands.local = { description: "No-op", executable: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1000 };
  for (const [name, args] of [
    ["create_skill", { id: "new-skill", description: "Persistent instructions", instructions: "Do something" }],
    ["create_specialist", { id: "new-agent", description: "Persistent role", role: "Review", tools: ["read_file"] }],
    ["run_command", { commandId: "local" }],
  ] as const) {
    let approvals = 0;
    const result = await run(project, options(scripted([call(name, args)]), {
      editApproval: "auto", permissions: { write: true, commands: true },
      approve: async () => { approvals++; return false; },
    }));
    assert.equal(result.status, "blocked");
    assert.equal(approvals, 1);
  }
});

test("automatic edit policy cannot override read-only, plan mode, background isolation or protected paths", async (t) => {
  const project = await fixture(t);
  for (const extra of [
    { permissions: { write: false, commands: false } },
    { permissions: { write: true, commands: false }, planMode: true },
    { permissions: { write: true, commands: false }, background: true },
  ]) {
    const result = await run(project, options(scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]), {
      ...extra, editApproval: "auto", approve: async () => { throw new Error("No approval expected"); },
    }));
    assert.equal(result.status, "blocked");
  }
  const protectedResult = await run(project, options(scripted([call("write_file", { path: ".jev/config.json", content: "no", expectedHash: null })]), {
    editApproval: "auto", permissions: { write: true, commands: false },
  }));
  assert.equal(protectedResult.status, "blocked");
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

test("automatic replacement still requires an exact current file hash", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "keep.txt"), "Keep this");
  let toolError = "";
  await run(project, options(scripted([call("replace_text", {
    path: "keep.txt", oldText: "Keep", newText: "Delete", expectedHash: "a".repeat(64),
  }), final()], (messages, _tools, index) => { if (index) toolError = messages.at(-1)!.content!; }), {
    editApproval: "auto", permissions: { write: true, commands: false },
  }));
  assert.match(toolError, /changed|expectedHash/);
  assert.equal(await project.workspace.read("keep.txt"), "Keep this");
});

test("automatic edits still pass through fail-closed before hooks", async (t) => {
  const project = await fixture(t);
  let checked = false;
  class DenyingHost extends ExtensionHost {
    override async beforeTool(): Promise<void> { checked = true; throw new BlockedError("Before hook denied"); }
  }
  const host = new DenyingHost(project);
  t.after(() => host.close());
  const result = await run(project, options(scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]), {
    editApproval: "auto", permissions: { write: true, commands: false, external: true }, extensions: host,
    approve: async () => { throw new Error("Ordinary auto edits must not request approval"); },
  }));
  assert.equal(checked, true);
  assert.equal(result.status, "blocked");
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

test("chat edit-policy changes require fresh consent and confirmation mode remains available", async (t) => {
  const project = await fixture(t);
  const state: ChatState = { project, model: scripted([]), messages: [], settings: { permissions: { write: false, commands: false } },
    editApproval: "confirm", planMode: false, runs: 0, compactions: 0, metrics: newChatMetrics() };
  const io = { signal: new AbortController().signal, write() {}, confirm: async () => false };
  await handleChatCommand("/permissions auto-edits", state, io);
  assert.equal(state.settings.permissions.write, false);
  await handleChatCommand("/permissions auto-edits", state, { ...io, confirm: async () => true });
  assert.equal(state.settings.permissions.write, true);
  assert.equal(state.editApproval, "auto");
  await handleChatCommand("/permissions confirm-edits", state, io);
  assert.equal(state.editApproval, "confirm");
  state.model = scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]);
  const controller = new ChatController(state);
  t.after(() => controller.close());
  const result = await controller.submit("Write no.txt", { ...io, event() {}, askUser: async () => "" });
  assert.equal(result.kind, "result");
  if (result.kind === "result") assert.equal(result.result.status, "blocked");
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});
