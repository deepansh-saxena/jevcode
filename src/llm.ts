import { z } from "zod";
import type { Config } from "./config.js";
import { postJson, type Usage } from "./http.js";

export const toolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface Completion {
  message: Message;
  usage: Usage;
  finishReason: string;
}
export interface CodingModel {
  complete(messages: Message[], tools: ToolSpec[], model: string, signal: AbortSignal, onText?: (text: string) => void): Promise<Completion>;
  contextSize?(messages: Message[], tools: ToolSpec[]): number;
  exportHistory?(messages: Message[]): unknown;
  restoreHistory?(messages: Message[], history: unknown): void;
}

export async function createCodingModel(config: Config["llm"], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<CodingModel> {
  if (config.provider === "openai-compatible") {
    const key = env[config.apiKeyEnv];
    if (!key) throw new Error(`Missing ${config.apiKeyEnv}; alternatively run: jevcode login copilot (or openai)`);
    return new OpenAICompatible(config, key);
  }
  const [{ SubscriptionModel }, { defaultAuthManager }] = await Promise.all([
    import("./subscription-model.js"), import("./auth-driver.js"),
  ]);
  const model = new SubscriptionModel(config, config.provider, defaultAuthManager());
  await model.ready(signal);
  return model;
}

const responseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string().nullable(),
      tool_calls: z.array(toolCallSchema).optional(),
      refusal: z.string().nullable().optional(),
    }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
  }),
});

export class OpenAICompatible implements CodingModel {
  constructor(private config: Config["llm"], private key: string) {}

  async complete(messages: Message[], tools: ToolSpec[], model: string, signal: AbortSignal, onText?: (text: string) => void): Promise<Completion> {
    const raw = await postJson(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      `Bearer ${this.key}`, {
        model, messages, max_completion_tokens: this.config.maxOutputTokens,
        ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      }, signal, this.config.timeoutMs);
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("Invalid chat completion response; assistant message and token usage are required");
    }
    const choice = parsed.data.choices[0]!;
    if (choice.message.refusal) throw new Error("The coding model declined the request");
    const calls = choice.message.tool_calls;
    if (calls && new Set(calls.map((call) => call.id)).size !== calls.length) {
      throw new Error("Coding model returned duplicate tool call IDs");
    }
    if (choice.message.content) onText?.(choice.message.content);
    return {
      message: {
        role: "assistant", content: choice.message.content,
        ...(calls?.length ? { tool_calls: calls } : {}),
      },
      usage: {
        inputTokens: parsed.data.usage.prompt_tokens,
        outputTokens: parsed.data.usage.completion_tokens,
      },
      finishReason: choice.finish_reason,
    };
  }
}
