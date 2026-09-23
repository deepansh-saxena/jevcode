import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fixture, call, final, options, scripted } from "./helpers.js";
import { executeProcess, validateExecution } from "../src/execution.js";
import { ExecutionSession, handleExecutionCommand } from "../src/lifecycle.js";
import { executionSchema } from "../src/config.js";
import { createTools } from "../src/tools.js";
import { run } from "../src/runtime.js";
import { serializeToolResult } from "../src/context.js";
import { createEventLog } from "../src/events.js";

const signal = (): AbortSignal => new AbortController().signal;

test("arbitrary execution is a separate opt-in, plan mode removes it, and denial never starts code", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const request = { executable: process.execPath, args: ["-e", "require('fs').writeFileSync('forbidden','bad')"] };
  for (const permissions of [{ write: false, commands: false }, { write: true, commands: true }]) {
    assert.ok(!createTools(project.workspace, project.config, permissions, session).some((tool) => tool.name === "exec_command"));
  }
  let approvals = 0;
  const denied = await run(project, options(scripted([call("exec_command", request)]), {
    permissions: { write: false, commands: false, execution: true }, session,
    approve: async (action) => { approvals++; assert.match(String(action.details.warning), /UNSANDBOXED/); return false; },
  }));
  assert.equal(denied.status, "blocked");
  assert.equal(approvals, 1);
  assert.deepEqual(session.tasks.list(), []);
  await assert.rejects(project.workspace.read("forbidden"), /ENOENT/);
  const planned = await run(project, options(scripted([final()], (_messages, tools) => {
    assert.ok(!tools.some((tool) => tool.function.name === "exec_command"));
  }), { planMode: true, permissions: { write: true, commands: true, execution: true }, session }));
  assert.equal(planned.status, "completed");
});

test("each execution gets fresh exact-action approval; stdout/stderr and exit status reach the model", async (t) => {
  const project = await fixture(t);
  let approvals = 0;
  const seen: string[] = [];
  const request = { executable: process.execPath, args: ["-e", "process.stdout.write('out');process.stderr.write('err');process.exitCode=3"] };
  const result = await run(project, options(scripted([call("exec_command", request), call("exec_command", request), final()],
    (messages, _tools, index) => {
      if (index) {
        const result = JSON.parse(messages.at(-1)!.content!);
        assert.equal(result.exitCode, 3);
        assert.equal(result.stdout, "out");
        assert.equal(result.stderr, "err");
        assert.equal(result.ok, false);
      }
    }), { permissions: { write: false, commands: false, execution: true },
    approve: async (action) => { approvals++; assert.deepEqual(action.details.args, request.args); return true; },
    emit: (event, data) => { if (event === "shell_output") seen.push(String(data?.text)); },
  }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(approvals, 2);
  assert.equal(seen.filter((text) => text === "out").length, 2);
});

test("execution guards cwd, symlinks, explicit workspace executables, malformed choices and protected paths", async (t) => {
  const project = await fixture(t);
  await mkdir(path.join(project.workspace.root, "inside"));
  await writeFile(path.join(project.workspace.root, "file"), "not dir");
  await symlink("inside", path.join(project.workspace.root, "alias"));
  for (const cwd of ["..", "/tmp", ".jev", "alias", "file"]) {
    await assert.rejects(validateExecution(project.workspace, { shell: "true", cwd }));
  }
  for (const request of [{}, { shell: "true", executable: "true" }, { shell: "true", args: ["extra"] },
    { executable: "../outside" }, { executable: "./.jev/config.json" }, { shell: "a\0b" }]) {
    await assert.rejects(validateExecution(project.workspace, request));
  }
  const result = await executeProcess(project.workspace, project.config.execution,
    { shell: "pwd", cwd: "inside" }, signal());
  assert.equal(result.stdout.trim(), path.join(project.workspace.root, "inside"));
});

test("commands receive only clean environment and a fresh private home removed after completion", async (t) => {
  const project = await fixture(t);
  const old = process.env.JEV_TEST_SECRET;
  process.env.JEV_TEST_SECRET = "do-not-inherit";
  t.after(() => { if (old === undefined) delete process.env.JEV_TEST_SECRET; else process.env.JEV_TEST_SECRET = old; });
  const result = await executeProcess(project.workspace, project.config.execution, {
    executable: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({env:process.env,mode:require('fs').statSync(process.env.HOME).mode&511}))"],
  }, signal());
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.env.JEV_TEST_SECRET, undefined);
  assert.equal(observed.env.OPENAI_API_KEY, undefined);
  assert.notEqual(observed.env.HOME, process.env.HOME);
  assert.equal(observed.mode, 0o700);
  await assert.rejects(stat(observed.env.HOME), /ENOENT/);
});

