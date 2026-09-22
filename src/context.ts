import { LimitError } from "./errors.js";
import type { CodingModel, Message, ToolSpec } from "./llm.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function shorten(serialized: string, maxChars: number, contextPruned: boolean): string {
  const value: unknown = JSON.parse(serialized);
  const key = record(value) ? ["content", "output", "error"].find((name) => typeof value[name] === "string") : undefined;
  const text = record(value) && key ? String(value[key]) : serialized;
  const metadata = record(value) && key ? { ...value, [key]: "" } : {};
  const render = (length: number): string => JSON.stringify({
    ...metadata,
    [key ?? "preview"]: text.slice(0, length),
    truncated: true,
    ...(contextPruned ? { contextPruned: true } : {}),
    originalChars: serialized.length,
    note: contextPruned ?
      "Earlier read-only output shortened to preserve context space. Omitted content is not evidence; reread specific lines only if needed." :
      "Tool output shortened to fit its result budget. Omitted content is not evidence.",
  });
  let low = 0;
  let high = text.length;
  let result = render(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = render(middle);
    if (candidate.length <= maxChars) {
      result = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result.length < serialized.length ? result : serialized;
}

export function serializeToolResult(result: unknown, maxChars = 48_000): string {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) throw new Error("Tool returned an unserializable result");
  if (serialized.length <= maxChars) return serialized;
  const shortened = shorten(serialized, maxChars, false);
  if (shortened.length > maxChars) throw new LimitError("Tool-result metadata exceeds the result size limit");
  return shortened;
}

export function contextSize(model: CodingModel, messages: Message[], tools: ToolSpec[]): number {
  return model.contextSize?.(messages, tools) ?? JSON.stringify({ messages, tools }).length;
}

export function pruneContext(
  model: CodingModel, messages: Message[], tools: ToolSpec[], maxChars: number,
): { beforeChars: number; afterChars: number; prunedResults: number } {
  const beforeChars = contextSize(model, messages, tools);
  let afterChars = beforeChars;
  let prunedResults = 0;
  if (beforeChars <= maxChars * 0.75) return { beforeChars, afterChars, prunedResults };
  const names = new Map<string, string>();
  const candidates: { message: Message; index: number }[] = [];
  let latestAssistant = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      latestAssistant = index;
      for (const call of message.tool_calls ?? []) names.set(call.id, call.function.name);
    } else if (message.role === "tool" && message.content &&
      ["read_file", "list_files", "search_files"].includes(names.get(message.tool_call_id ?? "") ?? "")) {
      const value: unknown = JSON.parse(message.content);
      if (record(value) && (Object.hasOwn(value, "error") || value.ok === false || value.contextPruned === true)) continue;
      candidates.push({ message, index });
    }
  }
  for (const { message, index } of candidates) {
    // Keep the newest batch intact unless it cannot fit even after pruning older observations.
    if (afterChars <= maxChars * 0.5 || (index > latestAssistant && afterChars <= maxChars)) break;
    const previous = message.content!;
    const shortened = shorten(previous, 2_000, true);
    if (shortened === previous) continue;
    message.content = shortened;
    const size = contextSize(model, messages, tools);
    if (size >= afterChars) {
      message.content = previous;
      continue;
    }
    afterChars = size;
    prunedResults++;
  }
  return { beforeChars, afterChars, prunedResults };
}
