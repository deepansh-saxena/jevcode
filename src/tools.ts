import { constants } from "node:fs";
import { mkdir, open, rename, unlink, stat, link } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Config, ToolName } from "./config.js";
import { BlockedError, isMissing } from "./errors.js";
import type { ToolSpec } from "./llm.js";
import { digest, readText, Workspace } from "./workspace.js";

export interface PreparedAction {
  name: ToolName;
  mutating: boolean;
  details: Record<string, unknown>;
  execute: (signal: AbortSignal) => Promise<unknown>;
}
export interface Tool {
  name: ToolName;
  description: string;
  schema: z.ZodType;
  prepare: (input: unknown) => Promise<PreparedAction>;
}
export interface Permissions {
  write: boolean;
  commands: boolean;
}
const filepath = z.string().min(1).max(1024);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const listSchema = z.object({ directory: filepath.default(".") }).strict();
const readSchema = z.object({
  path: filepath, startLine: z.number().int().min(1).default(1),
  lineCount: z.number().int().min(1).max(500).default(200),
}).strict();
const searchSchema = z.object({
  text: z.string().min(1).max(500), directory: filepath.default("."),
}).strict();
const writeSchema = z.object({
  path: filepath, content: z.string().max(64_000), expectedHash: hash.nullable(),
}).strict();
const replaceSchema = z.object({
  path: filepath, oldText: z.string().min(1).max(64_000),
  newText: z.string().max(64_000), expectedHash: hash,
}).strict();
const commandInput = z.object({ commandId: z.string().min(1).max(64) }).strict();

async function currentHash(workspace: Workspace, relative: string): Promise<string | null> {
  try {
    return digest(await readText(await workspace.path(relative, true)));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function checkVersion(workspace: Workspace, relative: string, expected: string | null): Promise<void> {
  if (await currentHash(workspace, relative) !== expected) {
    throw new Error("File changed or expectedHash is incorrect; read the file again before editing");
  }
}

async function writeVersion(
  workspace: Workspace, relative: string, content: string, expected: string | null, signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  const target = await workspace.path(relative, true);
  await checkVersion(workspace, relative, expected);
  await mkdir(path.dirname(target), { recursive: true });
  await workspace.path(relative, true);
  const mode = expected === null ? 0o600 : (await stat(target)).mode & 0o777;
  const temporary = path.join(path.dirname(target), `.jev-write-${randomUUID()}`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await file.writeFile(content);
    } finally {
      await file.close();
    }
    signal.throwIfAborted();
    await workspace.path(relative, true);
    await checkVersion(workspace, relative, expected);
    if (expected === null) await link(temporary, target);
    else await rename(temporary, target);
  } finally {
    try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
  }
  return { path: relative, sha256: digest(content), bytesWritten: Buffer.byteLength(content) };
}

export async function executeCommand(
  workspace: Workspace, command: Config["commands"][string], signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const child = spawn(command.executable, command.args, {
      cwd: workspace.root, env, shell: false, detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          failure ??= error instanceof Error ? error : new Error("Failed to terminate command");
        }
      }
    };
    const stop = (message: string): void => {
      if (failure) return;
      failure = new Error(message);
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 500);
    };
    const onAbort = (): void => stop("Command cancelled");
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("Command exceeded its deadline"), command.timeoutMs);
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > 64_000) stop("Command exceeded the output limit");
      else chunks.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => { failure = error; });
    child.on("close", (code, terminatedBy) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", onAbort);
      // Commands may spawn descendants; do not leave their process group running.
      kill("SIGKILL");
      if (failure) reject(failure);
      else resolve({ ok: code === 0, exitCode: code, signal: terminatedBy, output: Buffer.concat(chunks).toString("utf8") });
    });
    if (signal.aborted) onAbort();
  });
}

