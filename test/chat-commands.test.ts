import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { commandCompletions, handleChatCommand, newChatMetrics, recordRun, type ChatState, type CommandIO } from "../src/chat-commands.js";
import { saveSession } from "../src/session.js";
import { fixture, scripted, final } from "./helpers.js";
import type { Project } from "../src/registry.js";

function state(project: Project): ChatState {
  return { project, model: scripted([]), messages: [], settings: { permissions: { write: false, commands: false }, skills: [] },
    planMode: false, runs: 0, compactions: 0, metrics: newChatMetrics() };
}
function io(answer = false): CommandIO & { output: string[]; confirmations: string[] } {
  const output: string[] = [];
  const confirmations: string[] = [];
  return { output, confirmations, write: (text) => output.push(text), signal: new AbortController().signal,
    confirm: async (prompt) => { confirmations.push(prompt); return answer; } };
}

test("help and completion discover built-ins and installed skills without calling a model", async (t) => {
  const project = await fixture(t);
  const current = state(project);
  const terminal = io();
  assert.equal((await handleChatCommand("/help", current, terminal)).kind, "handled");
  for (const name of ["/skills", "/agents", "/permissions", "/plan", "/model", "/compact", "/context", "/usage", "/sessions", "/testing"]) {
    assert.ok(terminal.output.join("").includes(name));
  }
  assert.deepEqual(commandCompletions(project, "/test"), [["/testing"], "/test"]);
  assert.deepEqual(commandCompletions(project, "/skills run te"), [["/skills run testing"], "/skills run te"]);
  assert.deepEqual(commandCompletions(project, "normal task"), [[], "normal task"]);
  await assert.rejects(handleChatCommand("/made-up", current, terminal), /Unknown chat command/);
  await assert.rejects(handleChatCommand("/clear extra", current, terminal), /does not take/);
});

test("skill slash invocation is task-scoped while explicit pinning persists", async (t) => {
  const project = await fixture(t);
  const current = state(project);
  const terminal = io();
  assert.deepEqual(await handleChatCommand("/testing Cover the bug", current, terminal),
    { kind: "task", task: "Cover the bug", skills: ["testing"] });
  assert.deepEqual(current.settings.skills, []);
  await handleChatCommand("/skills use testing", current, terminal);
  assert.deepEqual(current.settings.skills, ["testing"]);
  await handleChatCommand("/skills use none", current, terminal);
  assert.deepEqual(current.settings.skills, []);
  assert.deepEqual(await handleChatCommand("/agents run investigator Trace the bug", current, terminal),
    { kind: "task", task: "Trace the bug", specialistId: "investigator" });
  assert.equal(current.settings.specialistId, undefined);
  await handleChatCommand("/agents use investigator", current, terminal);
  assert.equal(current.settings.specialistId, "investigator");
  await handleChatCommand("/agents use off", current, terminal);
  assert.equal(current.settings.specialistId, undefined);
  await assert.rejects(handleChatCommand("/skills use missing", current, terminal), /Unknown skill/);
  await assert.rejects(handleChatCommand("/agents run investigator", current, terminal), /Usage/);
});

test("capability creation is model-authored and requires existing edit permission, not a permission bypass", async (t) => {
  const current = state(await fixture(t));
  await assert.rejects(handleChatCommand("/skills create A testing workflow", current, io()), /edit permission/);
  current.settings.permissions.write = true;
  const result = await handleChatCommand("/skills create A testing workflow", current, io());
  assert.equal(result.kind, "task");
  if (result.kind === "task") assert.match(result.task, /create_skill[\s\S]*A testing workflow/);
  const agent = await handleChatCommand("/agents create A test investigator", current, io());
  if (agent.kind === "task") assert.match(agent.task, /create_specialist/);
  current.planMode = true;
  await assert.rejects(handleChatCommand("/agents create A writer", current, io()), /plan mode/);
});

test("permission elevation and leaving plan mode require fresh consent; denial retains state", async (t) => {
  const current = state(await fixture(t));
  const denied = io();
  await handleChatCommand("/permissions all", current, denied);
  assert.equal(denied.confirmations.length, 1);
  assert.deepEqual(current.settings.permissions, { write: false, commands: false });
  const allowed = io(true);
  await handleChatCommand("/permissions all", current, allowed);
  assert.deepEqual(current.settings.permissions, { write: true, commands: true });
  await handleChatCommand("/plan on", current, denied);
  assert.equal(current.planMode, true);
  await handleChatCommand("/plan off", current, denied);
  assert.equal(current.planMode, true);
  await handleChatCommand("/plan off", current, allowed);
  assert.equal(current.planMode, false);
  await handleChatCommand("/permissions read-only", current, denied);
  assert.deepEqual(current.settings.permissions, { write: false, commands: false });
  await assert.rejects(handleChatCommand("/permissions anything", current, denied), /Usage/);
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await assert.rejects(handleChatCommand("/permissions all", current, { ...io(true), signal: controller.signal }), /Cancelled/);
  assert.deepEqual(current.settings.permissions, { write: false, commands: false });
});

