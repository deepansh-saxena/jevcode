import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { initialize } from "../src/init.js";
import { loadProject } from "../src/registry.js";
import { ensureJevSetup } from "../src/jev-cli.js";
import { fixture, server, requestBody } from "./helpers.js";

const exec = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const skip = process.platform !== "darwin" || !existsSync("/usr/bin/python3");
async function pending(project: Awaited<ReturnType<typeof fixture>>) {
  project.config.jev.setupComplete = false;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
}

test("new initialization requires a Jev decision without silently granting sharing consent", async (t) => {
  const parent = await fixture(t);
  const root = path.join(parent.workspace.root, "new-project");
  await mkdir(root);
  await initialize(root);
  const project = await loadProject(root, { globalRoot: null });
  assert.equal(project.config.jev.setupComplete, false);
  assert.equal(project.config.jev.mode, "off");
  assert.equal(project.config.jev.allowDataSharing, false);
});

test("noninteractive first use fails explicitly; --jev-off is session-only and cannot bypass guardrails", async (t) => {
  const project = await fixture(t);
  await pending(project);
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "serve", "--cwd", project.workspace.root],
    { env: { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake" }, timeout: 10_000 }), /Jev setup is required/);
  const running = exec(process.execPath, ["--import", "tsx", cli, "serve", "--cwd", project.workspace.root, "--jev-off"],
    { env: { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake" }, timeout: 10_000 });
  running.child.stdin?.end();
  const result = await running;
  assert.equal(JSON.parse(result.stdout.trim()).type, "ready");
  assert.equal((await loadProject(project.workspace.root, { globalRoot: null })).config.jev.setupComplete, false);
  project.config.jev.guardrail = "mutations";
  project.config.jev.allowDataSharing = true;
  await assert.rejects(ensureJevSetup(project, true), /cannot bypass/);
});

test("legacy and explicit workspace off choices are preserved without reading credentials or making requests", async (t) => {
  const project = await fixture(t);
  delete project.config.jev.setupComplete;
  await ensureJevSetup(project, false, false);
  assert.equal(project.config.jev.mode, "off");
  project.config.jev.setupComplete = true;
  await ensureJevSetup(project, false, false);
  assert.equal(project.config.jev.mode, "off");
});

test("completed setup with a missing key blocks noninteractive coding instead of silently routing without Jev", async (t) => {
  const project = await fixture(t);
  project.config.jev.mode = "on";
  project.config.jev.allowDataSharing = true;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake" };
  delete env.TYPESAFE_API_KEY;
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "serve", "--cwd", project.workspace.root],
    { env, timeout: 10_000 }), /Jev setup is required/);
  assert.equal((await loadProject(project.workspace.root, { globalRoot: null })).config.jev.mode, "on");
});

test("declining first-run data sharing leaves setup pending and makes no Jev request", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  project.config.jev.endpoint = await server(t, (_request, response) => {
    requests++;
    response.end("{}");
  });
  await pending(project);
  await assert.rejects(exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--plain",
  ], { env: { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake", TYPESAFE_API_KEY: "SYNTHETIC_JEV_KEY",
    JEV_PTY_PROMPTS: JSON.stringify([
      ["Jev setup [on/off] (default: on):", "\n"], ["Enable this data sharing? [yes/no]", "no\n"],
    ]),
  }, timeout: 20_000 }), (error: unknown) => {
    assert.ok(error instanceof Error && "stdout" in error);
    assert.match(String(error.stdout), /consent was not granted/);
    assert.doesNotMatch(String(error.stdout), /SYNTHETIC_JEV_KEY/);
    return true;
  });
  assert.equal(requests, 0);
  const config = (await loadProject(project.workspace.root, { globalRoot: null })).config;
  assert.equal(config.jev.mode, "off");
  assert.equal(config.jev.setupComplete, false);
  assert.equal(config.jev.allowDataSharing, false);
});

test("first-run Enter defaults to Jev on after consent and successful key validation", { skip }, async (t) => {
  const project = await fixture(t);
  let requests = 0;
  project.config.jev.endpoint = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      requests++;
      assert.deepEqual(body.state, { purpose: "connection test" });
      response.end(JSON.stringify({ model: "jev-test", answers: { ready: { type: "noul", noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await pending(project);
  const result = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--plain",
  ], { env: { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake", TYPESAFE_API_KEY: "SYNTHETIC_JEV_KEY",
    JEV_PTY_PROMPTS: JSON.stringify([
      ["Jev setup [on/off] (default: on):", "\n"], ["Enable this data sharing? [yes/no]", "yes\n"],
      ["Routing mode [on/shadow]:", "\n"], ["jevcode>", "/exit\n"],
    ]),
  }, timeout: 20_000 });
  assert.equal(requests, 1);
  assert.doesNotMatch(result.stdout, /SYNTHETIC_JEV_KEY/);
  const config = (await loadProject(project.workspace.root, { globalRoot: null })).config;
  assert.equal(config.jev.mode, "on");
  assert.equal(config.jev.setupComplete, true);
  assert.equal(config.jev.allowDataSharing, true);
  assert.equal(config.jev.guardrail, "off");
});

test("first-run explicit off persists without an API key and does not prompt again", { skip }, async (t) => {
  const project = await fixture(t);
  await pending(project);
  const env = { ...process.env, HOME: project.workspace.root, OPENAI_API_KEY: "fake",
    JEV_PTY_PROMPTS: JSON.stringify([["Jev setup [on/off] (default: on):", "off\n"], ["jevcode>", "/exit\n"]]) };
  await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--plain",
  ], { env, timeout: 20_000 });
  const config = (await loadProject(project.workspace.root, { globalRoot: null })).config;
  assert.equal(config.jev.mode, "off");
  assert.equal(config.jev.setupComplete, true);
  assert.equal(config.jev.allowDataSharing, false);
  const again = await exec("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", cli, "--cwd", project.workspace.root, "--plain",
  ], { env: { ...env, JEV_PTY_PROMPTS: JSON.stringify([["jevcode>", "/exit\n"]]) }, timeout: 20_000 });
  assert.doesNotMatch(again.stdout, /Jev setup \[on\/off\]/);
});
