import {
  completeSimple, streamSimple, getModels, type Api, type AssistantMessage, type Context,
  type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { Type } from "typebox";
import { z } from "zod";
import type { AccountProvider, AuthManager } from "./auth.js";
import type { Config } from "./config.js";
import type { CodingModel, Completion, Message, ToolSpec } from "./llm.js";

export const defaultAccountModels: Record<AccountProvider, string> = {
  "github-copilot": "gpt-4.1",
  "openai-codex": "gpt-5.5",
};

export function accountModels(provider: AccountProvider): Model<Api>[] {
  return getModels(provider);
}

export function accountModel(provider: AccountProvider, id: string): Model<Api> {
  const model = accountModels(provider).find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown model ${id} for ${provider}. Run: jevcode models ${provider}`);
  return model;
}

function requestFailure(provider: AccountProvider, model: string, error: unknown, httpStatus?: number): Error {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const reportedStatus = message.match(/^(?:HTTP\s+)?(400|401|403|404|408|422|429|5\d\d)\b/)?.[1];
  const status = httpStatus ?? (reportedStatus ? Number(reportedStatus) : undefined);
  const prefix = `${provider} request failed${status ? ` (HTTP ${status})` : ""}`;
  if (status === 401 || /unauthorized|invalid token|token[\s\S]*expired|authentication/i.test(message)) {
    const alias = provider === "openai-codex" ? "openai" : "copilot";
    return new Error(`${prefix}: the provider rejected your sign-in. Run: jevcode login ${alias}`);
  }
  if (status === 429 || /usage[_ ]limit|quota|rate[_ -]limit/i.test(message)) {
    return new Error(`${prefix}: the provider reported a usage or rate limit. Check your account allowance or retry after the limit resets.`);
  }
  if (/model[\s\S]*(?:not supported|not found|not available|does not exist|not have access|unavailable)|unsupported[_ -]model|model[_ -]not[_ -]found/i.test(message)) {
    return new Error(`${prefix}: model "${model}" is unavailable for this account. Choose an account-supported model with --model; the bundled model catalog does not guarantee access.`);
  }
  if (status === 403) {
    return new Error(`${prefix}: account or organization policy denied access. Check your subscription and model permissions.`);
  }
  if (status === 400 || status === 422 || /unsupported parameter|invalid[\s\S]*(?:parameter|schema)/i.test(message)) {
    return new Error(`${prefix}: the provider rejected the request format. Check model and adapter compatibility; signing in again may not help.`);
  }
  if (status && status >= 500) {
    return new Error(`${prefix}: the provider reported a server error. Retry later.`);
  }
  if (/fetch failed|network|connection|certificate|\btls\b|\bdns\b/i.test(message)) {
    return new Error(`${prefix}: could not connect to the provider. Check your network, proxy, and TLS settings.`);
  }
  return new Error(`${prefix}: unexpected provider response. Sensitive response details were withheld.`);
}

export type SubscriptionTransport = (
  model: Model<Api>, context: Context, options: SimpleStreamOptions, onText?: (text: string) => void,
) => Promise<AssistantMessage>;

const nativeMessageSchema = z.object({
  role: z.literal("assistant"), api: z.string(), provider: z.string(), model: z.string(),
  responseId: z.string().optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string(), textSignature: z.string().optional() }),
    z.object({ type: z.literal("thinking"), thinking: z.string(), thinkingSignature: z.string().optional(), redacted: z.boolean().optional() }),
    z.object({ type: z.literal("toolCall"), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()), thoughtSignature: z.string().optional() }),
  ])),
  usage: z.object({
    input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), totalTokens: z.number(),
    cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }),
  }),
  stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]), timestamp: z.number(),
});

const subscriptionTransport: SubscriptionTransport = async (model, context, options, onText) => {
  if (!onText) return completeSimple(model, context, options);
  const stream = streamSimple(model, context, options);
  for await (const event of stream) {
    if (event.type === "text_delta") onText(event.delta);
  }
  return stream.result();
};

export class SubscriptionModel implements CodingModel {
  private history = new WeakMap<Message, AssistantMessage>();

  constructor(
    private config: Config["llm"],
    private provider: AccountProvider,
    private auth: AuthManager,
    private transport: SubscriptionTransport = subscriptionTransport,
  ) {}

  exportHistory(messages: Message[]): unknown {
    return messages.filter((message) => message.role === "assistant").map((message) =>
      nativeMessageSchema.parse(this.history.get(message)));
  }

  restoreHistory(messages: Message[], history: unknown): void {
    const parsed = z.array(nativeMessageSchema).parse(history);
    const assistants = messages.filter((message) => message.role === "assistant");
    if (assistants.length !== parsed.length) throw new Error("Saved provider history is incomplete");
    for (const [index, message] of assistants.entries()) {
      const native = parsed[index]!;
      const calls = native.content.filter((block) => block.type === "toolCall").map((block) => ({
        id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.arguments) },
      }));
      const text = native.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") || null;
      if (native.provider !== this.provider || JSON.stringify(calls) !== JSON.stringify(message.tool_calls ?? []) ||
        text !== message.content) throw new Error("Saved provider history does not match the conversation");
      const content: AssistantMessage["content"] = native.content.map((block) => {
        if (block.type === "text") return {
          type: block.type, text: block.text, ...(block.textSignature !== undefined ? { textSignature: block.textSignature } : {}),
        };
        if (block.type === "thinking") return {
          type: block.type, thinking: block.thinking,
          ...(block.thinkingSignature !== undefined ? { thinkingSignature: block.thinkingSignature } : {}),
          ...(block.redacted !== undefined ? { redacted: block.redacted } : {}),
        };
        return { type: block.type, id: block.id, name: block.name, arguments: block.arguments,
          ...(block.thoughtSignature !== undefined ? { thoughtSignature: block.thoughtSignature } : {}) };
      });
      this.history.set(message, {
        role: native.role, api: native.api, provider: native.provider, model: native.model, content,
        usage: native.usage, timestamp: native.timestamp, stopReason: native.stopReason,
        ...(native.responseId !== undefined ? { responseId: native.responseId } : {}),
      });
    }
  }

  private context(messages: Message[], tools: ToolSpec[]): Context {
    const context: Context = {
      systemPrompt: messages.filter((message) => message.role === "system").map((message) => message.content ?? "").join("\n\n"),
      messages: [],
      tools: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: Type.Unsafe(tool.function.parameters),
      })),
    };
    const toolNames = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "assistant") {
        const native = this.history.get(message);
        if (!native) throw new Error("Subscription conversation lost its provider-native history");
        context.messages.push(native);
        for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
      } else if (message.role === "user") {
        context.messages.push({ role: "user", content: message.content ?? "", timestamp: 0 });
      } else {
        const name = message.tool_call_id ? toolNames.get(message.tool_call_id) : undefined;
        if (!name || !message.tool_call_id) throw new Error("Tool result has no matching subscription tool call");
        const result: unknown = JSON.parse(message.content ?? "{}");
        const failed = typeof result === "object" && result !== null &&
          (Object.hasOwn(result, "error") || ("ok" in result && result.ok === false));
        context.messages.push({
          role: "toolResult", toolCallId: message.tool_call_id, toolName: name,
          content: [{ type: "text", text: message.content ?? "" }], isError: failed, timestamp: 0,
        });
      }
    }
    return context;
  }

  contextSize(messages: Message[], tools: ToolSpec[]): number {
    return JSON.stringify(this.context(messages, tools)).length;
  }

  async ready(signal: AbortSignal): Promise<void> {
    accountModel(this.provider, this.config.model);
    await this.auth.credentials(this.provider, AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]));
  }

  async complete(messages: Message[], tools: ToolSpec[], modelId: string, signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    deadline.throwIfAborted();
    const base = accountModel(this.provider, modelId);
    const credentials = await this.auth.credentials(this.provider, deadline);
    const oauth = getOAuthProvider(this.provider);
    if (!oauth) throw new Error("Subscription authentication adapter is unavailable");
    const model = oauth.modifyModels?.([base], credentials)[0] ?? base;
    const context = this.context(messages, tools);
    let response: AssistantMessage;
    let httpStatus: number | undefined;
    try {
      response = await this.transport(model, context, {
        apiKey: oauth.getApiKey(credentials), signal: deadline, transport: "sse",
        maxTokens: Math.min(this.config.maxOutputTokens, model.maxTokens),
        timeoutMs: this.config.timeoutMs, maxRetries: 0,
        onResponse: (metadata) => {
          if (Number.isInteger(metadata.status) && metadata.status >= 100 && metadata.status <= 599) {
            httpStatus = metadata.status;
          }
        },
      }, onText);
    } catch (error) {
      deadline.throwIfAborted();
      throw requestFailure(this.provider, modelId, error, httpStatus);
    }
    deadline.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw requestFailure(this.provider, modelId, response.errorMessage, httpStatus);
    }
    const input = response.usage.input + response.usage.cacheRead + response.usage.cacheWrite;
    const output = response.usage.output;
    if (![input, output].every((value) => Number.isFinite(value) && value >= 0) || input + output === 0) {
      throw new Error("Subscription provider did not report usable token usage; refusing to execute returned actions");
    }
    const calls = response.content.filter((block) => block.type === "toolCall").map((block) => ({
      id: block.id, type: "function" as const,
      function: { name: block.name, arguments: JSON.stringify(block.arguments) },
    }));
    if (calls.some((call) => !call.id) || new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new Error("Subscription provider returned invalid tool call IDs");
    }
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const message: Message = {
      role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}),
    };
    this.history.set(message, response);
    return {
      message, usage: { inputTokens: input, outputTokens: output },
      finishReason: response.stopReason === "toolUse" ? "tool_calls" : response.stopReason,
    };
  }
}
