import { z } from "zod";
import type { Config, ToolName } from "./config.js";
import { executionSchema } from "./config.js";
import { BlockedError } from "./errors.js";
import type { ToolSpec } from "./llm.js";
import { checkVersion, digest, writeVersion, Workspace } from "./workspace.js";
import { executeProcess, validateExecution } from "./execution.js";
import type { ExecutionSession } from "./lifecycle.js";
import type { Emit } from "./events.js";

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
  inputSchema?: Record<string, unknown>;
  prepare: (input: unknown) => Promise<PreparedAction>;
}
export interface Permissions {
  write: boolean;
  commands: boolean;
  external?: boolean;
  execution?: boolean;
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
const executionInput = z.object({
  executable: z.string().min(1).max(4096).optional(),
  args: z.array(z.string().max(16_000)).max(100).optional(),
  shell: z.string().min(1).max(16_000).optional(),
  cwd: filepath.default("."),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(30_000),
  background: z.boolean().default(false),
}).strict();

export async function executeCommand(
  workspace: Workspace, command: Config["commands"][string], signal: AbortSignal,
): Promise<unknown> {
  const result = await executeProcess(workspace, executionSchema.parse({}), command, signal).catch((error: unknown) => {
    if (signal.aborted) throw new Error("Command cancelled");
    throw error;
  });
  if (result.error) throw new Error(result.error);
  return { ok: result.ok, exitCode: result.exitCode, signal: result.signal, output: result.output };
}

export function createTools(workspace: Workspace, config: Config, permissions: Permissions,
  session?: ExecutionSession, emit?: Emit): Tool[] {
  const configuredExecutionInput = executionInput.extend({
    timeoutMs: z.number().int().min(100).max(config.execution.maxTimeoutMs).default(Math.min(30_000, config.execution.maxTimeoutMs)),
  });
  const edit = (relative: string, content: string, expected: string | null, signal: AbortSignal): Promise<unknown> =>
    session ? session.checkpoints.edit(relative, content, expected, signal) : writeVersion(workspace, relative, content, expected, signal);
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
          execute: (signal) => edit(args.path, args.content, args.expectedHash, signal),
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
          execute: (signal) => edit(args.path, updated, args.expectedHash, signal),
        };
      },
    });
  }
  if (permissions.commands && Object.keys(config.commands).length) {
    tools.push({
      name: "run_command",
      description: `Execute one configured command after explicit user approval. No arbitrary shell or arguments. Commands: ${JSON.stringify(config.commands)}. Unsandboxed unless Docker isolation is explicitly configured.`,
      schema: commandInput,
      async prepare(input) {
        const args = commandInput.parse(input);
        const command = Object.hasOwn(config.commands, args.commandId) ? structuredClone(config.commands[args.commandId]) : undefined;
        if (!command) throw new BlockedError("Unknown configured command");
        const policy = structuredClone(config.execution);
        return {
          name: "run_command", mutating: true, details: { ...args, ...command, isolation: policy.isolation,
            warning: policy.isolation.backend === "none" ? "Runs project code with your OS permissions; not sandboxed." :
              "Runs in the configured Docker image, network disabled. The entire workspace is mounted writable, including protected files." },
          execute: (signal) => session ? session.execute(command, signal, emit, policy) : executeProcess(workspace, policy, command, signal),
        };
      },
    });
  }
  if (session) {
    if (permissions.execution) tools.push({
      name: "exec_command",
      description: "Run a proposed executable with args OR a shell command, only after fresh exact-action approval. Background jobs are attached, bounded and stopped on session exit; standalone runs stop them before returning. Unsandboxed unless Docker isolation is explicitly configured. cwd must be an accessible workspace directory. Shell/arguments can access files beyond tool path guards; no shell edits are checkpointed.",
      schema: configuredExecutionInput,
      async prepare(input) {
        const args = configuredExecutionInput.parse(input);
        await validateExecution(workspace, args);
        const policy = structuredClone(config.execution);
        return { name: "exec_command", mutating: true, details: { ...args, isolation: policy.isolation,
          warning: policy.isolation.backend === "none" ?
            "UNSANDBOXED: arbitrary code runs with your OS permissions. Path guards constrain cwd, not code or arguments. It can read/write outside the workspace, including credentials. Only explicitly inherited environment keys are supplied. Shell changes are NOT checkpointed." :
            "Docker isolation: network off, no home credentials, workspace-only host mount. ALL workspace files are mounted writable, including protected paths. No image is downloaded. Shell changes are NOT checkpointed.",
        }, execute: (signal) => session.execute(args, signal, emit, policy) };
      },
    });
    const idInput = z.object({ taskId: z.string().uuid() }).strict();
    for (const name of ["task_list", "task_read", "task_wait", "task_stop"] as const) tools.push({
      name, description: `${name}: inspect, await, or cancel an existing attached task. Does not launch work or request approval.`,
      schema: name === "task_list" ? z.object({}).strict() : idInput,
      async prepare(input) {
        const args = name === "task_list" ? z.object({}).strict().parse(input) : idInput.parse(input);
        return { name, mutating: false, details: args, async execute(signal) {
          if (name === "task_list") return session.tasks.list();
          const { taskId } = idInput.parse(args);
          if (name === "task_read") return session.tasks.read(taskId);
          if (name === "task_wait") return session.tasks.wait(taskId, signal);
          return session.tasks.stop(taskId);
        } };
      },
    });
    tools.push({
      name: "list_checkpoints", description: "List session-private checkpoints of harness edits only. Shell/external edits are not captured.",
      schema: z.object({}).strict(),
      async prepare(input) {
        z.object({}).strict().parse(input);
        return { name: "list_checkpoints", mutating: false, details: {}, async execute() { return session.checkpoints.list(); } };
      },
    });
    if (permissions.write) tools.push({
      name: "undo_edit", description: "Undo one harness edit after approval, only if the file still exactly matches its checkpoint. Never overwrites subsequent user or external changes.",
      schema: z.object({ checkpointId: z.string().uuid() }).strict(),
      async prepare(input) {
        const { checkpointId } = z.object({ checkpointId: z.string().uuid() }).strict().parse(input);
        return session.checkpoints.prepareUndo(checkpointId);
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
      parameters: tool.inputSchema ?? z.toJSONSchema(tool.schema, { target: "draft-7" }),
    },
  }));
}
