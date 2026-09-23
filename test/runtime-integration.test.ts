import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fixture, options, scripted, call, final } from "./helpers.js";
import { run } from "../src/runtime.js";
import { reserveModelRequest, RunBudget } from "../src/budget.js";
import { ExecutionSession } from "../src/lifecycle.js";
import { ExtensionHost, type ExtensionContext } from "../src/extensions.js";
import type { Completion, Message } from "../src/llm.js";
import type { PreparedAction } from "../src/tools.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const image = { mimeType: "image/png" as const, data: Buffer.concat([png, Buffer.alloc(750_000)]).toString("base64") };

test("large image requests are not rejected because base64 is mistaken for input tokens", async (t) => {
  const project = await fixture(t);
  const model = { ...scripted([final("Observed")], (messages) => {
    assert.equal(messages.at(-1)!.images?.[0]?.data, image.data);
  }), supportsImages: () => true };
  const result = await run(project, options(model, { images: [image] }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.metrics.turns, 1);
  assert.deepEqual(result.metrics.llm, { inputTokens: 10, outputTokens: 5 });
  assert.equal(result.metrics.costUsd, null);
});

test("image reservations consume remaining scope capacity and keep native history identity intact", async (t) => {
  const project = await fixture(t);
  const budget = new RunBudget(project.config);
  const native: Message = { role: "assistant", content: "Native signed response" };
  const messages: Message[] = [{ role: "user", content: "Inspect", images: [image] }, native];
  const model = { ...scripted([]), supportsImages: () => true,
    contextSize(text: Message[]) {
      assert.equal(text[1], native);
      assert.equal(text[0]!.images, undefined);
      return JSON.stringify(text).length;
    },
  };
  const reservation = reserveModelRequest(budget, model, project.config.llm.model, messages, [], 4096);
  assert.equal(messages[0]!.images?.[0], image);
  assert.throws(() => budget.reserve("llm", project.config.llm.model, 1, 1), /token budget/);
  reservation.settle({ inputTokens: 5000, outputTokens: 20 });
  budget.reserve("llm", project.config.llm.model, 50, 50).settle({ inputTokens: 50, outputTokens: 50 });
  assert.equal(budget.turns, 2);
});

test("capped image requests explicitly reject unknown vision bounds, including images in history", async (t) => {
  for (const history of [false, true]) {
    const project = await fixture(t);
    project.config.spend.maxUsd = 100;
    project.config.spend.models[`${project.config.llm.provider}/${project.config.llm.model}`] = {
      inputUsdPerMillion: 1, outputUsdPerMillion: 1,
    };
    const model = { supportsImages: () => true, async complete() { assert.fail("Capped vision request must not be sent"); } };
    const result = await run(project, options(model, history ?
      { conversation: [{ role: "user", content: "Earlier image", images: [image] }] } : { images: [image] }));
    assert.equal(result.status, "limited");
    assert.match(result.text, /Image input token bounds are unknown/);
    assert.equal(result.metrics.turns, 0);
  }
});

test("pre-run and runtime requests use one reservation helper and share turns and dollar accounting", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxTurns = 2;
  project.config.spend.maxUsd = 1;
  project.config.spend.models[`${project.config.llm.provider}/${project.config.llm.model}`] = {
    inputUsdPerMillion: 1, outputUsdPerMillion: 2,
  };
  const model = scripted([final()]);
  const budget = new RunBudget(project.config);
  reserveModelRequest(budget, model, project.config.llm.model, [{ role: "user", content: "Compact" }], [], 4096)
    .settle({ inputTokens: 10, outputTokens: 5 });
  const result = await run(project, options(model, { budget }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.metrics.turns, 2);
  assert.equal(result.metrics.costUsd, 0.00004);
  assert.deepEqual(result.metrics.llm, { inputTokens: 10, outputTokens: 5 });
  assert.throws(() => reserveModelRequest(budget, model, project.config.llm.model, [], [], 4096), /turn budget/);
});

test("parallel skill gates reject the entire batch before any tasks or child reservations start", async (t) => {
  const project = await fixture(t);
  project.skills.find((skill) => skill.id === "testing")!.modelInvocable = false;
  project.specialists.push({ ...project.specialists[0]!, id: "allowed", skills: [] });
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const budget = new RunBudget(project.config);
  const result = await run(project, options(scripted([
    call("delegate_parallel", { tasks: [
      { specialistId: "allowed", task: "May inspect" }, { specialistId: "investigator", task: "User-only skill" },
    ] }), final("Could not launch"),
  ], (messages, _tools, index) => {
    if (index === 1) assert.match(messages.at(-1)!.content!, /not model-invocable/);
  }), { session, budget }));
  assert.equal(result.status, "completed", result.text);
  assert.deepEqual(session.tasks.list(), []);
  assert.equal(budget.turns, 2);
});

test("parallel specialists never receive images, questions, hooks or externally supplied tools", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.resultFormat = "text";
  const hooks: string[] = [];
  class ObservedHost extends ExtensionHost {
    override tools(context: ExtensionContext) {
      assert.equal(context.specialist, false);
      return super.tools(context);
    }
    override async beforeTool(action: PreparedAction) { hooks.push(`before:${action.name}`); }
    override async afterTool(action: PreparedAction) { hooks.push(`after:${action.name}`); }
  }
  const host = new ObservedHost(project);
  t.after(() => host.close());
  let mainTurns = 0;
  const result = await run(project, options({
    supportsImages: () => true,
    async complete(messages, tools) {
      if (messages[0]!.content!.includes("Specialist role:")) {
        assert.ok(messages.every((message) => !message.images?.length));
        assert.ok(tools.every((tool) => ["read_file", "list_files", "search_files"].includes(tool.function.name)));
        return messages.some((message) => message.role === "tool") ? final("Observed") : call("list_files", {});
      }
      return mainTurns++ === 0 ? call("delegate_parallel", { tasks: [
        { specialistId: "investigator", task: "Inspect one" }, { specialistId: "investigator", task: "Inspect two" },
      ] }) : final("Integrated");
    },
  }, { images: [image], extensions: host, permissions: { write: true, commands: true, execution: true, external: true },
    askUser: async () => assert.fail("Specialist must not ask a hidden question"), approve: async () => assert.fail("No mutations requested") }));
  assert.equal(result.status, "completed", result.text);
  assert.deepEqual(hooks, ["before:delegate_parallel", "after:delegate_parallel"]);
});

