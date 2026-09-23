import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ChatController, type ControllerIO } from "../src/chat-controller.js";
import { newChatMetrics, type ChatState } from "../src/chat-commands.js";
import { extensionsSchema } from "../src/extension-config.js";
import { loadProject, type Project } from "../src/registry.js";
import type { CodingModel } from "../src/llm.js";
import { fixture, scripted, call, final } from "./helpers.js";

function controller(project: Project, model: CodingModel) {
  const state: ChatState = { project, model, messages: [], planMode: false,
    settings: { permissions: { write: false, commands: false } },
    runs: 0, compactions: 0, metrics: newChatMetrics() };
  const app = new ChatController(state);
  const output: string[] = [];
  const approvals: string[] = [];
  const io: ControllerIO = {
    signal: new AbortController().signal,
    write: (text) => output.push(text), event() {},
    confirm: async (prompt) => { approvals.push(prompt); return true; },
    askUser: async () => { throw new Error("Unexpected question"); },
  };
  const submit = (line: string) => app.submit(line, io);
  const inspect = async (line: string): Promise<unknown> => {
    output.length = 0;
    await submit(line);
    return JSON.parse(output.join(""));
  };
  return { app, state, io, output, approvals, submit, inspect };
}

test("default controller retains edit checkpoints across turns and undo rechecks user changes", async (t) => {
  const project = await fixture(t);
  const c = controller(project, scripted([
    call("write_file", { path: "edited.txt", content: "created", expectedHash: null }), final(),
  ]));
  t.after(() => c.app.close());
  await c.submit("/permissions edit");
  const result = await c.submit("Create edited.txt");
  assert.equal(result.kind === "result" && result.result.status, "completed");
  const checkpoints = await c.inspect("/checkpoints") as { id: string; path: string }[];
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]!.path, "edited.txt");
  await writeFile(path.join(project.workspace.root, "edited.txt"), "user change");
  await assert.rejects(c.submit(`/undo ${checkpoints[0]!.id}`), /changed|conflict/i);
  assert.equal(await project.workspace.read("edited.txt"), "user change");
  await writeFile(path.join(project.workspace.root, "edited.txt"), "created");
  await c.submit(`/undo ${checkpoints[0]!.id}`);
  assert.match(c.approvals.at(-1)!, /exact undo/);
  await assert.rejects(project.workspace.read("edited.txt"), /ENOENT/);
});

test("approved shell jobs stream after a turn, persist for inspection, and stop when planning begins", {
  skip: process.platform === "win32", timeout: 10_000,
}, async (t) => {
  const project = await fixture(t);
  let ready!: () => void;
  let late!: () => void;
  const readyOutput = new Promise<void>((resolve) => { ready = resolve; });
  const lateOutput = new Promise<void>((resolve) => { late = resolve; });
  let requests = 0;
  const c = controller(project, { async complete() {
    if (requests++ === 0) return call("exec_command", { executable: process.execPath,
      args: ["-e", 'console.log("shell-ready");setTimeout(()=>console.log("shell-late"),300);setInterval(()=>{},1000)'],
      background: true, timeoutMs: 5000 });
    await readyOutput;
    return final();
  } });
  t.after(() => c.app.close());
  let logPath = "";
  c.io.event = (event, data = {}) => {
    if (event === "shell_output" && typeof data.text === "string") {
      if (data.text.includes("shell-ready")) ready();
      if (data.text.includes("shell-late")) late();
    }
    if (event === "turn_finished") logPath = String(data.eventLog);
  };
  await c.submit("/permissions all");
  assert.equal(c.state.settings.permissions.execution, undefined);
  assert.equal(c.state.settings.permissions.external, undefined);
  await c.submit("/permissions execution");
  const result = await c.submit("Start an attached process");
  assert.equal(result.kind === "result" && result.result.status, "completed");
  const tasks = await c.inspect("/tasks") as { id: string; status: string }[];
  assert.equal(tasks[0]!.status, "running");
  await lateOutput;
  const task = await c.inspect(`/task ${tasks[0]!.id}`);
  assert.match(JSON.stringify(task), /shell-late/);
  const log = await readFile(path.join(project.workspace.root, logPath), "utf8");
  assert.doesNotMatch(log, /shell-ready|shell-late/);
  await c.submit("/plan on");
  const stopped = await c.inspect("/tasks") as { status: string }[];
  assert.equal(stopped[0]!.status, "cancelled");
  await assert.rejects(c.submit("/permissions execution"), /plan mode/);
  await c.submit("/plan off");
  assert.match(c.approvals.at(-1)!, /restore.*execution/);
  await c.submit("/permissions read-only");
  assert.equal(c.state.settings.permissions.execution, undefined);
});

test("standard user-only skill arguments reach the model through shared chat dispatch", async (t) => {
  const project = await fixture(t);
  await mkdir(path.join(project.workspace.root, ".jev/skills/manual"));
  await writeFile(path.join(project.workspace.root, ".jev/skills/manual/SKILL.md"),
    "---\nname: manual\ndescription: Explicit workflow\ndisable-model-invocation: true\n---\nPerform $ARGUMENTS.");
  const loaded = await loadProject(project.workspace.root, { globalRoot: null });
  const c = controller(loaded, scripted([final()], (messages) => {
    assert.match(messages[0]!.content!, /Perform inspect widgets\./);
  }));
  t.after(() => c.app.close());
  const result = await c.submit("/manual inspect widgets");
  assert.equal(result.kind === "result" && result.result.status, "completed");
  assert.equal(c.state.settings.skills, undefined);
});

