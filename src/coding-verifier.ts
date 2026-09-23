import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { errorMessage } from "./errors.js";

export const verifierCheckSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  code: z.string().min(1).max(32_000),
}).strict();

export const verifierLimitsSchema = z.object({
  timeoutMs: z.number().int().min(100).max(30_000).default(3000),
  maxOutputBytes: z.number().int().min(1024).max(64_000).default(16_000),
}).strict().default({ timeoutMs: 3000, maxOutputBytes: 16_000 });

const resultSchema = z.object({
  checks: z.array(z.object({
    id: z.string(), status: z.enum(["passed", "assertion_failed", "error"]),
    error: z.string().max(2000).nullable(),
  }).strict()),
}).strict();

export interface Verification {
  status: "passed" | "failed" | "error" | "timeout" | "cancelled" | "output_limit";
  checks: z.infer<typeof resultSchema>["checks"];
  durationMs: number;
  error: string | null;
}

// This is a reproducibility boundary, NOT a security boundary. It runs only after
// explicit consent; neither node:vm nor a separate OS process is a sandbox.
const driver = String.raw`
"use strict";
const vm = require("node:vm");
const assert = require("node:assert/strict");
const path = require("node:path").posix;
const fs = require("node:fs");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const checks = [];
for (const check of input.checks) {
  try {
    const output = Object.freeze({
      log: (...args) => process.stderr.write(args.map(String).join(" ") + "\n"),
      error: (...args) => process.stderr.write(args.map(String).join(" ") + "\n")
    });
    const codeContext = vm.createContext({ console: output }, {
      codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate"
    });
    const cache = new Map();
    const load = (id, parent = "") => {
      if (!id.startsWith("./") && !id.startsWith("../")) throw new Error("Only relative fixture modules are available: " + id);
      const filename = path.normalize(path.join(path.dirname(parent || "root.cjs"), id));
      if (filename.startsWith("../") || path.isAbsolute(filename) || !Object.hasOwn(input.files, filename))
        throw new Error("Missing or forbidden fixture module: " + id);
      if (cache.has(filename)) return cache.get(filename).exports;
      const module = { exports: {} };
      cache.set(filename, module);
      const factory = new vm.Script("(function(module, exports, require) {\n" + input.files[filename] + "\n})", { filename })
        .runInContext(codeContext, { timeout: input.timeoutMs });
      // The outer process deadline also bounds calls to exported fixture functions.
      factory(module, module.exports, (next) => load(next, filename));
      return module.exports;
    };
    const assertions = Object.freeze({
      equal: (...args) => assert.equal(...args),
      deepEqual: (...args) => assert.deepEqual(...args),
      ok: (...args) => assert.ok(...args),
      throws: (...args) => assert.throws(...args)
    });
    const context = vm.createContext({ require: (id) => {
      if (id === "node:assert/strict") return assertions;
      return load(id);
    }, console: output }, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
    const result = new vm.Script("(function() {\n" + check.code + "\n})()", { filename: "acceptance-" + check.id + ".cjs" })
      .runInContext(context, { timeout: input.timeoutMs });
    if (result && typeof result.then === "function") throw new Error("Acceptance checks must be synchronous");
    checks.push({ id: check.id, status: "passed", error: null });
  } catch (error) {
    checks.push({ id: check.id, status: error instanceof assert.AssertionError ? "assertion_failed" : "error",
      error: String(error && error.message || error).slice(0, 2000) });
  }
}
process.stdout.write(JSON.stringify({ checks }));
`;

export async function verifyCodingFixture(
  files: Record<string, string>,
  checks: z.infer<typeof verifierCheckSchema>[],
  limits: z.infer<typeof verifierLimitsSchema> & { allowVerifierCode: true },
  signal: AbortSignal,
): Promise<Verification> {
  if (limits.allowVerifierCode !== true) throw new Error("Explicit consent is required to execute unsandboxed verifier code");
  const started = performance.now();
  const root = await mkdtemp(path.join(tmpdir(), "jev-code-verifier-"));
  const result = (status: Verification["status"], error: string | null,
    results: Verification["checks"] = []): Verification =>
    ({ status, error, checks: results, durationMs: Math.round(performance.now() - started) });
  try {
    if (signal.aborted) return result("cancelled", "Verification cancelled");
    return await new Promise<Verification>((resolve) => {
      const child = spawn(process.execPath, ["--max-old-space-size=64", "--input-type=commonjs", "-e", driver], {
        cwd: root, env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: { status: Verification["status"]; error: string } | undefined;
      const kill = (): void => {
        if (!child.pid) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            failure ??= { status: "error", error: errorMessage(error) };
          }
        }
      };
      const stop = (status: Verification["status"], error: string): void => {
        failure ??= { status, error };
        kill();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const abort = (): void => stop("cancelled", "Verification cancelled");
      const timer = setTimeout(() => stop("timeout", "Verifier exceeded its deadline"), limits.timeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      const collect = (destination: Buffer[], chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > limits.maxOutputBytes) stop("output_limit", "Verifier exceeded its output limit");
        else destination.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.on("error", (error) => { failure ??= { status: "error", error: errorMessage(error) }; });
      child.stdin.on("error", (error) => stop("error", `Verifier input failed: ${errorMessage(error)}`));
      child.on("close", (code) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        kill();
        if (failure) { resolve(result(failure.status, failure.error)); return; }
        if (code !== 0) {
          resolve(result("error", `Verifier exited ${code}: ${Buffer.concat(stderr).toString("utf8").slice(0, 2000)}`));
          return;
        }
        try {
          const parsed = resultSchema.parse(JSON.parse(Buffer.concat(stdout).toString("utf8")));
          if (JSON.stringify(parsed.checks.map((check) => check.id)) !== JSON.stringify(checks.map((check) => check.id))) {
            throw new Error("Verifier returned an unexpected check set");
          }
          const status = parsed.checks.some((check) => check.status === "error") ? "error" :
            parsed.checks.some((check) => check.status === "assertion_failed") ? "failed" : "passed";
          resolve(result(status, null, parsed.checks));
        } catch (error) { resolve(result("error", `Invalid verifier output: ${errorMessage(error).slice(0, 2000)}`)); }
      });
      child.stdin.end(JSON.stringify({ files, checks, timeoutMs: limits.timeoutMs }));
      if (signal.aborted) abort();
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}
