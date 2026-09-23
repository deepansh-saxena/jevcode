import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { TestContext } from "node:test";
import { initialize } from "../src/init.js";
import { loadProject, type Project } from "../src/registry.js";
import type { CodingModel, Completion, Message, ToolSpec } from "../src/llm.js";
import type { RunOptions } from "../src/runtime.js";

export async function fixture(t: TestContext): Promise<Project> {
  const root = await mkdtemp(path.join(tmpdir(), "jev-code-test-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await initialize(root, { jevSetup: false });
  return loadProject(root, { globalRoot: null });
}

export function final(text = "Done"): Completion {
  return { message: { role: "assistant", content: text }, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } };
}

export function call(name: string, args: unknown): Completion {
  return {
    message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
    },
    finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 5 },
  };
}

export function scripted(responses: Completion[], inspect?: (messages: Message[], tools: ToolSpec[], index: number) => void): CodingModel {
  let index = 0;
  return {
    async complete(messages, tools) {
      inspect?.(messages, tools, index);
      const result = responses[index++];
      if (!result) throw new Error("Unexpected extra model request");
      return result;
    },
  };
}

export function options(model: CodingModel, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    task: "Investigate the code", permissions: { write: false, commands: false },
    signal: new AbortController().signal, approve: async () => false,
    model, env: {}, ...overrides,
  };
}

export async function server(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const instance = createServer(handler);
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  });
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}`;
}

export async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
