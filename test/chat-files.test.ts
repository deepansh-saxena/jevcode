import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportTranscript, transcript, workspaceDiff } from "../src/chat-files.js";
import { ChatController } from "../src/chat-controller.js";
import { handleChatCommand, newChatMetrics, type ChatState, type CommandIO } from "../src/chat-commands.js";
import { fixture, final, scripted } from "./helpers.js";
import type { Project } from "../src/registry.js";

const exec = promisify(execFile);
const current = (project: Project): ChatState => ({
  project, model: scripted([]), messages: [{ role: "user", content: "Private task" }, { role: "assistant", content: "Response" }],
  settings: { permissions: { write: false, commands: false } }, planMode: false, runs: 0, compactions: 0, metrics: newChatMetrics(),
});
const io = (answer: boolean): CommandIO => ({ signal: new AbortController().signal, write() {}, confirm: async () => answer });

test("transcript exports require explicit consent and a new private allowed path", async (t) => {
  const project = await fixture(t);
  const state = current(project);
  await handleChatCommand("/export transcript.txt", state, io(false));
  await assert.rejects(project.workspace.read("transcript.txt"), /ENOENT/);
  await handleChatCommand("/export transcript.txt", state, io(true));
  assert.match(await project.workspace.read("transcript.txt"), /Private task/);
  if (process.platform !== "win32") assert.equal((await stat(path.join(project.workspace.root, "transcript.txt"))).mode & 0o777, 0o600);
  await assert.rejects(exportTranscript(project, "transcript.txt", state.messages), /EEXIST/);
  await assert.rejects(exportTranscript(project, ".env", state.messages), /protected/);
  assert.doesNotMatch(transcript([...state.messages, { role: "system", content: "NOT_EXPORTED" },
    { role: "tool", content: "NOT_EXPORTED" }]), /NOT_EXPORTED/);
});

test("git diff is bounded, read-only, and excludes protected tracked paths", async (t) => {
  const project = await fixture(t);
  const cwd = project.workspace.root;
  await exec("git", ["init", "--quiet"], { cwd });
  await writeFile(path.join(cwd, "code.txt"), "before\n");
  await writeFile(path.join(cwd, ".env"), "SECRET_BEFORE\n");
  await exec("git", ["add", "code.txt", ".env"], { cwd });
  await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"], { cwd });
  await writeFile(path.join(cwd, "code.txt"), "after\n");
  await writeFile(path.join(cwd, ".env"), "SECRET_AFTER\n");
  const diff = await workspaceDiff(project, new AbortController().signal);
  assert.match(diff, /-before/);
  assert.match(diff, /\+after/);
  assert.match(diff, /protected\/unsafe paths omitted/);
  assert.doesNotMatch(diff, /SECRET_/);
  assert.equal(await readFile(path.join(cwd, "code.txt"), "utf8"), "after\n");
});

test("automatic semantic compaction is opt-in, accounts usage and preserves failed original context", async (t) => {
  const state = current(await fixture(t));
  state.project.config.limits.maxContextChars = 40_000;
  state.messages[1]!.content = "Observation ".repeat(2500);
  state.model = scripted([final("Summary: no files changed"), final("Completed")]);
  await handleChatCommand("/auto-compact on", state, io(false));
  assert.equal(state.autoCompact, undefined);
  await handleChatCommand("/auto-compact on", state, io(true));
  const app = new ChatController(state);
  t.after(() => app.close());
  await app.submit("Continue", { ...io(false), event() {}, askUser: async () => "answer" });
  assert.equal(state.compactions, 1);
  assert.equal(state.runs, 1);
  assert.equal(state.metrics.llm.inputTokens, 20);
  assert.equal(state.metrics.turns, 2);
  assert.match(state.messages[1]!.content!, /Earlier conversation summary/);
  assert.equal(state.messages.at(-2)!.content, "Continue");
  state.messages[1]!.content = "Observation ".repeat(2500);
  const original = state.messages;
  state.model = { async complete() { throw new Error("Summary unavailable"); } };
  await assert.rejects(app.submit("Again", { ...io(false), event() {}, askUser: async () => "answer" }), /Summary unavailable/);
  assert.strictEqual(state.messages, original);
});