test("attached jobs support bounded list/read/wait/stop, concurrency and session cleanup", async (t) => {
  const project = await fixture(t);
  project.config.execution.maxJobs = 1;
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const task = session.launch({ executable: process.execPath, args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
    background: true }, signal(), (event) => { if (event === "shell_output") ready(); });
  await started;
  assert.equal(session.tasks.list()[0]!.status, "running");
  assert.equal(session.tasks.list()[0]!.result, undefined);
  assert.match(JSON.stringify(session.tasks.read(task.id).result), /ready/);
  assert.throws(() => session.launch({ shell: "true" }, signal()), /Concurrent shell/);
  const stopped = await session.tasks.stop(task.id);
  assert.equal(stopped.status, "cancelled");
  assert.equal((await session.tasks.wait(task.id)).status, "cancelled");
  await assert.rejects(session.tasks.wait("missing"), /Unknown task/);
  const next = session.launch({ shell: "sleep 10" }, signal());
  await session.close();
  assert.equal(session.tasks.read(next.id).status, "cancelled");
  assert.throws(() => session.launch({ shell: "true" }, signal()), /closed/);
});

test("wait cancellation does not detach or cancel the underlying job", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const task = session.launch({ shell: "sleep 10" }, signal());
  const controller = new AbortController();
  const waiting = session.tasks.wait(task.id, controller.signal);
  controller.abort(new Error("stop waiting"));
  await assert.rejects(waiting, /stop waiting/);
  assert.equal(session.tasks.read(task.id).status, "running");
  assert.equal((await session.tasks.stop(task.id)).status, "cancelled");
});

test("timeouts, output ceilings and cancellation retain bounded output and terminate process groups", async (t) => {
  const project = await fixture(t);
  const config = executionSchema.parse({ maxOutputBytes: 1024 });
  const overflow = await executeProcess(project.workspace, config, {
    executable: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(80000));setInterval(()=>{},1000)"],
  }, signal());
  assert.equal(overflow.ok, false);
  assert.equal(overflow.truncated, true);
  assert.equal(Buffer.byteLength(overflow.output), 1024);
  assert.match(overflow.error!, /output limit/);
  const timed = await executeProcess(project.workspace, config, { shell: "sleep 10", timeoutMs: 100 }, signal());
  assert.match(timed.error!, /deadline/);
  const controller = new AbortController();
  const cancelled = executeProcess(project.workspace, config, { shell: "sleep 10" }, controller.signal, () => {});
  controller.abort(new Error("cancel"));
  await assert.rejects(cancelled, /cancel/);
});

test("a leader exiting cannot leave its ordinary descendants holding the job open", async (t) => {
  const project = await fixture(t);
  let pid = 0;
  const result = await executeProcess(project.workspace, project.config.execution, {
    executable: process.execPath,
    args: ["-e", "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log(c.pid);setTimeout(()=>process.exit(0),60)"],
    timeoutMs: 2000,
  }, signal(), (_stream, text) => { pid = Number(text.trim()); });
  assert.equal(result.ok, true, result.error);
  assert.ok(pid > 0);
  // macOS reaps killed descendants asynchronously.
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("descendant survived process-group cleanup");
});

test("shell jobs survive successful turns only in an explicitly owned session", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const model = scripted([call("exec_command", { shell: "sleep 10", background: true }), final("Job started")]);
  const result = await run(project, options(model, { session, permissions: { write: false, commands: false, execution: true },
    approve: async () => true }));
  assert.equal(result.status, "completed");
  assert.equal(session.tasks.list()[0]!.status, "running");
  await session.close();
  assert.equal(session.tasks.list()[0]!.status, "cancelled");
});

test("task history is bounded and lifecycle commands remain available after permissions are revoked", async (t) => {
  const project = await fixture(t);
  project.config.execution.maxTasks = 1;
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const task = session.launch({ shell: "true" }, signal());
  await session.tasks.wait(task.id);
  assert.throws(() => session.launch({ shell: "true" }, signal()), /history limit/);
  const output: string[] = [];
  const io = { write: (text: string) => output.push(text), confirm: async () => false, signal: signal() };
  for (const line of ["/tasks", `/task ${task.id}`, `/stop ${task.id}`, "/checkpoints"]) {
    assert.equal(await handleExecutionCommand(line, session, { permissions: { write: false, commands: false }, planMode: true }, io), true);
  }
  assert.equal(await handleExecutionCommand("/help", session, { permissions: { write: false, commands: false } }, io), false);
  await assert.rejects(handleExecutionCommand("/task", session, { permissions: { write: false, commands: false } }, io), /Usage/);
  assert.equal(output.length, 4);
});

