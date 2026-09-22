import assert from "node:assert/strict";
import { piAuthDriver } from "../../src/auth-driver.js";

const signal = AbortSignal.timeout(15_000);
let authUrl = "";
const credentials = await piAuthDriver.login("github-copilot", {
  onAuth: (info) => { authUrl = info.url; },
  onPrompt: async () => "",
  onProgress: () => {},
}, signal);
assert.equal(authUrl, "https://github.com/login/device");
assert.equal(credentials.access, "fake-copilot-access");
assert.equal(credentials.refresh, "fake-github-refresh");

let openaiUrl = "";
const openai = await piAuthDriver.login("openai-codex", {
  onAuth: (info) => { openaiUrl = info.url; },
  onPrompt: async () => {
    const state = new URL(openaiUrl).searchParams.get("state");
    assert.ok(state);
    return `http://localhost:1455/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`;
  },
  onProgress: () => {},
}, signal);
assert.equal(new URL(openaiUrl).hostname, "auth.openai.com");
assert.equal(openai.accountId, "fake-test-account");

const refreshed = await piAuthDriver.refresh("openai-codex", {
  access: "expired", refresh: "fake-refresh", expires: 1,
}, signal);
assert.equal(refreshed.accountId, "fake-test-account");
assert.equal(refreshed.refresh, "fake-rotated");

await assert.rejects(piAuthDriver.refresh("openai-codex", {
  access: "expired", refresh: "invalid", expires: 1,
}, signal), (error: unknown) => error instanceof Error &&
  error.message.includes("authentication failed") && !error.message.includes("SENSITIVE_PROVIDER_RESPONSE"));

const controller = new AbortController();
await assert.rejects(piAuthDriver.login("github-copilot", {
  onAuth: () => controller.abort(), onPrompt: async () => "", onProgress: () => {},
}, controller.signal), /cancelled/);
console.log("Offline authentication worker checks passed");
