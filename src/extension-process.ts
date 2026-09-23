import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionCommand } from "./extension-config.js";

export const EXTENSION_OUTPUT_LIMIT = 256_000;
export const EXTENSION_INPUT_LIMIT = 64_000;

export function referenceEnvironment(references: Record<string, string>, environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, reference] of Object.entries(references)) {
    const value = environment[reference];
    if (value === undefined) throw new Error(`Missing environment reference: ${reference}`);
    result[key] = value;
  }
  return result;
}

export function commandEnvironment(command: ExtensionCommand, environment: NodeJS.ProcessEnv): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const key of ["PATH", "TMPDIR", "TEMP", "SystemRoot", "LANG"]) {
    if (environment[key]) inherited[key] = environment[key];
  }
  return { ...inherited, ...referenceEnvironment(command.env, environment) };
}

function stopGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

// SDK protocol + codec, with an owned transport so environment inheritance, process
// groups, and byte limits cannot be loosened by the SDK's stdio defaults.
export class BoundedStdioTransport implements Transport {
  onclose?: NonNullable<Transport["onclose"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  onmessage?: NonNullable<Transport["onmessage"]>;
  private child?: ChildProcessWithoutNullStreams;
  private closing?: Promise<void>;
  private totalBytes = 0;
  private buffer = new ReadBuffer({ maxBufferSize: EXTENSION_OUTPUT_LIMIT });

  constructor(private command: ExtensionCommand, private cwd: string, private environment: NodeJS.ProcessEnv) {}

  async start(): Promise<void> {
    if (this.child || this.closing) throw new Error("Transport already started or closed");
    const child = spawn(this.command.executable, this.command.args, {
      cwd: this.cwd, env: commandEnvironment(this.command, this.environment), shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const fail = (error: Error): void => {
      this.onerror?.(error);
      void this.close().catch((closeError: unknown) => this.onerror?.(closeError instanceof Error ? closeError : new Error("MCP close failed")));
    };
    const count = (chunk: Buffer): boolean => {
      this.totalBytes += chunk.length;
      if (this.totalBytes > 8 * EXTENSION_OUTPUT_LIMIT) { fail(new Error("MCP connection output budget exceeded; reconnect explicitly")); return false; }
      return true;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!count(chunk)) return;
      try {
        this.buffer.append(chunk);
        for (let message = this.buffer.readMessage(); message !== null; message = this.buffer.readMessage()) this.onmessage?.(message);
      } catch { fail(new Error("Invalid or oversized MCP stdio message")); }
    });
    child.stderr.on("data", (chunk: Buffer) => { count(chunk); }); // Never forward arbitrary server stderr (may contain secrets).
    child.stdin.on("error", () => fail(new Error("MCP stdin closed")));
    child.stdout.on("error", () => fail(new Error("MCP stdout failed")));
    child.on("close", () => {
      try { stopGroup(child, "SIGKILL"); } catch (error) { this.onerror?.(error instanceof Error ? error : new Error("MCP cleanup failed")); }
      this.onclose?.();
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => { const error = new Error("MCP executable failed to start"); fail(error); reject(error); });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.closing) throw new Error("MCP transport is disconnected");
    const text = serializeMessage(message);
    if (Buffer.byteLength(text) > EXTENSION_INPUT_LIMIT) throw new Error("MCP request exceeds the input limit");
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(text, (error) => error ? reject(new Error("MCP write failed")) : resolve()));
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const child = this.child;
    this.closing = (async () => {
      if (!child) return;
      child.stdin.destroy();
      stopGroup(child, "SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        const timer = setTimeout(resolve, 300);
        child.once("close", () => { clearTimeout(timer); resolve(); });
      });
      stopGroup(child, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      this.buffer.clear();
    })();
    return this.closing;
  }
}

export async function runHookProcess(command: ExtensionCommand, cwd: string, environment: NodeJS.ProcessEnv,
  input: unknown, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const payload = `${JSON.stringify(input)}\n`;
  if (Buffer.byteLength(payload) > EXTENSION_INPUT_LIMIT) throw new Error("Hook input exceeds the input limit");
  const env = commandEnvironment(command, environment);
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, { cwd, env, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      try { stopGroup(child, "SIGTERM"); } catch (cause) { failure = cause instanceof Error ? cause : error; }
      killTimer = setTimeout(() => {
        try { stopGroup(child, "SIGKILL"); } catch (cause) { failure = cause instanceof Error ? cause : error; }
        child.stdout.destroy(); child.stderr.destroy();
      }, 300);
    };
    const abort = (): void => stop(new Error("Hook cancelled"));
    const timer = setTimeout(() => stop(new Error("Hook deadline exceeded")), command.timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    const collect = (chunk: Buffer, stdout: boolean): void => {
      size += chunk.length;
      if (size > EXTENSION_OUTPUT_LIMIT) stop(new Error("Hook output limit exceeded"));
      else if (stdout) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.stdin.on("error", () => stop(new Error("Hook rejected input")));
    child.on("error", () => stop(new Error("Hook executable failed to start")));
    child.on("close", (code) => {
      clearTimeout(timer); clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      try { stopGroup(child, "SIGKILL"); } catch (error) { failure = error instanceof Error ? error : new Error("Hook cleanup failed"); }
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Hook exited with status ${code}; stderr withheld`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(payload);
    if (signal.aborted) abort();
  });
}
