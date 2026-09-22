import test from "node:test";
import assert from "node:assert/strict";
import { chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJevKey, removeJevKey, saveJevKey, normalizeJevKey } from "../src/jev-key.js";
import { fixture } from "./helpers.js";
import { server, requestBody } from "./helpers.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { loadProject } from "../src/registry.js";

test("Jev key storage is private, rejects unsafe inputs, and is separate from project configuration", async (t) => {
  const project = await fixture(t);
  const root = project.workspace.root;
  assert.equal(await readJevKey(root), undefined);
  await saveJevKey("synthetic-test-key", root);
  assert.equal(await readJevKey(root), "synthetic-test-key");
  await assert.rejects(saveJevKey("bad\nkey", root), /Invalid/);
  await assert.rejects(project.workspace.read(".jev-code/jev-key.json"), /protected/);
  if (process.platform !== "win32") {
    await chmod(path.join(root, ".jev-code/jev-key.json"), 0o644);
    await assert.rejects(readJevKey(root), /private/);
    await chmod(path.join(root, ".jev-code/jev-key.json"), 0o600);
  }
  await removeJevKey(root);
  assert.equal(await readJevKey(root), undefined);
  await writeFile(path.join(root, "outside.json"), '{"key":"outside"}');
  await symlink(path.join(root, "outside.json"), path.join(root, ".jev-code/jev-key.json"));
  await assert.rejects(readJevKey(root), /Symbolic/);
  await assert.rejects(saveJevKey("new", root), /Symbolic/);
});

test("Jev key normalization rejects header fragments without revealing them", () => {
  assert.equal(normalizeJevKey("  synthetic-key  \n"), "synthetic-key");
  for (const key of ["", "Bearer private-value", "Authorization: private-value", "'private-value'", "private\0value", "private\nvalue"]) {
    assert.throws(() => normalizeJevKey(key), (error: unknown) =>
      error instanceof Error && error.message.includes("Invalid Jev API key") && !error.message.includes("private-value"));
  }
});

test("interactive Jev setup validates a hidden key then persists consent and active mode without displaying it", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/python3"),
}, async (t) => {
  const project = await fixture(t);
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.equal(request.headers.authorization, "Bearer SYNTHETIC_JEV_KEY_VALUE");
      assert.deepEqual(body.state, { purpose: "connection test" });
      response.end(JSON.stringify({ model: "jev-test", answers: { ready: { type: "noul", noul: 1 } },
        usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  project.config.jev.endpoint = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([
      ["Enable this data sharing? [yes/no]", "Y\n"], ["Routing mode [on/shadow]:", "ON\n"],
      ["jev-key.json file? [yes/no]", "y\n"], ["Paste the replacement Jev API key (input hidden):", "  SYNTHETIC_JEV_KEY_VALUE  \n"],
    ]),
  };
  delete env.TYPESAFE_API_KEY;
  const result = await promisify(execFile)("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", path.resolve("src/cli.ts"),
    "jev", "setup", "--cwd", project.workspace.root,
  ], { env, timeout: 20_000 });
  assert.doesNotMatch(result.stdout, /SYNTHETIC_JEV_KEY_VALUE/);
  assert.match(result.stdout, /Jev routing on/);
  assert.match(result.stdout, /using the newly entered key/);
  assert.equal(await readJevKey(project.workspace.root), "SYNTHETIC_JEV_KEY_VALUE");
  const config = (await loadProject(project.workspace.root)).config;
  assert.equal(config.jev.allowDataSharing, true);
  assert.equal(config.jev.mode, "on");
  assert.equal(config.jev.guardrail, "off");
});

test("failed Jev connection tests do not save keys or activate routing", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/python3"),
}, async (t) => {
  const project = await fixture(t);
  const url = await server(t, (_request, response) => { response.writeHead(401); response.end('{"private":"PRIVATE_PROVIDER_RESPONSE"}'); });
  project.config.jev.endpoint = url;
  await writeFile(path.join(project.workspace.root, ".jev/config.json"), JSON.stringify(project.config));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: project.workspace.root,
    JEV_PTY_PROMPTS: JSON.stringify([
      ["Enable this data sharing? [yes/no]", "yes\n"], ["Routing mode [on/shadow]:", "on\n"],
      ["jev-key.json file? [yes/no]", "yes\n"], ["Paste the replacement Jev API key (input hidden):", "SYNTHETIC_JEV_KEY_VALUE\n"],
    ]),
  };
  delete env.TYPESAFE_API_KEY;
  await assert.rejects(promisify(execFile)("/usr/bin/python3", [
    path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx", path.resolve("src/cli.ts"),
    "jev", "setup", "--cwd", project.workspace.root,
  ], { env, timeout: 20_000 }), (error: unknown) => {
    assert.ok(error instanceof Error && "stdout" in error);
    assert.doesNotMatch(String(error.stdout), /SYNTHETIC_JEV_KEY_VALUE|PRIVATE_PROVIDER_RESPONSE/);
    assert.match(String(error.stdout), /401/);
    return true;
  });
  assert.equal(await readJevKey(project.workspace.root), undefined);
  assert.equal((await loadProject(project.workspace.root)).config.jev.mode, "off");
});
