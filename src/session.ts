import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Project } from "./registry.js";
import { readText, resolvePath } from "./workspace.js";
import { toolCallSchema, type CodingModel, type Message } from "./llm.js";
import { isMissing } from "./errors.js";

const snapshotSchema = z.object({
  version: z.literal(1), root: z.string(), provider: z.string(), model: z.string(),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant", "tool"]), content: z.string().nullable(),
    tool_calls: z.array(toolCallSchema).optional(), tool_call_id: z.string().optional(),
  }).strict()).max(2_000),
  native: z.unknown().optional(),
}).strict();

async function sessionDirectory(project: Project, create: boolean): Promise<string> {
  const directory = await resolvePath(project.workspace.root, ".jev/sessions", create);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const relative of [".jev", ".jev/sessions"]) {
    const info = await lstat(await resolvePath(project.workspace.root, relative));
    if (!info.isDirectory() || (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error("Session directories must be owned by you and private (0700)");
    }
  }
  return directory;
}

export async function listSessions(project: Project): Promise<{
  sessions: { id: string; modifiedAt: string; bytes: number }[]; truncated: boolean;
}> {
  let directory: string;
  try { directory = await sessionDirectory(project, false); }
  catch (error) { if (isMissing(error)) return { sessions: [], truncated: false }; throw error; }
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json") &&
    z.string().uuid().safeParse(name.slice(0, -5)).success).sort();
  const sessions = await Promise.all(names.slice(0, 200).map(async (name) => {
    const info = await lstat(await resolvePath(project.workspace.root, `.jev/sessions/${name}`));
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error(`Session ${name}: expected a private, owned, unlinked regular file`);
    }
    return { id: name.slice(0, -5), modifiedAt: info.mtime.toISOString(), bytes: info.size };
  }));
  sessions.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { sessions, truncated: names.length > 200 };
}

export async function saveSession(project: Project, messages: Message[], model: CodingModel): Promise<string> {
  await sessionDirectory(project, true);
  const id = randomUUID();
  const content = JSON.stringify(snapshotSchema.parse({
    version: 1, root: project.workspace.root, provider: project.config.llm.provider, model: project.config.llm.model,
    messages, native: model.exportHistory?.(messages),
  }));
  if (Buffer.byteLength(content) > 8_000_000) throw new Error("Session snapshot exceeds 8 MB; start a new conversation");
  const filename = await resolvePath(project.workspace.root, `.jev/sessions/${id}.json`, true);
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  return id;
}

export async function restoreSession(project: Project, id: string, model: CodingModel): Promise<Message[]> {
  if (!z.string().uuid().safeParse(id).success) throw new Error("Resume requires a saved session UUID");
  await sessionDirectory(project, false);
  const filename = await resolvePath(project.workspace.root, `.jev/sessions/${id}.json`);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error("Session snapshots must be private (0600), owned by you, and not linked");
  }
  let snapshot: z.infer<typeof snapshotSchema>;
  try { snapshot = snapshotSchema.parse(JSON.parse(await readText(filename, 8_000_000))); }
  catch { throw new Error("Invalid or unreadable session snapshot; contents were not displayed"); }
  if (snapshot.root !== project.workspace.root || snapshot.provider !== project.config.llm.provider ||
    snapshot.model !== project.config.llm.model) throw new Error("Resume requires the original workspace, provider, and model");
  const pending = new Set<string>();
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.role === "system" && index !== 0) throw new Error("Invalid saved system-message position");
    if (message.role === "tool") {
      if (!message.tool_call_id || !pending.delete(message.tool_call_id)) throw new Error("Invalid saved tool result");
      try { JSON.parse(message.content ?? ""); } catch { throw new Error("Invalid saved tool-result JSON"); }
    } else {
      if (pending.size) throw new Error("Saved conversation has unresolved tool calls");
      if (message.tool_calls?.length && message.role !== "assistant") throw new Error("Invalid saved tool-call role");
      for (const call of message.tool_calls ?? []) {
        if (pending.has(call.id)) throw new Error("Duplicate saved tool call");
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error("Saved conversation has unresolved tool calls");
  const messages: Message[] = snapshot.messages.map((message) => ({
    role: message.role, content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  }));
  if (model.restoreHistory) {
    try { model.restoreHistory(messages, snapshot.native); }
    catch { throw new Error("Invalid saved provider history; start a new conversation"); }
  } else if (snapshot.native !== undefined) throw new Error("This adapter cannot restore the saved provider history");
  return messages;
}
