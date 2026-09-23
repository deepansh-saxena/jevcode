import test from "node:test";
import assert from "node:assert/strict";
import { fixture, call, final, options, scripted } from "./helpers.js";
import { run } from "../src/runtime.js";
import { ExecutionSession } from "../src/lifecycle.js";
import type { Completion } from "../src/llm.js";

test("parallel specialists truly overlap, isolate contexts and share global turns and token usage", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.resultFormat = "text";
  let active = 0;
  let maxActive = 0;
  let mainTurns = 0;
  const pending: (() => void)[] = [];
  const result = await run(project, options({
    async complete(messages, tools) {
      const task = messages.filter((message) => message.role === "user").at(-1)!.content!;
      if (messages[0]!.content!.includes("Specialist role:")) {
        assert.ok(["alpha", "beta"].includes(task));
        assert.equal(messages.length, 2);
        assert.ok(tools.every((tool) => ["list_files", "read_file", "search_files"].includes(tool.function.name)));
        active++; maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => {
          pending.push(resolve);
          if (pending.length === 2) for (const release of pending) release();
        });
        active--;
        return final(`${task} isolated report`);
      }
      if (mainTurns++ === 0) return call("delegate_parallel", { tasks: [
        { specialistId: "investigator", task: "alpha" }, { specialistId: "investigator", task: "beta" },
      ] });
      const results = JSON.parse(messages.at(-1)!.content!);
      assert.equal(results.length, 2);
      assert.equal(results[0].result.text, "alpha isolated report");
      assert.equal(results[1].result.text, "beta isolated report");
      return final("Integrated");
    },
  }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(maxActive, 2);
  assert.equal(result.metrics.turns, 4);
  assert.equal(result.metrics.llm.inputTokens, 40);
  assert.equal(result.metrics.llm.outputTokens, 20);
});

test("background specialists return task IDs, can be awaited, and cannot delegate, mutate or ask approval", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.resultFormat = "text";
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  let mainTurns = 0;
  let taskId = "";
  let approvals = 0;
  const result = await run(project, options({
    async complete(messages) {
      if (messages[0]!.content!.includes("Specialist role:")) return call("write_file", { path: "bad", content: "bad", expectedHash: null });
      if (mainTurns++ === 0) return call("delegate_task", { specialistId: "investigator", task: "inspect", background: true });
      if (mainTurns === 2) {
        taskId = JSON.parse(messages.at(-1)!.content!).id;
        return call("task_wait", { taskId });
      }
      const task = JSON.parse(messages.at(-1)!.content!);
      assert.equal(task.status, "failed");
      assert.match(task.error, /Unavailable tool/);
      return final("Blocked unsafe specialist");
    },
  }, { session, permissions: { write: true, commands: true, execution: true }, approve: async () => { approvals++; return true; } }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(approvals, 0);
  assert.equal(session.tasks.read(taskId).status, "failed");
  await assert.rejects(project.workspace.read("bad"), /ENOENT/);
});

test("mutating specialists are rejected for parallel/background but retain sequential approvals", async (t) => {
  const project = await fixture(t);
  project.specialists.push({ id: "writer", role: "writer", description: "writer", skills: [], tools: ["write_file"], maxTurns: 2, maxToolCalls: 1 });
  for (const response of [
    call("delegate_task", { specialistId: "writer", task: "edit", background: true }),
    call("delegate_parallel", { tasks: [{ specialistId: "writer", task: "edit" }] }),
  ]) {
    const blocked = await run(project, options(scripted([response]), { permissions: { write: true, commands: false }, approve: async () => true }));
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.text, /exclusively static read-only/);
  }
  let approvals = 0;
  const sequential = await run(project, options(scripted([
    call("delegate_task", { specialistId: "writer", task: "edit" }),
    call("write_file", { path: "good", content: "approved", expectedHash: null }), final("Created"), final("Integrated"),
  ]), { permissions: { write: true, commands: false }, approve: async () => { approvals++; return true; } }));
  assert.equal(sequential.status, "completed", sequential.text);
  assert.equal(approvals, 1);
});

