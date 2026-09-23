import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Config } from "./config.js";
import { BlockedError, errorMessage } from "./errors.js";
import type { Workspace } from "./workspace.js";

export interface ExecutionRequest {
  executable?: string | undefined;
  args?: string[] | undefined;
  shell?: string | undefined;
  cwd?: string;
  timeoutMs?: number;
  background?: boolean;
}
export interface ExecutionResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
  truncated: boolean;
  error?: string;
}
export type OutputListener = (stream: "stdout" | "stderr", text: string, result: ExecutionResult) => void;

function prefixByBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function cleanEnvironment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home,
    LANG: "C.UTF-8", ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
}

export async function validateExecution(workspace: Workspace, request: ExecutionRequest): Promise<string> {
  if ((request.executable !== undefined) === (request.shell !== undefined)) {
    throw new BlockedError("Specify exactly one executable or shell command");
  }
  if (request.shell !== undefined && request.args?.length) throw new BlockedError("Shell commands cannot also specify args");
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100)) {
    throw new BlockedError("Command timeout must be an integer of at least 100ms");
  }
  for (const value of [request.executable, request.shell, ...(request.args ?? [])]) {
    if (value?.includes("\0")) throw new BlockedError("Commands must not contain NUL bytes");
  }
  const cwd = await workspace.path(request.cwd ?? ".");
  if (!(await stat(cwd)).isDirectory()) throw new BlockedError("Command cwd must be a workspace directory");
  // Only explicit workspace executable paths can be guarded; shell text and arguments are arbitrary code.
  if (request.executable && !path.isAbsolute(request.executable) && request.executable.includes("/")) {
    const relative = path.posix.join(request.cwd ?? ".", request.executable);
    if (request.executable.split("/").includes("..")) throw new BlockedError("Executable parent traversal is not allowed");
    await workspace.path(relative);
  }
  return cwd;
}

async function removeContainer(executable: string, name: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["rm", "--force", name], { env, stdio: "ignore", shell: false });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Docker cleanup failed; inspect the named container with Docker before continuing"));
    });
  });
}

export async function executeProcess(workspace: Workspace, config: Config["execution"],
  request: ExecutionRequest, signal: AbortSignal, onOutput?: OutputListener): Promise<ExecutionResult> {
  signal.throwIfAborted();
  const cwd = await validateExecution(workspace, request);
  signal.throwIfAborted();
  if (process.platform === "win32") throw new BlockedError("Execution requires POSIX process-group cleanup; Windows is not supported");
  const home = await mkdtemp(path.join(tmpdir(), "jev-exec-"));
  const env = cleanEnvironment(home);
  const isolation = config.isolation;
  const name = `jev-${randomUUID()}`;
  let executable = request.executable ?? "/bin/sh";
  let args = request.shell === undefined ? (request.args ?? []) : ["-c", request.shell];
  let spawned = false;
  if (isolation.backend === "docker") {
    if (workspace.root.includes(",")) {
      await rm(home, { recursive: true, force: true });
      throw new BlockedError("Docker workspace paths containing commas are not supported");
    }
    executable = isolation.executable;
    args = ["run", "--pull=never", "--name", name, "--network=none", "--read-only",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1",
      "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--mount", `type=bind,src=${workspace.root},dst=/workspace`,
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
      "--workdir", path.posix.join("/workspace", request.cwd ?? "."),
      "--entrypoint", request.executable ?? "/bin/sh", isolation.image, ...args];
  }
  try {
    signal.throwIfAborted();
    const result = await new Promise<ExecutionResult>((resolve) => {
      const child = spawn(executable, args, { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const result: ExecutionResult = { ok: false, exitCode: null, signal: null, stdout: "", stderr: "", output: "", truncated: false };
      let bytes = 0;
      let storedBytes = 0;
      const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
      let stopped = false;
      let escalation: NodeJS.Timeout | undefined;
      const kill = (kind: NodeJS.Signals): void => {
        if (!child.pid) return;
        try { process.kill(-child.pid, kind); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) result.error ??= errorMessage(error);
        }
      };
      const stop = (reason: string): void => {
        result.error ??= reason;
        if (stopped) return;
        stopped = true;
        kill("SIGTERM");
        escalation = setTimeout(() => {
          kill("SIGKILL");
          child.stdout.destroy();
          child.stderr.destroy();
        }, 300);
      };
      const aborted = (): void => stop("Command cancelled");
      const exiting = (): void => kill("SIGKILL");
      process.once("exit", exiting);
      signal.addEventListener("abort", aborted, { once: true });
      const timer = setTimeout(() => stop("Command exceeded its deadline"), Math.min(request.timeoutMs ?? 30_000, config.maxTimeoutMs));
      const append = (stream: "stdout" | "stderr", text: string): void => {
        const accepted = prefixByBytes(text, Math.max(0, config.maxOutputBytes - storedBytes));
        storedBytes += Buffer.byteLength(accepted);
        result[stream] += accepted;
        result.output += accepted;
        if (text !== accepted || bytes > config.maxOutputBytes) {
          result.truncated = true;
          stop("Command exceeded the output limit");
        }
        if (accepted) {
          try { onOutput?.(stream, accepted, { ...result }); }
          catch (error) { stop(`Output observer failed: ${errorMessage(error)}`); }
        }
      };
      const collect = (stream: "stdout" | "stderr", chunk: Buffer): void => {
        const remaining = Math.max(0, config.maxOutputBytes - bytes);
        bytes += chunk.length;
        append(stream, decoders[stream].write(chunk.subarray(0, remaining)));
      };
      child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
      child.stdout.on("end", () => append("stdout", decoders.stdout.end()));
      child.stderr.on("end", () => append("stderr", decoders.stderr.end()));
      child.on("spawn", () => { spawned = true; if (signal.aborted) aborted(); });
      child.on("error", (error) => { result.error ??= errorMessage(error); });
      child.on("exit", () => {
        // A short-lived leader may leave descendants holding the pipes open.
        kill("SIGKILL");
      });
      child.on("close", (code, terminatedBy) => {
        clearTimeout(timer);
        clearTimeout(escalation);
        signal.removeEventListener("abort", aborted);
        process.removeListener("exit", exiting);
        kill("SIGKILL");
        result.exitCode = code;
        result.signal = terminatedBy;
        result.ok = code === 0 && !result.error;
        resolve(result);
      });
      if (signal.aborted) aborted();
    });
    if (isolation.backend === "docker" && spawned) {
      try { await removeContainer(isolation.executable, name, env); }
      catch (error) {
        result.ok = false;
        result.error = `${result.error ? `${result.error}; ` : ""}${errorMessage(error)} (container ${name})`;
      }
    }
    return result;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
