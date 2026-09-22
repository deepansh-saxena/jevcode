import {
  completeSimple, getModels, type Api, type AssistantMessage, type Context,
  type Model, type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { Type } from "typebox";
import type { AccountProvider, AuthManager } from "./auth.js";
import type { Config } from "./config.js";
import type { CodingModel, Completion, Message, ToolSpec } from "./llm.js";

export const defaultAccountModels: Record<AccountProvider, string> = {
  "github-copilot": "gpt-4.1",
  "openai-codex": "gpt-5.4-mini",
};

export function accountModels(provider: AccountProvider): Model<Api>[] {
  return getModels(provider);
}

export function accountModel(provider: AccountProvider, id: string): Model<Api> {
  const model = accountModels(provider).find((candidate) => candidate.id === id);
  if (!model) throw new Error(`Unknown model ${id} for ${provider}. Run: jevcode models ${provider}`);
  return model;
}

export type SubscriptionTransport = (
  model: Model<Api>, context: Context, options: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export class SubscriptionModel implements CodingModel {
  private history = new WeakMap<Message, AssistantMessage>();

  constructor(
    private config: Config["llm"],
    private provider: AccountProvider,
    private auth: AuthManager,
    private transport: SubscriptionTransport = completeSimple,
  ) {}

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

  async complete(messages: Message[], tools: ToolSpec[], modelId: string, signal: AbortSignal): Promise<Completion> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
    deadline.throwIfAborted();
    const base = accountModel(this.provider, modelId);
    const credentials = await this.auth.credentials(this.provider, deadline);
    const oauth = getOAuthProvider(this.provider);
    if (!oauth) throw new Error("Subscription authentication adapter is unavailable");
    const model = oauth.modifyModels?.([base], credentials)[0] ?? base;
    const context = this.context(messages, tools);
    let response: AssistantMessage;
    try {
      response = await this.transport(model, context, {
        apiKey: oauth.getApiKey(credentials), signal: deadline, transport: "sse",
        maxTokens: Math.min(this.config.maxOutputTokens, model.maxTokens),
        timeoutMs: this.config.timeoutMs, maxRetries: 0,
      });
    } catch {
      deadline.throwIfAborted();
      throw new Error(`${this.provider} request failed; check account access and connectivity. Provider response details were withheld.`);
    }
    deadline.throwIfAborted();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      const status = response.errorMessage?.match(/\b(?:401|403|429|5\d\d)\b/)?.[0];
      throw new Error(`${this.provider} request failed${status ? ` (HTTP ${status})` : ""}. Check subscription limits, model access, or log in again.`);
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
