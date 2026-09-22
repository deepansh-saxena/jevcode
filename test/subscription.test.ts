import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai";
import { AuthManager, CredentialStore } from "../src/auth.js";
import { SubscriptionModel, accountModel } from "../src/subscription-model.js";
import { run } from "../src/runtime.js";
import { fixture, options, server, requestBody } from "./helpers.js";
import type { Message } from "../src/llm.js";

function native(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "Finished" }],
    api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.4-mini",
    usage: { input: 8, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 0, ...overrides,
  };
}

async function auth(root: string): Promise<AuthManager> {
  const manager = new AuthManager(new CredentialStore(root, ".jev/auth-test"), {
    login: async () => ({ access: "fake-provider-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 }),
    refresh: async () => { throw new Error("Unexpected refresh"); },
  });
  const callbacks = { onAuth: () => {}, onPrompt: async () => "", onProgress: () => {} };
  for (const provider of ["github-copilot", "openai-codex"] as const) {
    await manager.login(provider, callbacks, new AbortController().signal);
  }
  return manager;
}

test("subscription adapter preserves native reasoning/signatures and maps tool results", async (t) => {
  const project = await fixture(t);
  const manager = await auth(project.workspace.root);
  let requests = 0;
  const response = native({
    content: [
      { type: "thinking", thinking: "Private reasoning", thinkingSignature: "opaque-signature" },
      { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "file.ts" } },
    ],
    stopReason: "toolUse",
  });
  const adapter = new SubscriptionModel(project.config.llm, "openai-codex", manager, async (model, context, opts) => {
    assert.equal(model.api, "openai-codex-responses");
    assert.equal(opts.apiKey, "fake-provider-access");
    assert.equal(opts.maxRetries, 0);
    assert.equal(context.systemPrompt, "System instructions");
    if (requests++ === 0) return response;
    assert.strictEqual(context.messages[1], response);
    const result = context.messages.at(-1)!;
    assert.equal(result.role, "toolResult");
    if (result.role === "toolResult") {
      assert.equal(result.toolName, "read_file");
      assert.equal(result.toolCallId, "call-1");
      assert.equal(result.isError, true);
    }
    return native();
  });
  const messages: Message[] = [
    { role: "system", content: "System instructions" }, { role: "user", content: "Read file.ts" },
  ];
  const completion = await adapter.complete(messages, [], "gpt-5.4-mini", new AbortController().signal);
  assert.equal(completion.finishReason, "tool_calls");
  assert.equal(completion.message.content, null);
  assert.deepEqual(completion.usage, { inputTokens: 11, outputTokens: 4 });
  messages.push(completion.message, { role: "tool", tool_call_id: "call-1", content: '{"error":"File missing"}' });
  assert.ok(adapter.contextSize(messages, []) > JSON.stringify(messages).length);
  await adapter.complete(messages, [], "gpt-5.4-mini", new AbortController().signal);
});

test("OAuth transport ignores custom API URLs and never exposes provider error bodies", async (t) => {
  const project = await fixture(t);
  project.config.llm.baseUrl = "https://unrelated.example";
  const manager = await auth(project.workspace.root);
  const adapter = new SubscriptionModel(project.config.llm, "github-copilot", manager, async (model) => {
    assert.match(model.baseUrl, /githubcopilot\.com/);
    return native({ stopReason: "error", errorMessage: "401 token=fake-private-token", provider: "github-copilot" });
  });
  await assert.rejects(adapter.complete([], [], "gpt-4.1", new AbortController().signal), (error: unknown) =>
    error instanceof Error && error.message.includes("401") && !error.message.includes("fake-private-token"));
  assert.throws(() => accountModel("openai-codex", "made-up-model"), /Unknown model/);
});

test("OAuth tool calls remain subject to the harness's permissions and approvals", async (t) => {
  const project = await fixture(t);
  const manager = await auth(project.workspace.root);
  project.config.llm.model = "gpt-5.4-mini";
  const adapter = new SubscriptionModel(project.config.llm, "openai-codex", manager, async () => native({
    content: [{ type: "toolCall", id: "bad-write", name: "write_file", arguments: { path: "no.txt", content: "no", expectedHash: null } }],
    stopReason: "toolUse",
  }));
  const blocked = await run(project, options(adapter));
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.text, /Unavailable tool/);
  let approvals = 0;
  const denied = await run(project, options(adapter, {
    permissions: { write: true, commands: false },
    approve: async () => { approvals++; return false; },
  }));
  assert.equal(denied.status, "blocked");
  assert.equal(approvals, 1);
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});

test("missing usage, truncated responses, and cancellation cannot execute returned actions", async (t) => {
  const project = await fixture(t);
  const manager = await auth(project.workspace.root);
  const zero = native();
  zero.usage.input = zero.usage.output = zero.usage.cacheRead = zero.usage.cacheWrite = 0;
  const adapter = new SubscriptionModel(project.config.llm, "openai-codex", manager, async () => zero);
  await assert.rejects(adapter.complete([], [], "gpt-5.4-mini", new AbortController().signal), /token usage/);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(adapter.complete([], [], "gpt-5.4-mini", aborted.signal));
  const truncated = new SubscriptionModel(project.config.llm, "openai-codex", manager, async () => native({ stopReason: "length" }));
  assert.equal((await truncated.complete([], [], "gpt-5.4-mini", new AbortController().signal)).finishReason, "length");
});

test("real Pi Copilot streaming adapter completes a local HTTP tool round trip", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "source.txt"), "local source");
  const manager = await auth(project.workspace.root);
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.equal(request.headers.authorization, "Bearer fake-provider-access");
      assert.equal(body.model, "gpt-4.1");
      assert.equal(body.stream, true);
      if (requests > 0) assert.match(JSON.stringify(body.messages), /local source/);
      const delta = requests++ === 0 ? {
        tool_calls: [{ index: 0, id: "read-1", type: "function", function: { name: "read_file", arguments: '{"path":"source.txt"}' } }],
      } : { content: "Read source.txt" };
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({
        id: "response-1", model: "gpt-4.1",
        choices: [{ index: 0, delta, finish_reason: requests === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      })}\n\ndata: [DONE]\n\n`);
    });
  });
  project.config.llm.model = "gpt-4.1";
  const adapter = new SubscriptionModel(project.config.llm, "github-copilot", manager,
    (model, context, opts) => completeSimple({ ...model, baseUrl: url }, context, opts));
  const result = await run(project, options(adapter));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.text, "Read source.txt");
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(requests, 2);
});
