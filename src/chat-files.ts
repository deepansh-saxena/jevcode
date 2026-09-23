import { constants } from "node:fs";
import { mkdtemp, chmod, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Project } from "./registry.js";
import type { Message } from "./llm.js";
import { readText } from "./workspace.js";
import { terminalSafe } from "./terminal.js";

const exec = promisify(execFile);

export async function workspaceDiff(project: Project, signal: AbortSignal): Promise<string> {
  const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "--no-pager", "diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const options = { cwd: project.workspace.root, signal, env, maxBuffer: 1_000_000, timeout: 10_000 };
  const { stdout } = await exec("git", [...args, "--name-only", "-z", "HEAD", "--"], options);
  const safe: string[] = [];
  let omitted = 0;
  for (const relative of stdout.split("\0").filter(Boolean)) {
    try { await project.workspace.path(relative, true); safe.push(relative); }
    catch { omitted++; }
  }
  const diff = safe.length ? (await exec("git", [...args, "HEAD", "--", ...safe], options)).stdout : "";
  return `${diff || "No visible tracked changes against HEAD.\n"}${omitted ? `(${omitted} protected/unsafe paths omitted.)\n` : ""}`;
}

export function transcript(messages: Message[]): string {
  return messages.filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role.toUpperCase()}\n${terminalSafe(message.content ?? "")}` +
      (message.images?.length ? `\n[${message.images.length} image attachment(s); binary content omitted]` : ""))
    .join("\n\n") + "\n";
}

export async function exportTranscript(project: Project, relative: string, messages: Message[]): Promise<void> {
  const filename = await project.workspace.path(relative, true);
  const content = transcript(messages);
  if (Buffer.byteLength(content) > 8_000_000) throw new Error("Export exceeds 8 MB");
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

export async function composeInEditor(signal: AbortSignal, suspend: <T>(work: () => Promise<T>) => Promise<T>): Promise<string> {
  const binary = process.env.JEV_EDITOR;
  if (!binary || !path.isAbsolute(binary)) throw new Error("Set JEV_EDITOR to an absolute executable path; optional JEV_EDITOR_ARGS is a JSON string array (for example [\"--wait\"])");
  let args: string[];
  try { args = z.array(z.string().max(1_000)).max(20).parse(JSON.parse(process.env.JEV_EDITOR_ARGS ?? "[]")); }
  catch { throw new Error("JEV_EDITOR_ARGS must be a JSON array of at most 20 string arguments"); }
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "jev-prompt-"));
  await chmod(directory, 0o700);
  const filename = path.join(directory, "prompt.txt");
  try {
    const file = await open(filename, "wx", 0o600);
    await file.close();
    await suspend(() => new Promise<void>((resolve, reject) => {
      const child = spawn(binary, [...args, filename], { stdio: "inherit", shell: false, signal });
      child.once("error", () => reject(new Error("Configured editor could not start or was cancelled")));
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Editor exited without success; prompt not submitted")));
    }));
    signal.throwIfAborted();
    const text = (await readText(filename, 48_000)).trim();
    if (!text) throw new Error("Editor returned an empty prompt");
    return text;
  } finally { await rm(filename, { force: true }); await rm(directory, { recursive: true, force: true }); }
}
