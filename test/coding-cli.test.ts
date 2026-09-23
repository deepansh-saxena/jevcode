import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const cli = path.resolve("src/cli.ts");
const suitePath = path.resolve("examples/coding-benchmark.json");

test("coding preflight CLI requires consent and runs offline without an initialized project", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jev-preflight-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const args = ["--import", "tsx", cli, "benchmark-code", suitePath, "--cwd", root, "--preflight"];
  const env = { PATH: process.env.PATH, HOME: root };
  await assert.rejects(exec(process.execPath, args, { env }), (error: unknown) => {
    assert.ok(error instanceof Error && "stderr" in error);
    assert.match(String(error.stderr), /explicitly consent.*--allow-verifier-code/);
    return true;
  });
  const { stdout } = await exec(process.execPath, [...args, "--allow-verifier-code"], { env });
  const result = JSON.parse(stdout) as { valid: boolean; tasks: { valid: boolean }[] };
  assert.equal(result.valid, true);
  assert.equal(result.tasks.length, 3);
  assert.ok(result.tasks.every((task) => task.valid));
  await assert.rejects(readFile(path.join(root, ".jev/config.json")), /ENOENT/);
});

test("coding preflight reports invalid bug reproduction as a failing process without provider access", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "jev-invalid-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suite = JSON.parse(await readFile(suitePath, "utf8"));
  suite.tasks = [suite.tasks[0]];
  suite.tasks[0].checks[0].code = "throw new Error('not an assertion failure')";
  await writeFile(path.join(root, "suite.json"), JSON.stringify(suite));
  await assert.rejects(exec(process.execPath, ["--import", "tsx", cli, "benchmark-code",
    "suite.json", "--cwd", root, "--preflight", "--allow-verifier-code"],
  { env: { PATH: process.env.PATH, HOME: root } }), (error: unknown) => {
    assert.ok(error instanceof Error && "code" in error && "stdout" in error);
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(String(error.stdout)).valid, false);
    return true;
  });
});