test("parent cancellation reaches background specialists and settles metrics before returning", async (t) => {
  const project = await fixture(t);
  project.specialists[0]!.resultFormat = "text";
  const controller = new AbortController();
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let childCancelled = false;
  let mainTurns = 0;
  const result = await run(project, options({
    async complete(messages, _tools, _model, signal): Promise<Completion> {
      if (messages[0]!.content!.includes("Specialist role:")) {
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
          childCancelled = true; reject(signal.reason);
        }, { once: true }));
      }
      if (mainTurns++ === 0) return call("delegate_task", { specialistId: "investigator", task: "inspect", background: true });
      await waiting;
      controller.abort(new Error("user cancelled"));
      signal.throwIfAborted();
      return final();
    },
  }, { session, signal: controller.signal }));
  assert.equal(result.status, "cancelled");
  assert.equal(childCancelled, true);
  assert.equal(session.tasks.list()[0]!.status, "cancelled");
  assert.equal(result.metrics.usageIncompleteRequests, 2);
  assert.equal(result.metrics.costUsd, null);
});

test("unfinished specialists are cancelled on parent completion and never continue between chat turns", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  let mainTurns = 0;
  const result = await run(project, options({
    async complete(messages, _tools, _model, signal): Promise<Completion> {
      if (messages[0]!.content!.includes("Specialist role:")) {
        started();
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (mainTurns++ === 0) return call("delegate_task", { specialistId: "investigator", task: "inspect", background: true });
      await waiting;
      return final("Finished without child");
    },
  }, { session }));
  assert.equal(result.status, "completed");
  assert.equal(session.tasks.list()[0]!.status, "cancelled");
  assert.equal(result.metrics.usageIncompleteRequests, 1);
});

test("parallel launch preflights shared run count, concurrency and remaining turns without starting partial batches", async (t) => {
  for (const constraint of ["runs", "concurrency", "turns"]) {
    const project = await fixture(t);
    if (constraint === "runs") project.config.limits.maxSpecialistRuns = 1;
    if (constraint === "concurrency") project.config.execution.maxParallelSpecialists = 1;
    if (constraint === "turns") project.config.limits.maxTurns = 2;
    const session = new ExecutionSession(project.workspace, project.config);
    t.after(() => session.close());
    const result = await run(project, options(scripted([call("delegate_parallel", { tasks: [
      { specialistId: "investigator", task: "one" }, { specialistId: "investigator", task: "two" },
    ] })]), { session }));
    assert.equal(result.status, "limited", constraint);
    assert.equal(session.tasks.list().length, 0);
    assert.equal(result.metrics.turns, 1);
  }
});

test("shared tool-call limits apply across concurrent specialists", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxToolCalls = 2;
  project.specialists[0]!.resultFormat = "text";
  let mainTurns = 0;
  const result = await run(project, options({
    async complete(messages): Promise<Completion> {
      if (messages[0]!.content!.includes("Specialist role:")) {
        return messages.some((message) => message.role === "tool") ? final("Read") : call("list_files", {});
      }
      if (mainTurns++ === 0) return call("delegate_parallel", { tasks: [
        { specialistId: "investigator", task: "one" }, { specialistId: "investigator", task: "two" },
      ] });
      return final("Budget bounded");
    },
  }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.metrics.toolCalls, 2);
  assert.ok(result.metrics.turns <= project.config.limits.maxTurns);
});

test("background specialist features can be disabled without disabling sequential delegation", async (t) => {
  const project = await fixture(t);
  const result = await run(project, options(scripted([call("delegate_task", {
    specialistId: "investigator", task: "inspect", background: true,
  })], (_messages, tools) => {
    assert.ok(!tools.some((tool) => tool.function.name === "delegate_parallel"));
    assert.ok(tools.some((tool) => tool.function.name === "delegate_task"));
  }), { backgroundSpecialists: false }));
  assert.equal(result.status, "blocked");
  assert.match(result.text, /disabled/);
});
