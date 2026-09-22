import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isMissing } from "./errors.js";
import { readText, resolvePath } from "./workspace.js";

export function normalizeJevKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed || trimmed.length > 16_000 || /[\u0000-\u001f\u007f\s"'<>]/.test(trimmed) ||
    /^(?:Bearer\b|Authorization:)/i.test(trimmed)) {
    throw new Error("Invalid Jev API key. Enter only the key, without an Authorization/Bearer prefix, quotes, or internal whitespace.");
  }
  return trimmed;
}

async function directory(base: string, create: boolean): Promise<string> {
  const root = await realpath(base);
  const dir = await resolvePath(root, ".jev-code", create);
  if (create) await mkdir(dir, { mode: 0o700, recursive: true });
  const info = await lstat(await resolvePath(root, ".jev-code"));
  if (!info.isDirectory() || (process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
    throw new Error("Jev key directory must be private (0700) and owned by you");
  }
  return dir;
}

export async function readJevKey(base = homedir()): Promise<string | undefined> {
  try {
    const filename = await resolvePath(await directory(base, false), "jev-key.json");
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || (process.platform !== "win32" &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error("Jev key file must be private (0600), owned by you, and not linked");
    }
    let key: unknown;
    try { key = JSON.parse(await readText(filename, 32_000)).key; }
    catch { throw new Error("Invalid Jev key file; run jevcode jev setup"); }
    if (typeof key !== "string") throw new Error("Invalid Jev key file; run jevcode jev setup");
    return normalizeJevKey(key);
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

export async function saveJevKey(key: string, base = homedir()): Promise<void> {
  const normalized = normalizeJevKey(key);
  const dir = await directory(base, true);
  const filename = await resolvePath(dir, "jev-key.json", true);
  const temporary = path.join(dir, `.jev-key-${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ key: normalized })); await file.sync(); } finally { await file.close(); }
    await resolvePath(dir, "jev-key.json", true);
    await rename(temporary, filename);
  } finally { try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; } }
}

export async function removeJevKey(base = homedir()): Promise<void> {
  try { await unlink(await resolvePath(await directory(base, false), "jev-key.json")); }
  catch (error) { if (!isMissing(error)) throw error; }
}