test("MCP trust and per-call approval share the controller host; planning revokes live connections", { timeout: 10_000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  } } });
  let requests = 0;
  const c = controller(project, { async complete(_messages, tools) {
    if (requests++ === 0) {
      const external = tools.find((tool) => tool.function.name.startsWith("mcp__"));
      assert.ok(external);
      return call(external.function.name, { mode: "echo" });
    }
    return final();
  } });
  t.after(() => c.app.close());
  await c.submit("/permissions all");
  await assert.rejects(c.submit("/mcp connect local"), /external|permission/i);
  await c.submit("/permissions external");
  await c.submit("/mcp connect local");
  const result = await c.submit("Use the connected server");
  assert.equal(result.kind === "result" && result.result.status, "completed");
  assert.ok(c.approvals.some((prompt) => /Approve mcp__/.test(prompt)));
  await c.submit("/plan on");
  assert.deepEqual(c.state.extensions!.tools({ permissions: { write: true, commands: true, external: true } }), []);
  await c.submit("/plan off");
  assert.deepEqual(c.state.extensions!.tools({ permissions: { write: true, commands: true, external: true } }), []);
});

test("automatic compaction and the following run share capped turns and costs without double counting", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxContextChars = 20_000;
  project.config.limits.maxTurns = 2;
  project.config.spend = { maxUsd: 1, models: {
    "openai-compatible/gpt-4.1-mini": { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
  } };
  const c = controller(project, scripted([final("No edits yet."), final("Done.")]));
  t.after(() => c.app.close());
  c.state.autoCompact = true;
  c.state.messages = [{ role: "user", content: "Inspect code" }, { role: "assistant", content: "Observation ".repeat(1300) }];
  const result = await c.submit("Continue");
  assert.equal(result.kind === "result" && result.result.status, "completed");
  assert.equal(c.state.compactions, 1);
  assert.equal(c.state.metrics.turns, 2);
  assert.equal(c.state.metrics.llm.inputTokens, 20);
  assert.equal(c.state.metrics.llm.outputTokens, 10);
  assert.equal(c.state.metrics.costUsd, 0.00003);
  assert.equal(c.state.metrics.reportedCostUsd, 0.00003);
  assert.equal(c.state.metrics.usageIncompleteRequests, 0);
});

test("a consumed compaction turn cannot fund another request, and unknown prices block manual compaction", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxContextChars = 20_000;
  project.config.limits.maxTurns = 1;
  const c = controller(project, scripted([final("No edits yet.")]));
  t.after(() => c.app.close());
  c.state.autoCompact = true;
  c.state.messages = [{ role: "user", content: "Inspect code" }, { role: "assistant", content: "Observation ".repeat(1300) }];
  const result = await c.submit("Continue");
  assert.equal(result.kind === "result" && result.result.status, "limited");
  assert.equal(c.state.metrics.turns, 1);
  assert.equal(c.state.metrics.llm.inputTokens, 10);
  c.state.project.config.spend.maxUsd = 1;
  c.state.messages.push({ role: "assistant", content: "Another observation ".repeat(500) });
  const original = c.state.messages;
  await assert.rejects(c.submit("/compact"), /price is unknown/);
  assert.strictEqual(c.state.messages, original);
  assert.equal(c.state.metrics.turns, 1);
});

test("closing a controller cancels compaction and permanently rejects further work", async (t) => {
  const project = await fixture(t);
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  const c = controller(project, { async complete(_messages, _tools, _model, signal) {
    requested();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  } });
  t.after(() => c.app.close());
  c.state.messages = [{ role: "user", content: "Inspect" }, { role: "assistant", content: "Evidence ".repeat(1000) }];
  const work = c.submit("/compact");
  const rejected = assert.rejects(work, /controller closed/);
  await started;
  await c.app.close();
  await rejected;
  await assert.rejects(c.submit("/help"), /controller closed/);
  assert.equal(c.state.metrics.usageIncompleteRequests, 1);
});

test("manual compaction cannot bypass capped-image reservations with historical attachments", async (t) => {
  const project = await fixture(t);
  project.config.spend = { maxUsd: 1, models: {
    "openai-compatible/gpt-4.1-mini": { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
  } };
  const c = controller(project, { ...scripted([]), supportsImages: () => true });
  t.after(() => c.app.close());
  c.state.messages = [
    { role: "user", content: "Inspect image", images: [{ mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" }] },
    { role: "assistant", content: "Image observations ".repeat(500) },
  ];
  const messages = c.state.messages;
  await assert.rejects(c.submit("/compact"), /image.*bound|bound.*image/i);
  assert.strictEqual(c.state.messages, messages);
  assert.equal(c.state.metrics.turns, 0);
  assert.equal(c.state.metrics.usageIncompleteRequests, 0);
});
