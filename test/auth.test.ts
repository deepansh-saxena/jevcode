import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { AuthManager, CredentialStore, providerName, type AuthDriver, type LoginCallbacks } from "../src/auth.js";
import { loadProject, selectAccountProvider } from "../src/registry.js";
import { fixture } from "./helpers.js";

const credentials = (): OAuthCredentials => ({
  access: "fake-access-do-not-log", refresh: "fake-refresh-do-not-log",
  expires: Date.now() + 3_600_000, accountId: "fake-account",
});
const callbacks: LoginCallbacks = {
  onAuth: () => {}, onPrompt: async () => "", onProgress: () => {},
};
const driver: AuthDriver = {
  login: async () => credentials(), refresh: async () => credentials(),
};

test("provider aliases preserve API-key mode and reject unknown providers", () => {
  assert.equal(providerName("copilot"), "github-copilot");
  assert.equal(providerName("openai"), "openai-codex");
  assert.equal(providerName("api"), "openai-compatible");
  assert.throws(() => providerName("unknown"), /Provider must/);
});

test("login stores private credentials; status never exposes tokens; logout is provider-specific", async (t) => {
  const project = await fixture(t);
  const store = new CredentialStore(project.workspace.root, ".jev/auth-test");
  const manager = new AuthManager(store, driver);
  assert.ok((await manager.status()).every((entry) => !entry.loggedIn));
  await manager.login("github-copilot", callbacks, new AbortController().signal);
  await manager.login("openai-codex", callbacks, new AbortController().signal);
  const filename = path.join(project.workspace.root, ".jev/auth-test/github-copilot.json");
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(filename))).mode & 0o777, 0o700);
  const status = JSON.stringify(await manager.status());
  assert.ok(!status.includes("fake-access") && !status.includes("fake-refresh") && !status.includes("fake-account"));
  assert.ok((await manager.status()).every((entry) => entry.loggedIn));
  await manager.logout("github-copilot");
  assert.equal(await store.read("github-copilot"), null);
  assert.ok(await store.read("openai-codex"));
});

test("expired credentials refresh and persist; fresh credentials do not contact the provider", async (t) => {
  const project = await fixture(t);
  const store = new CredentialStore(project.workspace.root, ".jev/auth-test");
  await store.withLock("openai-codex", () => store.writeLocked("openai-codex", { ...credentials(), expires: 1 }));
  let refreshes = 0;
  const manager = new AuthManager(store, {
    ...driver,
    async refresh(_provider, saved) {
      refreshes++;
      assert.equal(saved.refresh, "fake-refresh-do-not-log");
      return { ...credentials(), refresh: "rotated-refresh" };
    },
  });
  const first = await manager.credentials("openai-codex", new AbortController().signal);
  const second = await manager.credentials("openai-codex", new AbortController().signal);
  assert.equal(refreshes, 1);
  assert.equal(first.refresh, "rotated-refresh");
  assert.deepEqual(second, first);
  assert.deepEqual(await store.read("openai-codex"), first);
});

test("refresh failures preserve credentials and release the provider lock", async (t) => {
  const project = await fixture(t);
  const store = new CredentialStore(project.workspace.root, ".jev/auth-test");
  const old = { ...credentials(), expires: 1 };
  await store.withLock("github-copilot", () => store.writeLocked("github-copilot", old));
  const manager = new AuthManager(store, { ...driver, refresh: async () => { throw new Error("Refresh failed"); } });
  await assert.rejects(manager.credentials("github-copilot", new AbortController().signal), /Refresh failed/);
  assert.deepEqual(await store.read("github-copilot"), old);
  await store.withLock("github-copilot", async () => {});
});

test("provider lock rejects concurrent mutation and releases after cancellation", async (t) => {
  const project = await fixture(t);
  const store = new CredentialStore(project.workspace.root, ".jev/auth-test");
  await store.withLock("github-copilot", async () => {
    await assert.rejects(store.withLock("github-copilot", async () => {}), /Another/);
  });
  const controller = new AbortController();
  const manager = new AuthManager(store, {
    ...driver, login: async () => { controller.abort(); return credentials(); },
  });
  await assert.rejects(manager.login("github-copilot", callbacks, controller.signal));
  assert.equal(await store.read("github-copilot"), null);
  await store.withLock("github-copilot", async () => {});
});

test("credential store refuses exposed permissions, symbolic links and malformed token files", async (t) => {
  const project = await fixture(t);
  const store = new CredentialStore(project.workspace.root, ".jev/auth-test");
  await store.withLock("github-copilot", () => store.writeLocked("github-copilot", credentials()));
  const directory = path.join(project.workspace.root, ".jev/auth-test");
  const filename = path.join(directory, "github-copilot.json");
  await chmod(filename, 0o644);
  await assert.rejects(store.read("github-copilot"), /private/);
  await chmod(filename, 0o600);
  await writeFile(filename, "{fake-private-token");
  await assert.rejects(store.read("github-copilot"), (error: unknown) =>
    error instanceof Error && error.message.includes("Invalid saved credentials") && !error.message.includes("fake-private-token"));
  await unlink(filename);
  await writeFile(path.join(directory, "outside.json"), JSON.stringify(credentials()));
  await symlink("outside.json", filename);
  await assert.rejects(store.read("github-copilot"), /Symbolic/);
});

test("credential directory and credential-root workspaces are inaccessible to file tools", async (t) => {
  const project = await fixture(t);
  await mkdir(path.join(project.workspace.root, ".jev-code"), { mode: 0o700 });
  await writeFile(path.join(project.workspace.root, ".jev-code/auth.json"), "private");
  await assert.rejects(project.workspace.read(".jev-code/auth.json"), /protected/);
  const { Workspace } = await import("../src/workspace.js");
  const credentialWorkspace = await Workspace.create(path.join(project.workspace.root, ".jev-code"));
  await assert.rejects(credentialWorkspace.read("auth.json"), /credential directory/);
});

test("successful login selection persists without clobbering other settings or concurrent edits", async (t) => {
  const project = await fixture(t);
  await selectAccountProvider(project, "github-copilot", "gpt-4.1");
  const loaded = await loadProject(project.workspace.root, { globalRoot: null });
  assert.equal(loaded.config.llm.provider, "github-copilot");
  assert.equal(loaded.config.llm.model, "gpt-4.1");
  assert.deepEqual(loaded.config.commands, project.config.commands);
  assert.deepEqual(loaded.config.jev, project.config.jev);
  const filename = path.join(project.workspace.root, ".jev/config.json");
  const changed = { ...loaded.config, protectedPaths: ["user-added"] };
  await writeFile(filename, JSON.stringify(changed));
  await assert.rejects(selectAccountProvider(loaded, "openai-codex", "gpt-5.4-mini"), /config changed/);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).protectedPaths, ["user-added"]);
});