export function createTools(workspace: Workspace, config: Config, permissions: Permissions): Tool[] {
  const tools: Tool[] = [
    {
      name: "list_files", description: "List up to 500 accessible workspace files recursively. Excludes protected paths and symbolic links.",
      schema: listSchema,
      async prepare(input) {
        const args = listSchema.parse(input);
        await workspace.path(args.directory);
        return { name: "list_files", mutating: false, details: args, execute: async () => workspace.files(args.directory) };
      },
    },
    {
      name: "read_file", description: "Read numbered lines from a UTF-8 file. Returns a SHA-256 hash of the complete file for safe edits.",
      schema: readSchema,
      async prepare(input) {
        const args = readSchema.parse(input);
        await workspace.path(args.path);
        return {
          name: "read_file", mutating: false, details: args,
          async execute() {
            const content = await workspace.read(args.path);
            const lines = content.split("\n");
            const selected = lines.slice(args.startLine - 1, args.startLine - 1 + args.lineCount);
            let rendered = selected.map((line, index) => `${args.startLine + index}: ${line}`).join("\n");
            const truncated = rendered.length > 32_000 || args.startLine - 1 + selected.length < lines.length;
            rendered = rendered.slice(0, 32_000);
            return { path: args.path, sha256: digest(content), totalLines: lines.length, truncated, content: rendered };
          },
        };
      },
    },
    {
      name: "search_files", description: "Search accessible text files for a literal, case-sensitive string. Returns up to 100 matching lines.",
      schema: searchSchema,
      async prepare(input) {
        const args = searchSchema.parse(input);
        await workspace.path(args.directory);
        return {
          name: "search_files", mutating: false, details: args,
          async execute(signal) {
            const listing = await workspace.files(args.directory);
            const matches: { path: string; line: number; text: string }[] = [];
            const skipped: { path: string; reason: string }[] = [];
            for (const filename of listing.files) {
              signal.throwIfAborted();
              let content: string;
              try {
                content = await workspace.read(filename);
              } catch (error) {
                if (error instanceof BlockedError) throw error;
                skipped.push({ path: filename, reason: error instanceof Error ? error.message : "Unreadable file" });
                continue;
              }
              for (const [index, line] of content.split("\n").entries()) {
                if (line.includes(args.text)) {
                  matches.push({ path: filename, line: index + 1, text: line.slice(0, 200) });
                  if (matches.length === 100) return { matches, skipped, truncated: true };
                }
              }
            }
            return { matches, skipped, truncated: listing.truncated };
          },
        };
      },
    },
  ];
  if (permissions.write) {
    tools.push({
      name: "write_file",
      description: "Create or replace a UTF-8 file after user approval. expectedHash must match read_file's hash; use null only for a new file. Creates parent directories.",
      schema: writeSchema,
      async prepare(input) {
        const args = writeSchema.parse(input);
        await checkVersion(workspace, args.path, args.expectedHash);
        return {
          name: "write_file", mutating: true, details: args,
          execute: (signal) => writeVersion(workspace, args.path, args.content, args.expectedHash, signal),
        };
      },
    }, {
      name: "replace_text",
      description: "Replace exactly one occurrence of oldText with newText after approval. Requires the latest complete-file SHA-256 hash.",
      schema: replaceSchema,
      async prepare(input) {
        const args = replaceSchema.parse(input);
        await checkVersion(workspace, args.path, args.expectedHash);
        const content = await workspace.read(args.path);
        const first = content.indexOf(args.oldText);
        if (first < 0 || content.indexOf(args.oldText, first + 1) !== -1) {
          throw new Error("oldText must occur exactly once");
        }
        const updated = content.slice(0, first) + args.newText + content.slice(first + args.oldText.length);
        if (Buffer.byteLength(updated) > 1_048_576) throw new Error("Edited file exceeds the file size limit");
        return {
          name: "replace_text", mutating: true, details: args,
          execute: (signal) => writeVersion(workspace, args.path, updated, args.expectedHash, signal),
        };
      },
    });
  }
  if (permissions.commands && Object.keys(config.commands).length) {
    tools.push({
      name: "run_command",
      description: `Execute one configured command after explicit user approval. No arbitrary shell or arguments. Commands: ${JSON.stringify(config.commands)}. Commands are NOT sandboxed.`,
      schema: commandInput,
      async prepare(input) {
        const args = commandInput.parse(input);
        const command = Object.hasOwn(config.commands, args.commandId) ? config.commands[args.commandId] : undefined;
        if (!command) throw new BlockedError("Unknown configured command");
        return {
          name: "run_command", mutating: true, details: { ...args, ...command, warning: "Runs project code with your OS permissions; not sandboxed." },
          execute: (signal) => executeCommand(workspace, command, signal),
        };
      },
    });
  }
  return tools;
}

export function toolSpecs(tools: Tool[]): ToolSpec[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name, description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { target: "draft-7" }),
    },
  }));
}
