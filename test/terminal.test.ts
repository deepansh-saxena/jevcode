import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

for (const width of [40, 80]) {
  test(`login questions remain visible after redraw at ${width} columns and hidden input stays hidden`, {
    skip: process.platform !== "darwin" || !existsSync("/usr/bin/python3"),
  }, async () => {
    const { stdout } = await exec("/usr/bin/python3", [
      path.resolve("test/pty-approval.py"), process.execPath, "--import", "tsx",
      path.resolve("test/fixtures/terminal-prompts.ts"),
    ], {
      env: { ...process.env, JEV_PTY_SCENARIO: "terminal-prompts", JEV_PTY_COLUMNS: String(width) },
      timeout: 10_000,
    });
    assert.match(stdout, /Terminal input verified/);
    assert.ok(!stdout.includes("SYNTHETIC_HIDDEN_INPUT"));
  });
}
