import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fixture, server, requestBody, call, final } from "./helpers.js";
import { OpenAICompatible } from "../src/llm.js";
import { createEventLog } from "../src/events.js";

const exec = promisify(execFile);

test("jevcode is the canonical executable and appears in CLI help", async () => {
  const manifest = JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as { bin: Record<string, string> };
  assert.equal(manifest.bin.jevcode, "dist/cli.js");
  assert.equal(manifest.bin["jev-code"], manifest.bin.jevcode);
  const { stdout } = await exec(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "--help"]);
  assert.match(stdout, /jevcode login <copilot\|openai>/);
  assert.match(stdout, /jevcode run /);
  assert.doesNotMatch(stdout, /jev-code (?:login|run)/);
});

test("OpenAI adapter uses Chat Completions, validates usage, and surfaces HTTP errors", async (t) => {
  const project = await fixture(t);
  let count = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fake-key");
      assert.equal(body.model, "test-model");
      assert.equal(body.max_completion_tokens, 4096);
      count++;
      if (count === 2) { response.end(JSON.stringify({ choices: [] })); return; }
      if (count === 3) { response.writeHead(401); response.end("private server error"); return; }
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      }));
    });
  });
  project.config.llm.baseUrl = `${url}/v1`;
  const client = new OpenAICompatible(project.config.llm, "fake-key");
  const invoke = () => client.complete([{ role: "user", content: "hello" }], [], "test-model", new AbortController().signal);
  assert.equal((await invoke()).message.content, "ok");
  await assert.rejects(invoke(), /token usage/);
  await assert.rejects(invoke(), /HTTP 401/);
});

test("CLI completes a real HTTP tool loop and writes a private metadata log", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "fixture.txt"), "local mock content");
  const responses = [call("read_file", { path: "fixture.txt" }), final("Read fixture.txt successfully.")];
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      if (requests === 1) assert.match(JSON.stringify(body.messages), /local mock content/);
      const completion = responses[requests++]!;
      response.end(JSON.stringify({
        choices: [{ message: completion.message, finish_reason: completion.finishReason }],
        usage: { prompt_tokens: completion.usage.inputTokens, completion_tokens: completion.usage.outputTokens },
      }));
    });
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const { stdout } = await exec(process.execPath, [
    "--import", "tsx", path.resolve("src/cli.ts"), "run", "--cwd", project.workspace.root, "--json", "Read fixture.txt",
  ], { cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "fake-local-key" } });
  const result = JSON.parse(stdout) as { status: string; text: string; eventLog: string; metrics: { turns: number } };
  assert.equal(result.status, "completed");
  assert.equal(result.metrics.turns, 2);
  assert.match(result.text, /successfully/);
  const log = await readFile(path.join(project.workspace.root, result.eventLog), "utf8");
  assert.match(log, /run_completed/);
  assert.ok(!log.includes("local mock content"));
  assert.ok(!log.includes("fake-local-key"));
});

test("CLI noninteractive mutations are denied with a nonzero exit code", async (t) => {
  const project = await fixture(t);
  const completion = call("write_file", { path: "no.txt", content: "no", expectedHash: null });
  const url = await server(t, (_request, response) => response.end(JSON.stringify({
    choices: [{ message: completion.message, finish_reason: completion.finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })));
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  try {
    await exec(process.execPath, [
      "--import", "tsx", path.resolve("src/cli.ts"), "run", "--cwd", project.workspace.root, "--write", "--json", "Create no.txt",
    ], { env: { ...process.env, OPENAI_API_KEY: "fake-local-key" } });
    assert.fail("Expected a nonzero CLI exit");
  } catch (error) {
    assert.ok(error instanceof Error && "stdout" in error && "code" in error);
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(String(error.stdout)).status, "blocked");
  }
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

test("event log persists metadata as JSONL", async (t) => {
  const project = await fixture(t);
  const log = await createEventLog(project.workspace.root);
  log.emit("test_event", { count: 1 });
  log.close();
  const line = JSON.parse((await readFile(path.join(project.workspace.root, log.path), "utf8")).trim()) as { event: string; runId: string };
  assert.equal(line.event, "test_event");
  assert.equal(line.runId, log.runId);
});

test("CLI interactive approval executes the displayed action", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/python3"),
}, async (t) => {
  const project = await fixture(t);
  const completions = [
    call("write_file", { path: "approved.txt", content: "approved through a terminal", expectedHash: null }),
    final("Created approved.txt"),
  ];
  let requests = 0;
  const url = await server(t, (_request, response) => {
    const completion = completions[requests++]!;
    response.end(JSON.stringify({
      choices: [{ message: completion.message, finish_reason: completion.finishReason }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const child = spawn("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", path.resolve("src/cli.ts"),
    "run", "--cwd", project.workspace.root, "--write", "Create approved.txt",
  ], {
    cwd: process.cwd(), env: { ...process.env, OPENAI_API_KEY: "fake-local-key" },
    stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(10_000),
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Interactive CLI failed: ${output}`)));
  });
  assert.match(output, /Type yes to execute this exact action:/);
  assert.equal(await project.workspace.read("approved.txt"), "approved through a terminal");
  assert.match(output, /completed/);
});