test("model switching is session-only, clears context only after consent, and retains state on failure", async (t) => {
  const project = await fixture(t);
  const current = state(project);
  current.messages = [{ role: "user", content: "Keep me" }];
  const original = current.model;
  await handleChatCommand("/model another", current, io());
  assert.equal(project.config.llm.model, "gpt-4.1-mini");
  assert.equal(current.messages.length, 1);
  project.config.llm.apiKeyEnv = "JEV_MISSING_TEST_KEY";
  await assert.rejects(handleChatCommand("/model another", current, io(true)), /Missing/);
  assert.strictEqual(current.model, original);
  assert.equal(current.messages.length, 1);
  const previous = process.env.JEV_MISSING_TEST_KEY;
  process.env.JEV_MISSING_TEST_KEY = "synthetic-test-key";
  t.after(() => {
    if (previous === undefined) delete process.env.JEV_MISSING_TEST_KEY;
    else process.env.JEV_MISSING_TEST_KEY = previous;
  });
  await handleChatCommand("/model another", current, io(true));
  assert.equal(project.config.llm.model, "another");
  assert.deepEqual(current.messages, []);
  const { loadProject } = await import("../src/registry.js");
  assert.equal((await loadProject(project.workspace.root)).config.llm.model, "gpt-4.1-mini");
});

test("sessions list IDs without transcripts; replacing unsaved context requires consent", async (t) => {
  const project = await fixture(t);
  const current = state(project);
  const terminal = io();
  await handleChatCommand("/sessions", current, terminal);
  assert.match(terminal.output.join(""), /"sessions": \[\]/);
  const saved = [{ role: "user" as const, content: "SAVED_PRIVATE_TRANSCRIPT" }];
  const id = await saveSession(project, saved, current.model);
  await handleChatCommand("/sessions", current, terminal);
  assert.match(terminal.output.join(""), new RegExp(id));
  assert.doesNotMatch(terminal.output.join(""), /SAVED_PRIVATE_TRANSCRIPT/);
  current.messages = [{ role: "user", content: "Unsaved" }];
  await handleChatCommand(`/resume ${id}`, current, terminal);
  assert.equal(current.messages[0]!.content, "Unsaved");
  await handleChatCommand(`/resume ${id}`, current, io(true));
  assert.deepEqual(current.messages, saved);
  assert.deepEqual(current.settings.permissions, { write: false, commands: false });
});

test("reload updates project instructions and catalogs without changing session overrides", async (t) => {
  const project = await fixture(t);
  const current = state(project);
  project.config.llm.model = "override";
  await writeFile(path.join(project.workspace.root, "AGENTS.md"), "Current project conventions");
  await handleChatCommand("/reload", current, io());
  assert.equal(project.instructions, "Current project conventions");
  assert.equal(project.config.llm.model, "override");
  const shown = io();
  await handleChatCommand("/skills show testing", current, shown);
  assert.match(shown.output.join(""), /# Testing/);
  await assert.rejects(handleChatCommand("/skills show nope", current, shown), /Unknown skill/);
});

test("compaction records measured usage and /usage distinguishes unknown cost and approval wait", async (t) => {
  const current = state(await fixture(t));
  current.messages = [{ role: "system", content: "Trusted instructions" }, { role: "user", content: "Fix the bug" },
    { role: "assistant", content: "A lengthy observation. ".repeat(1000) }];
  current.model = scripted([final("Goal: fix the bug. No changes or checks yet.")], (_messages, tools) => assert.deepEqual(tools, []));
  await handleChatCommand("/compact Focus on unfinished work", current, io());
  assert.equal(current.compactions, 1);
  assert.equal(current.metrics.turns, 1);
  assert.equal(current.metrics.llm.inputTokens, 10);
  assert.equal(current.metrics.usageIncompleteRequests, 0);
  assert.match(current.messages[1]!.content!, /untrusted historical context/);
  assert.equal(current.messages.at(-1)!.content, "Fix the bug");
  const metrics = newChatMetrics();
  metrics.durationMs = 100; metrics.approvalWaitMs = 20; metrics.turns = 2;
  recordRun(current, { status: "blocked", text: "Denied", route: { skillIds: [], specialistId: null }, metrics });
  const terminal = io();
  await handleChatCommand("/usage", current, terminal);
  const usage = JSON.parse(terminal.output.join(""));
  assert.equal(usage.runs, 1);
  assert.equal(usage.turns, 3);
  assert.equal(usage.costUsd, null);
  assert.equal(usage.machineMs, usage.durationMs - 20);
});

test("failed compaction preserves context and accounts for an incomplete model request", async (t) => {
  const current = state(await fixture(t));
  const messages = [{ role: "user" as const, content: "Fix" }, { role: "assistant" as const, content: "Long observation ".repeat(1000) }];
  current.messages = messages;
  current.model = { async complete() { throw new Error("Provider unavailable"); } };
  await assert.rejects(handleChatCommand("/compact", current, io()), /Provider unavailable/);
  assert.strictEqual(current.messages, messages);
  assert.equal(current.metrics.usageIncompleteRequests, 1);
  assert.equal(current.compactions, 0);
  const empty = state(current.project);
  await assert.rejects(handleChatCommand("/compact", empty, io()), /No conversation/);
  assert.equal(empty.metrics.usageIncompleteRequests, 0);
  assert.equal(empty.metrics.turns, 0);
});
