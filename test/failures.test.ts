import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fixture, options, scripted, final, call, server } from "./helpers.js";
import { run } from "../src/runtime.js";
import { postJson } from "../src/http.js";
import { executeCommand } from "../src/tools.js";

test("malformed model arguments are reported without logging their contents", async (t) => {
  const project = await fixture(t);
  const malformed = call("read_file", {});
  malformed.message.tool_calls![0]!.function.arguments = "private-invalid-json";
  const events: unknown[] = [];
  const result = await run(project, options(scripted([malformed, final("Arguments were invalid.")]), {
    emit: (event, data) => events.push({ event, data }),
  }));
  assert.equal(result.status, "completed");
  assert.match(JSON.stringify(events), /not valid JSON/);
  assert.ok(!JSON.stringify(events).includes("private-invalid-json"));
});

test("malformed HTTP JSON never appears in error messages", async (t) => {
  const url = await server(t, (_request, response) => response.end("private response content"));
  await assert.rejects(postJson(url, "fake", {}, new AbortController().signal, 1000), {
    message: "API returned invalid JSON",
  });
});

test("Jev timeout falls back for routing but blocks a required guardrail", async (t) => {
  for (const guardrail of [false, true]) {
    const project = await fixture(t);
    const url = await server(t, () => {});
    Object.assign(project.config.jev, {
      allowDataSharing: true, endpoint: url, timeoutMs: 100,
      mode: guardrail ? "off" : "on", guardrail: guardrail ? "all" : "off",
    });
    const model = guardrail ? scripted([call("list_files", {})]) : scripted([final()]);
    const result = await run(project, options(model, { env: { TYPESAFE_API_KEY: "fake" } }));
    assert.equal(result.status, guardrail ? "blocked" : "completed");
    assert.equal(result.metrics.usageIncompleteRequests, 1);
  }
});

test("mandatory project guidance is loaded and remains independent of Jev", async (t) => {
  const project = await fixture(t);
  const { loadProject } = await import("../src/registry.js");
  await writeFile(path.join(project.workspace.root, "AGENTS.md"), "Use the local naming convention.");
  const reloaded = await loadProject(project.workspace.root, { globalRoot: null });
  const model = scripted([final()], (messages) => assert.match(messages[0]!.content!, /local naming convention/));
  assert.equal((await run(reloaded, options(model))).status, "completed");
});

test("file reads refuse special files without waiting for data", { skip: process.platform === "win32" }, async (t) => {
  const project = await fixture(t);
  await promisify(execFile)("mkfifo", [path.join(project.workspace.root, "pipe")]);
  await assert.rejects(project.workspace.read("pipe"), /regular file/);
});

test("commands support cancellation and do not inherit provider credentials", async (t) => {
  const project = await fixture(t);
  const result = await executeCommand(project.workspace, {
    description: "Check environment", executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], timeoutMs: 1000,
  }, new AbortController().signal) as { output: string };
  const keys = JSON.parse(result.output) as string[];
  assert.ok(keys.every((key) =>
    ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot", "__CF_USER_TEXT_ENCODING"].includes(key)));
  const controller = new AbortController();
  const operation = executeCommand(project.workspace, {
    description: "Wait", executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 5000,
  }, controller.signal);
  controller.abort();
  await assert.rejects(operation, /cancelled/);
});
