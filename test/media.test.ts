import test from "node:test";
import assert from "node:assert/strict";
import { link, symlink, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { readImage, requireImageSupport, MAX_IMAGE_BYTES } from "../src/media.js";
import { OpenAICompatible, type Message } from "../src/llm.js";
import { run } from "../src/runtime.js";
import { saveSession, restoreSession, latestSession, listSessions } from "../src/session.js";
import { contextSize, compactConversation } from "../src/context.js";
import { fixture, options, final, scripted, server, requestBody } from "./helpers.js";
import { AuthManager, CredentialStore } from "../src/auth.js";
import { SubscriptionModel } from "../src/subscription-model.js";
import type { AssistantMessage } from "@earendil-works/pi-ai";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");

test("attachments validate bounded workspace files, MIME signatures and path protection", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "test.png"), png);
  const image = await readImage(project.workspace, "test.png");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, png.toString("base64"));
  await writeFile(path.join(project.workspace.root, "fake.jpg"), png);
  await assert.rejects(readImage(project.workspace, "fake.jpg"), /signature/);
  await writeFile(path.join(project.workspace.root, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
  await assert.rejects(readImage(project.workspace, "big.png"), /exceeds/);
  await assert.rejects(readImage(project.workspace, ".env"), /protected/);
  await assert.rejects(readImage(project.workspace, "../outside.png"), /traversal/);
  await symlink("test.png", path.join(project.workspace.root, "symlink.png"));
  await assert.rejects(readImage(project.workspace, "symlink.png"), /Symbolic/);
  await link(path.join(project.workspace.root, "test.png"), path.join(project.workspace.root, "hard.png"));
  await assert.rejects(readImage(project.workspace, "hard.png"), /non-linked/);
});

test("OpenAI images use real multimodal content; unsupported models refuse before requests", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "test.png"), png);
  const image = await readImage(project.workspace, "test.png");
  let calls = 0;
  project.config.llm.baseUrl = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      calls++;
      const messages = body.messages as { role: string; images?: unknown; content: unknown }[];
      assert.deepEqual(messages.at(-1)!.content, [{ type: "text", text: "Describe" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }]);
      assert.equal(messages.at(-1)!.images, undefined);
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "A pixel" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3 } }));
    });
  });
  const model = new OpenAICompatible(project.config.llm, "synthetic");
  await model.complete([{ role: "user", content: "Describe", images: [image] }], [], "gpt-4.1-mini", new AbortController().signal);
  await assert.rejects(model.complete([{ role: "user", content: "Describe", images: [image] }], [], "text-only", new AbortController().signal), /image-input/);
  assert.equal(calls, 1);
  assert.throws(() => requireImageSupport(scripted([]), "anything", [image]), /image-input/);
});

test("image snapshots roundtrip privately with names and image budgets omit base64 length", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "test.png"), png);
  const image = await readImage(project.workspace, "test.png");
  const model = scripted([]);
  const messages: Message[] = [{ role: "user", content: "Describe", images: [image] }];
  assert.ok(contextSize(model, messages, []) > 16_384);
  const id = await saveSession(project, messages, model, "Image investigation");
  assert.equal(await latestSession(project), id);
  assert.equal((await listSessions(project)).sessions[0]!.name, "Image investigation");
  assert.deepEqual(await restoreSession(project, id, model), messages);
  const filename = path.join(project.workspace.root, `.jev/sessions/${id}.json`);
  const snapshot = JSON.parse(await readFile(filename, "utf8"));
  snapshot.messages[0].images[0].mimeType = "image/jpeg";
  await writeFile(filename, JSON.stringify(snapshot));
  await assert.rejects(restoreSession(project, id, model), /Invalid/);
});

test("runtime and compaction retain images without adding bytes to routing/event metadata", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "test.png"), png);
  const image = await readImage(project.workspace, "test.png");
  const messages: Message[] = [];
  const events: unknown[] = [];
  const model = { ...scripted([final("Observation ".repeat(3000)), final("One pixel")], (messages, _tools, index) => {
    if (index === 0) assert.deepEqual(messages.at(-1)!.images, [image]);
  }), supportsImages: () => true };
  assert.equal((await run(project, options(model, { task: "Describe", images: [image], conversation: messages,
    emit: (event, data) => events.push({ event, data }) }))).status, "completed");
  assert.doesNotMatch(JSON.stringify(events), new RegExp(image.data.slice(0, 25)));
  const compacted = await compactConversation(project, model, messages, "", new AbortController().signal, () => {});
  assert.deepEqual(compacted.messages.at(-1)!.images, [image]);
});

test("Pi image blocks and native snapshot history survive provider roundtrips without credentials", async (t) => {
  const project = await fixture(t);
  project.config.llm.provider = "openai-codex";
  project.config.llm.model = "gpt-5.5";
  await writeFile(path.join(project.workspace.root, "test.png"), png);
  const image = await readImage(project.workspace, "test.png");
  const auth = new AuthManager(new CredentialStore(project.workspace.root, ".jev/auth-test"), {
    login: async () => ({ access: "synthetic-secret", refresh: "synthetic-refresh", expires: Date.now() + 100_000 }),
    refresh: async () => { throw new Error("Unexpected refresh"); },
  });
  await auth.login("openai-codex", { onAuth() {}, onProgress() {}, onPrompt: async () => "" }, new AbortController().signal);
  const response: AssistantMessage = {
    role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-5.5",
    content: [{ type: "text", text: "A pixel", textSignature: "native-signature" }],
    stopReason: "stop", timestamp: 0,
    usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 6,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const adapter = new SubscriptionModel(project.config.llm, "openai-codex", auth, async (_model, context) => {
    assert.deepEqual(context.messages[0]!.content, [{ type: "text", text: "Describe" }, { type: "image", ...image }]);
    return response;
  });
  const messages: Message[] = [{ role: "user", content: "Describe", images: [image] }];
  messages.push((await adapter.complete(messages, [], "gpt-5.5", new AbortController().signal)).message);
  const saved = await saveSession(project, messages, adapter);
  const restored = await restoreSession(project, saved, adapter);
  await adapter.complete(restored, [], "gpt-5.5", new AbortController().signal);
  assert.doesNotMatch(await readFile(path.join(project.workspace.root, `.jev/sessions/${saved}.json`), "utf8"), /synthetic-secret|synthetic-refresh/);
});
