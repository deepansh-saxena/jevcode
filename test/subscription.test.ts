import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai";
import { AuthManager, CredentialStore } from "../src/auth.js";
import { SubscriptionModel, accountModel, defaultAccountModels } from "../src/subscription-model.js";
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

async function auth(root: string, access = "fake-provider-access"): Promise<AuthManager> {
  const manager = new AuthManager(new CredentialStore(root, ".jev/auth-test"), {
    login: async () => ({ access, refresh: "fake-refresh", expires: Date.now() + 3_600_000 }),
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

test("subscription failures expose safe HTTP status and actionable categories, not response details", async (t) => {
  const project = await fixture(t);
  const manager = await auth(project.workspace.root);
  const cases = [
    { status: 400, message: '{"detail":"The gpt-5.4-mini model is not supported for this account."}', expected: /model "gpt-5.4-mini" is unavailable.*--model/ },
    { status: 404, message: '{"error":{"code":"model_not_found"}}', expected: /model "gpt-5.4-mini" is unavailable/ },
    { status: 401, message: "The token expired", expected: /rejected your sign-in.*jevcode login openai/ },
    { status: 403, message: "Forbidden", expected: /organization policy denied access/ },
    { status: 429, message: "Too many requests", expected: /usage or rate limit/ },
    { status: 400, message: "Unsupported parameter: private_parameter", expected: /rejected the request format/ },
    { status: 503, message: "Service unavailable", expected: /provider reported a server error/ },
    { status: undefined, message: "fetch failed", expected: /could not connect to the provider/ },
    { status: undefined, message: "Unexpected private error", expected: /unexpected provider response/ },
  ];
  for (const scenario of cases) {
    for (const thrown of [false, true]) {
      await t.test(`${scenario.status ?? "no status"} ${scenario.message} (${thrown ? "throw" : "response"})`, async () => {
        const adapter = new SubscriptionModel(project.config.llm, "openai-codex", manager, async (model, _context, opts) => {
          if (scenario.status) {
            await opts.onResponse?.({ status: scenario.status, headers: { "x-private": "PRIVATE_HEADER" } }, model);
          }
          const message = `${scenario.message} PRIVATE_BODY fake-private-token`;
          if (thrown) throw new Error(message);
          return native({ stopReason: "error", errorMessage: message });
        });
        await assert.rejects(adapter.complete([], [], "gpt-5.4-mini", new AbortController().signal), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, scenario.expected);
          if (scenario.status) assert.ok(error.message.includes(`HTTP ${scenario.status}`));
          assert.doesNotMatch(error.message, /PRIVATE_HEADER|PRIVATE_BODY|fake-private-token|private_parameter/);
          assert.equal(error.cause, undefined);
          return true;
        });
      });
    }
  }
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

test("real Pi Codex adapter completes a tool round trip with the current default model", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "source.txt"), "local source");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "fake-account" },
  })).toString("base64");
  const access = `fake.${payload}.signature`;
  const manager = await auth(project.workspace.root, access);
  const modelId = defaultAccountModels["openai-codex"];
  assert.equal(modelId, "gpt-5.5");
  let requests = 0;
  const url = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.equal(request.url, "/codex/responses");
      assert.equal(request.headers.authorization, `Bearer ${access}`);
      assert.equal(request.headers["chatgpt-account-id"], "fake-account");
      assert.equal(body.model, modelId);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.match(JSON.stringify(body.tools), /read_file/);
      const first = requests++ === 0;
      if (!first) {
        assert.match(JSON.stringify(body.input), /function_call_output/);
        assert.match(JSON.stringify(body.input), /local source/);
      }
      const item = first ? {
        type: "function_call", id: "fc_read", call_id: "call_read",
        name: "read_file", arguments: '{"path":"source.txt"}',
      } : {
        type: "message", id: "msg_done", role: "assistant",
        content: [{ type: "output_text", text: "Read source.txt", annotations: [] }],
      };
      const events = [
        { type: "response.created", response: { id: `resp_${requests}` } },
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: {
          id: `resp_${requests}`, status: "completed", output: [item],
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        } },
      ];
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  project.config.llm.model = modelId;
  const adapter = new SubscriptionModel(project.config.llm, "openai-codex", manager,
    (model, context, opts) => completeSimple({ ...model, baseUrl: url }, context, opts));
  const result = await run(project, options(adapter));
  assert.equal(result.status, "completed", result.text);
  assert.equal(result.text, "Read source.txt");
  assert.equal(result.metrics.toolCalls, 1);
  assert.equal(result.metrics.turns, 2);
  assert.equal(requests, 2);
});