test("Docker backend requires a pinned image and missing binary fails closed without running host commands", async (t) => {
  const project = await fixture(t);
  assert.throws(() => executionSchema.parse({ isolation: { backend: "docker", image: "node:latest" } }), /digest/);
  const config = executionSchema.parse({ isolation: { backend: "docker",
    executable: path.join(project.workspace.root, "missing-docker"), image: `node@sha256:${"a".repeat(64)}` } });
  const result = await executeProcess(project.workspace, config, { shell: "touch must-not-exist" }, signal());
  assert.equal(result.ok, false);
  assert.match(result.error!, /ENOENT/);
  await assert.rejects(project.workspace.read("must-not-exist"), /ENOENT/);
});

test("Docker invocation is network-off, no pull, explicit UID/GID, workspace-only mount and explicit cleanup", async (t) => {
  const project = await fixture(t);
  const executable = path.join(project.workspace.root, "fake-docker");
  const log = path.join(project.workspace.root, "docker-log");
  await writeFile(executable, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');\n`);
  await chmod(executable, 0o700);
  const config = executionSchema.parse({ isolation: { backend: "docker", executable, image: `node@sha256:${"a".repeat(64)}` } });
  const result = await executeProcess(project.workspace, config, { shell: "printf inside" }, signal());
  assert.equal(result.ok, true, result.error);
  const [run, cleanup] = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(run.args.includes("--pull=never"));
  assert.ok(run.args.includes("--network=none"));
  assert.ok(run.args.includes("--read-only"));
  assert.ok(run.args.includes("--cap-drop=ALL"));
  assert.equal(run.args[run.args.indexOf("--user") + 1], `${process.getuid!()}:${process.getgid!()}`);
  assert.ok(run.args.includes(`type=bind,src=${project.workspace.root},dst=/workspace`));
  assert.equal(run.args.filter((arg: string) => arg === "--mount").length, 1);
  assert.ok(!JSON.stringify(run.args).includes(process.env.HOME!));
  assert.deepEqual(cleanup.args.slice(0, 2), ["rm", "--force"]);
  assert.equal(cleanup.args[2], run.args[run.args.indexOf("--name") + 1]);
});

test("UTF-8 output remains valid across chunks and even invalid output cannot exceed the byte bound", async (t) => {
  const project = await fixture(t);
  const config = executionSchema.parse({ maxOutputBytes: 1024 });
  const result = await executeProcess(project.workspace, config, { executable: process.execPath,
    args: ["-e", "const b=Buffer.from([240,159,152,128]);process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),20)"],
  }, signal());
  assert.equal(result.stdout, String.fromCodePoint(0x1f600));
  const invalid = await executeProcess(project.workspace, config, { executable: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.alloc(2000,255))"],
  }, signal());
  assert.ok(Buffer.byteLength(invalid.stdout) + Buffer.byteLength(invalid.stderr) <= 1024);
  assert.ok(Buffer.byteLength(invalid.output) <= 1024);
  assert.equal(invalid.truncated, true);
});

test("output observer failure stops work and records an explicit error", async (t) => {
  const project = await fixture(t);
  const result = await executeProcess(project.workspace, project.config.execution, {
    executable: process.execPath, args: ["-e", "console.log('ready');setInterval(()=>{},1000)"],
  }, signal(), () => { throw new Error("observer unavailable"); });
  assert.equal(result.ok, false);
  assert.match(result.error!, /Output observer failed: observer unavailable/);
});

test("approval cannot be silently switched from Docker to host execution by a config change", async (t) => {
  const project = await fixture(t);
  project.config.execution.isolation = { backend: "docker", executable: path.join(project.workspace.root, "missing-docker"),
    image: `node@sha256:${"a".repeat(64)}` };
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const tool = createTools(project.workspace, project.config, { write: false, commands: false, execution: true }, session)
    .find((tool) => tool.name === "exec_command")!;
  const action = await tool.prepare({ shell: "touch cannot-run-on-host" });
  project.config.execution.isolation = { backend: "none" };
  const result = await action.execute(signal()) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(result.error!, /ENOENT/);
  await assert.rejects(project.workspace.read("cannot-run-on-host"), /ENOENT/);
});

