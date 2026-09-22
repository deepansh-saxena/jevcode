import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { isMissing } from "./errors.js";
import { readText, resolvePath } from "./workspace.js";

export const accountProviders = ["github-copilot", "openai-codex"] as const;
export const accountProviderSchema = z.enum(accountProviders);
export type AccountProvider = (typeof accountProviders)[number];
export type Provider = AccountProvider | "openai-compatible";

export const credentialSchema = z.object({
  access: z.string().min(1).max(32_000),
  refresh: z.string().min(1).max(32_000),
  expires: z.number().finite().positive().max(8.64e15),
  accountId: z.string().min(1).optional(),
  enterpriseUrl: z.string().min(1).optional(),
}).passthrough();

export function providerName(value: string): Provider {
  if (value === "copilot" || value === "github-copilot") return "github-copilot";
  if (value === "openai" || value === "openai-codex") return "openai-codex";
  if (value === "api" || value === "openai-compatible") return "openai-compatible";
  throw new Error("Provider must be copilot, openai, or api");
}

export function loginAlias(provider: AccountProvider): string {
  return provider === "github-copilot" ? "copilot" : "openai";
}

export interface LoginCallbacks {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; hidden: boolean }, signal: AbortSignal) => Promise<string>;
  onProgress: (message: string) => void;
}

export interface AuthDriver {
  login(provider: AccountProvider, callbacks: LoginCallbacks, signal: AbortSignal): Promise<OAuthCredentials>;
  refresh(provider: AccountProvider, credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials>;
}

export class CredentialStore {
  constructor(private base = homedir(), private relative = ".jev-code/auth") {}

  private async directory(create: boolean): Promise<string> {
    const root = await realpath(this.base);
    const directory = await resolvePath(root, this.relative, create);
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    await resolvePath(root, this.relative);
    let current = root;
    for (const part of this.relative.split("/")) {
      current = path.join(current, part);
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
        throw new Error("Credential directories must be owned by you, private (0700), and not symbolic links");
      }
    }
    return directory;
  }

  async read(provider: AccountProvider): Promise<OAuthCredentials | null> {
    try {
      const directory = await this.directory(false);
      const filename = await resolvePath(directory, `${provider}.json`);
      const stat = await lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
        throw new Error("Credential files must be owned by you, private (0600), and not linked");
      }
      const text = await readText(filename, 100_000);
      try {
        return credentialSchema.parse(JSON.parse(text));
      } catch {
        throw new Error(`Invalid saved credentials for ${provider}; log out and log in again`);
      }
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async withLock<T>(provider: AccountProvider, operation: () => Promise<T>): Promise<T> {
    const directory = await this.directory(true);
    const lock = await resolvePath(directory, `${provider}.lock`, true);
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Another ${provider} login/refresh/logout is active. If it crashed, remove its stale .lock directory only after it has exited.`);
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rmdir(lock);
    }
  }

  // Caller holds the provider lock across refresh and atomic publication.
  async writeLocked(provider: AccountProvider, credentials: OAuthCredentials): Promise<void> {
    const validated = credentialSchema.parse(credentials);
    const directory = await this.directory(true);
    const filename = await resolvePath(directory, `${provider}.json`, true);
    const temporary = path.join(directory, `.${provider}-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(JSON.stringify(validated));
        await file.sync();
      } finally {
        await file.close();
      }
      await resolvePath(directory, `${provider}.json`, true);
      await rename(temporary, filename);
    } finally {
      try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
    }
  }

  async deleteLocked(provider: AccountProvider): Promise<void> {
    const directory = await this.directory(true);
    try {
      await unlink(await resolvePath(directory, `${provider}.json`));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

export class AuthManager {
  constructor(readonly store: CredentialStore, private driver: AuthDriver) {}

  async login(provider: AccountProvider, callbacks: LoginCallbacks, signal: AbortSignal): Promise<void> {
    await this.store.withLock(provider, async () => {
      signal.throwIfAborted();
      const credentials = await this.driver.login(provider, callbacks, signal);
      signal.throwIfAborted();
      await this.store.writeLocked(provider, credentials);
    });
  }

  async credentials(provider: AccountProvider, signal: AbortSignal): Promise<OAuthCredentials> {
    signal.throwIfAborted();
    const current = await this.store.read(provider);
    if (!current) throw new Error(`Not logged in. Run: jevcode login ${loginAlias(provider)}`);
    if (current.expires > Date.now() + 60_000) return current;
    return this.store.withLock(provider, async () => {
      const latest = await this.store.read(provider);
      if (!latest) throw new Error(`Signed out. Run: jevcode login ${loginAlias(provider)}`);
      if (latest.expires > Date.now() + 60_000) return latest;
      signal.throwIfAborted();
      const refreshed = await this.driver.refresh(provider, latest, signal);
      signal.throwIfAborted();
      await this.store.writeLocked(provider, refreshed);
      return credentialSchema.parse(refreshed);
    });
  }

  async logout(provider: AccountProvider): Promise<void> {
    await this.store.withLock(provider, () => this.store.deleteLocked(provider));
  }

  async status(): Promise<{ provider: AccountProvider; loggedIn: boolean; expiresAt: string | null; needsRefresh: boolean }[]> {
    return Promise.all(accountProviders.map(async (provider) => {
      const credentials = await this.store.read(provider);
      return {
        provider, loggedIn: Boolean(credentials),
        expiresAt: credentials ? new Date(credentials.expires).toISOString() : null,
        needsRefresh: credentials !== null && credentials.expires <= Date.now() + 60_000,
      };
    }));
  }
}
