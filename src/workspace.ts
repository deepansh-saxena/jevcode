import { constants } from "node:fs";
import { open, lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { BlockedError, isMissing } from "./errors.js";

export const MAX_FILE_BYTES = 1_048_576;
const hidden = new Set([
  ".git", ".jev", ".jev-code", ".claude", "node_modules", ".ssh", ".aws", ".gnupg",
  ".npmrc", ".netrc", ".pypirc", "id_rsa", "id_ed25519",
]);

export function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function excluded(relative: string, extra: string[] = []): boolean {
  const parts = relative.toLowerCase().split(/[\\/]/);
  return parts.some((part) => hidden.has(part) || part.startsWith(".jev-write-") || /^\.env($|\.)/i.test(part) ||
    /\.(pem|key|p12|pfx)$/i.test(part)) ||
    extra.some((prefix) => relative.toLowerCase() === prefix.toLowerCase() ||
      relative.toLowerCase().startsWith(`${prefix.toLowerCase()}/`));
}

export async function resolvePath(root: string, relative: string, allowMissing = false): Promise<string> {
  if (path.isAbsolute(relative) || relative.includes("\0") || relative.includes("\\")) {
    throw new BlockedError("Paths must be workspace-relative and use forward slashes");
  }
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new BlockedError("Parent traversal is not allowed");
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new BlockedError("Symbolic links are not allowed");
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Parent is not a directory");
    } catch (error) {
      if (allowMissing && isMissing(error)) return path.join(root, ...parts);
      throw error;
    }
  }
  return current;
}

export class Workspace {
  constructor(readonly root: string, readonly protectedPaths: string[] = []) {}

  static async create(root: string, protectedPaths: string[] = []): Promise<Workspace> {
    return new Workspace(await realpath(root), protectedPaths);
  }

  async path(relative: string, writing = false): Promise<string> {
    if (this.root.split(path.sep).some((part) => part.toLowerCase() === ".jev-code")) {
      throw new BlockedError("The credential directory cannot be used as an agent workspace");
    }
    const normalized = relative.split("/").filter((part) => part && part !== ".").join("/");
    if (excluded(normalized, this.protectedPaths) ||
      (writing && normalized.split("/").at(-1)?.toLowerCase() === "agents.md")) {
      throw new BlockedError("Access to this path is protected by workspace policy");
    }
    return resolvePath(this.root, relative, writing);
  }

  async read(relative: string): Promise<string> {
    return readText(await this.path(relative));
  }

  async files(directory = ".", max = 500): Promise<{ files: string[]; truncated: boolean }> {
    const start = await this.path(directory);
    const files: string[] = [];
    let truncated = false;
    let visitedDirectories = 0;
    const walk = async (absolute: string, depth: number): Promise<void> => {
      if (depth > 20 || ++visitedDirectories > 1000) { truncated = true; return; }
      const entries = await readdir(absolute, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const target = path.join(absolute, entry.name);
        const relative = path.relative(this.root, target).split(path.sep).join("/");
        if (entry.isSymbolicLink() || excluded(relative, this.protectedPaths)) continue;
        if (files.length >= max) { truncated = true; return; }
        if (entry.isDirectory()) await walk(target, depth + 1);
        else if (entry.isFile()) files.push(relative);
      }
    };
    await walk(start, 0);
    return { files, truncated };
  }
}

export async function readText(filename: string, maxBytes = MAX_FILE_BYTES): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file");
    if (stat.nlink > 1) throw new BlockedError("Hard-linked files are not supported");
    if (stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    const content = buffer.subarray(0, bytes).toString("utf8");
    if (content.includes("\0")) throw new Error("Binary files are not supported");
    return content;
  } finally {
    await file.close();
  }
}