test("top-level background runs do not inherit interactive or mutating tools from foreground permissions", async (t) => {
  const project = await fixture(t);
  const result = await run(project, options(scripted([final()], (_messages, tools) => {
    const forbidden = ["write_file", "replace_text", "run_command", "exec_command", "undo_edit", "ask_user",
      "create_skill", "create_specialist", "delegate_task", "delegate_parallel"];
    assert.ok(!tools.some((tool) => forbidden.includes(tool.function.name)));
  }), { background: true, permissions: { write: true, commands: true, execution: true, external: true },
    askUser: async () => assert.fail("No hidden question"), approve: async () => assert.fail("No hidden approval") }));
  assert.equal(result.status, "completed", result.text);
});

test("normal ephemeral execution cleanup does not cancel a caller-owned extension host", async (t) => {
  const project = await fixture(t);
  class ObservedHost extends ExtensionHost {
    cancellations = 0;
    override async cancel() { this.cancellations++; await super.cancel(); }
  }
  const host = new ObservedHost(project);
  t.after(() => host.close());
  for (let index = 0; index < 2; index++) {
    const result = await run(project, options(scripted([final()]), {
      extensions: host, permissions: { write: false, commands: false, external: true },
    }));
    assert.equal(result.status, "completed");
  }
  assert.equal(host.cancellations, 0);
});

test("extension cleanup failure returns an explicit failed result and still repairs pending tool history", async (t) => {
  const project = await fixture(t);
  class FailingHost extends ExtensionHost {
    cancellations = 0;
    override async cancel() { this.cancellations++; throw new Error("Synthetic MCP cleanup failure"); }
  }
  const host = new FailingHost(project);
  const controller = new AbortController();
  const messages: Message[] = [];
  const completed: unknown[] = [];
  const result = await run(project, options(scripted([call("write_file", { path: "not-written", expectedHash: null, content: "no" })]), {
    extensions: host, signal: controller.signal, conversation: messages,
    permissions: { write: true, commands: false, external: true },
    approve: async () => { controller.abort(new Error("User cancelled")); return false; },
    emit: (event, data) => { if (event === "run_completed") completed.push(data?.status); },
  }));
  assert.equal(result.status, "failed");
  assert.match(result.text, /User cancelled/);
  assert.match(result.text, /cleanup failed.*Synthetic MCP cleanup failure/);
  assert.equal(host.cancellations, 1);
  assert.deepEqual(completed, ["failed"]);
  assert.equal(messages.at(-1)!.role, "tool");
  assert.match(messages.at(-1)!.content!, /previous turn stopped/);
  await assert.rejects(project.workspace.read("not-written"), /ENOENT/);
});

test("a later embedding signal handler can finish extension cleanup before the process exits", { timeout: 10_000 }, async (t) => {
  const project = await fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {ExecutionSession} from ${JSON.stringify(new URL("../src/lifecycle.ts", import.meta.url).href)};
    import {Workspace} from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)};
    import {configSchema} from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    const session=new ExecutionSession(await Workspace.create(${JSON.stringify(project.workspace.root)}),configSchema.parse({version:1,llm:{model:"test"}}));
    process.once("SIGTERM",async()=>{
      await session.close();
      await new Promise(resolve=>setTimeout(resolve,100));
      console.log("embedding-cleanup-finished");
      process.exit(0);
    });
    setInterval(()=>{},1000);
    console.log("ready");
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Exited before readiness: ${stderr}`)));
  });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0, stderr);
  assert.match(stdout, /embedding-cleanup-finished/);
});

test("cancellation arriving during specialist finalization still awaits shell cleanup and reports cancellation", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.resultFormat = "text";
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const controller = new AbortController();
  let readyChild!: () => void;
  let readyShell!: () => void;
  const started = Promise.all([
    new Promise<void>((resolve) => { readyChild = resolve; }),
    new Promise<void>((resolve) => { readyShell = resolve; }),
  ]);
  let mainTurns = 0;
  let pid = 0;
  const result = await run(project, options({
    async complete(messages, _tools, _model, signal) {
      if (messages[0]!.content!.includes("Specialist role:")) {
        readyChild();
        return new Promise<Completion>((_resolve, reject) => signal.addEventListener("abort", () => {
          controller.abort(new Error("User cancelled during finalization"));
          setTimeout(() => reject(signal.reason), 20);
        }, { once: true }));
      }
      if (mainTurns++ === 0) return call("exec_command", { executable: process.execPath,
        args: ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"], background: true });
      if (mainTurns === 2) return call("delegate_task", { specialistId: "investigator", task: "Inspect", background: true });
      await started;
      return final("Finished");
    },
  }, { session, signal: controller.signal, permissions: { write: false, commands: false, execution: true },
    approve: async () => true, emit: (event, data) => {
      if (event === "shell_output") { pid = Number(String(data?.text).trim()); readyShell(); }
    } }));
  assert.equal(result.status, "cancelled");
  assert.match(result.text, /during finalization/);
  assert.ok(session.tasks.list().every((task) => task.status === "cancelled"));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
