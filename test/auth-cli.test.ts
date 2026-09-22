import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fixture, server, requestBody } from "./helpers.js";
import { writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const exec = promisify(execFile);
const cli = path.resolve("src/cli.ts");

test("real OAuth worker handles device login, refresh, failure and cancellation without network access", async () => {
  const result = await exec(process.execPath, [
    "--import", "tsx", "--import", path.resolve("test/fixtures/oauth-fetch.ts"),
    path.resolve("test/fixtures/auth-driver-runner.ts"),
  ], { timeout: 20_000 });
  assert.match(result.stdout, /checks passed/);
  assert.ok(!result.stdout.includes("fake-copilot-access"));
  assert.ok(!result.stderr.includes("SENSITIVE_PROVIDER_RESPONSE"));
});

test("login requires a terminal rather than collecting tokens from pipes", async (t) => {
  const project = await fixture(t);
  try {
    await exec(process.execPath, ["--import", "tsx", cli, "login", "openai", "--cwd", project.workspace.root]);
    assert.fail("Expected login to refuse a noninteractive session");
  } catch (error) {
    assert.ok(error instanceof Error && "stderr" in error);
    assert.match(String(error.stderr), /interactive terminal/);
  }
});

test("CLI catalog discovery works without login and provider/model overrides retain API-key mode", async (t) => {
  const project = await fixture(t);
  const catalog = await exec(process.execPath, ["--import", "tsx", cli, "models", "openai"]);
  assert.match(catalog.stdout, /gpt-5.5/);
  assert.match(catalog.stderr, /not a live account model list/);
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.equal(body.model, "override-model");
      response.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "API-key path" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }));
    });
  });
  project.config.llm.provider = "github-copilot";
  project.config.llm.baseUrl = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const result = await exec(process.execPath, [
    "--import", "tsx", cli, "run", "--cwd", project.workspace.root, "--provider", "api",
    "--model", "override-model", "--json", "Say hello",
  ], { env: { ...process.env, OPENAI_API_KEY: "fake-key" } });
  assert.equal(JSON.parse(result.stdout).status, "completed");
});

test("interactive login configures the workspace; status and logout do not reveal credentials", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/python3"),
}, async (t) => {
  const project = await fixture(t);
  const env = { ...process.env, HOME: project.workspace.root, JEV_PTY_SCENARIO: "login" };
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx",
    "--import", path.resolve("test/fixtures/oauth-fetch.ts"), cli,
    "login", "copilot", "--cwd", project.workspace.root,
  ], { env, timeout: 12_000 });
  assert.match(result.stdout, /Logged in to copilot/);
  assert.ok(!result.stdout.includes("fake-copilot-access"));
  const config = JSON.parse(await readFile(path.join(project.workspace.root, ".jev/config.json"), "utf8"));
  assert.equal(config.llm.provider, "github-copilot");
  assert.equal(config.llm.model, "gpt-4.1");
  const status = await exec(process.execPath, ["--import", "tsx", cli, "auth", "status"], { env });
  assert.ok(JSON.parse(status.stdout).some((entry: { provider: string; loggedIn: boolean }) =>
    entry.provider === "github-copilot" && entry.loggedIn));
  assert.ok(!status.stdout.includes("fake-copilot-access"));
  await exec(process.execPath, ["--import", "tsx", cli, "logout", "copilot"], { env });
  const after = await exec(process.execPath, ["--import", "tsx", cli, "auth", "status"], { env });
  assert.ok(JSON.parse(after.stdout).every((entry: { loggedIn: boolean }) => !entry.loggedIn));
});