test("SIGTERM closes owned sessions and kills attached jobs before the harness exits", { timeout: 10_000 }, async (t) => {
  const project = await fixture(t);
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {ExecutionSession} from ${JSON.stringify(new URL("../src/lifecycle.ts", import.meta.url).href)};
    import {Workspace} from ${JSON.stringify(new URL("../src/workspace.ts", import.meta.url).href)};
    import {configSchema} from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
    const s=new ExecutionSession(await Workspace.create(${JSON.stringify(project.workspace.root)}),configSchema.parse({version:1,llm:{model:"test"}}));
    s.launch({executable:process.execPath,args:["-e","console.log(process.pid);setInterval(()=>{},1000)"]},new AbortController().signal,
      (event,data)=>{if(event==="shell_output") console.log(data.text.trim())});
  `], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill("SIGKILL"); });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const pid = await new Promise<number>((resolve, reject) => {
    child.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
    child.once("exit", () => reject(new Error(`Harness exited before readiness: ${stderr}`)));
    child.once("error", reject);
  });

  assert.ok(pid > 0);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 143, stderr);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("large execution results fit model context without losing exit status, streams or task identity", () => {
  const output = { ok: true, exitCode: 0, signal: null, stdout: "a".repeat(64_000), stderr: "", output: "a".repeat(64_000), truncated: false };
  for (const value of [output, { id: "task-id", kind: "shell", status: "completed", result: output }]) {
    const serialized = serializeToolResult(value);
    assert.ok(serialized.length <= 48_000);
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.truncated, true);
    const result = parsed.result ?? parsed;
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.length > 0);
    assert.ok(result.output.length > 0);
    if ("result" in value) assert.equal(parsed.id, "task-id");
  }
});

test("model command defaults honor a configured timeout below 30 seconds", async (t) => {
  const project = await fixture(t);
  project.config.execution.maxTimeoutMs = 500;
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const tool = createTools(project.workspace, project.config, { write: false, commands: false, execution: true }, session)
    .find((tool) => tool.name === "exec_command")!;
  const action = await tool.prepare({ shell: "true" });
  assert.equal(action.details.timeoutMs, 500);
  const result = await action.execute(signal()) as { ok: boolean };
  assert.equal(result.ok, true);
  await assert.rejects(tool.prepare({ shell: "true", timeoutMs: 501 }));
});

test("cancellation escalates to KILL when an approved child ignores TERM", async (t) => {
  const project = await fixture(t);
  const controller = new AbortController();
  let pid = 0;
  const result = await executeProcess(project.workspace, project.config.execution, {
    executable: process.execPath, args: ["-e", "process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],
  }, controller.signal, (_stream, text) => { pid = Number(text.trim()); controller.abort(new Error("stop")); });
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.ok, false);
  assert.match(result.error!, /cancelled/);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("concurrent close calls share cleanup completion instead of returning before jobs stop", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  const task = session.launch({ shell: "sleep 10" }, signal());
  const first = session.close();
  const second = session.close();
  assert.equal(first, second);
  await second;
  assert.equal(session.tasks.read(task.id).status, "cancelled");
});

test("background output survives turn-log closure and raw output is never persisted in event logs", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  const observed: string[] = [];
  const log = await createEventLog(project.workspace.root, (event, data) => {
    if (event === "shell_output") observed.push(String(data?.text));
  });
  t.after(() => log.close());
  log.emit("shell_output", { taskId: "test", stream: "stdout", text: "private output before closure" });
  const result = await run(project, options(scripted([
    call("exec_command", { executable: process.execPath, args: ["-e", "setTimeout(()=>console.log('private output after closure'),200)"], background: true }),
    final("Started"),
  ]), { session, emit: log.emit, permissions: { write: false, commands: false, execution: true }, approve: async () => true }));
  assert.equal(result.status, "completed", result.text);
  log.close();
  const task = await session.tasks.wait(session.tasks.list()[0]!.id);
  assert.equal(task.status, "completed");
  assert.match(JSON.stringify(task.result), /private output after closure/);
  assert.equal(observed.length, 2);
  assert.ok(!(await readFile(path.join(project.workspace.root, log.path), "utf8")).includes("private output"));
  assert.throws(() => log.emit("run_started"), /closed/);
});
