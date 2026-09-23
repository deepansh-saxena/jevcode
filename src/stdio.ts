import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { ChatController, type ChatServices } from "./chat-controller.js";
import { newChatMetrics, type ChatState } from "./chat-commands.js";
import { createCodingModel, type CodingModel } from "./llm.js";
import type { Project } from "./registry.js";
import type { RunOptions } from "./runtime.js";
import { errorMessage } from "./errors.js";

const id = z.string().min(1).max(100);
const correlation = { runId: id, requestId: z.string().uuid() };
const requestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("prompt"), params: z.object({ text: z.string().min(1).max(48_000) }).strict() }).strict(),
  z.object({ id, method: z.literal("approve"), params: z.object({ ...correlation, approved: z.boolean() }).strict() }).strict(),
  z.object({ id, method: z.literal("answer"), params: z.object({ ...correlation, answer: z.string().min(1).max(12_000) }).strict() }).strict(),
  z.object({ id, method: z.literal("cancel"), params: z.object({ runId: id }).strict() }).strict(),
  z.object({ id, method: z.literal("status") }).strict(),
]);

export interface ServeOptions {
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  model?: CodingModel;
  services?: ChatServices;
  planMode?: boolean;
}

export async function serve(project: Project, settings: Pick<RunOptions, "permissions" | "skills" | "specialistId">,
  options: ServeOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  options.signal?.throwIfAborted();
  const model = options.model ?? await createCodingModel(project.config.llm, process.env,
    AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(project.config.llm.timeoutMs)]));
  const state: ChatState = { project, model, settings, planMode: options.planMode ?? false,
    messages: [], metrics: newChatMetrics(), runs: 0, compactions: 0 };
  const app = new ChatController(state, options.services);
  let active: { id: string; controller: AbortController; done: Promise<void> } | undefined;
  let pending: { id: string; runId: string; kind: "approval" | "question"; resolve: (value: string | boolean) => void } | undefined;
  let ended = false;
  let closing = false;
  const seen = new Set<string>();
  const send = (message: unknown): void => {
    if (ended || output.destroyed) return;
    if (output.writableLength > 2_000_000) {
      ended = true;
      active?.controller.abort(new Error("Protocol output limit exceeded"));
      input.destroy();
      return;
    }
    output.write(`${JSON.stringify(message)}\n`);
  };
  const response = (requestId: string | null, result: unknown, error?: string): void =>
    send(error ? { type: "response", id: requestId, error } : { type: "response", id: requestId, result });
  const event = (name: string, data: unknown, runId?: string): void =>
    send({ type: "event", event: name, ...(runId ? { runId } : {}), data });
  const ask = (runId: string, kind: "approval" | "question", data: unknown, signal: AbortSignal): Promise<string | boolean> => {
    signal.throwIfAborted();
    if (pending) throw new Error("Another user response is pending");
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const abort = (): void => {
        if (pending?.id === requestId) pending = undefined;
        event("interaction_cancelled", { requestId }, runId);
        reject(new Error("User interaction cancelled"));
      };
      pending = { id: requestId, runId, kind, resolve(value) {
        signal.removeEventListener("abort", abort);
        pending = undefined;
        resolve(value);
      } };
      signal.addEventListener("abort", abort, { once: true });
      event(kind === "approval" ? "approval_request" : "question", { requestId, details: data }, runId);
    });
  };
  const handle = (line: string): void => {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { response(null, null, "Invalid JSON"); return; }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) { response(null, null, "Invalid protocol request"); return; }
    const request = parsed.data;
    if (seen.has(request.id)) { response(request.id, null, "Duplicate request ID"); return; }
    if (seen.size >= 10_000) { response(request.id, null, "Request limit reached; start a new session"); return; }
    seen.add(request.id);
    if (request.method === "status") {
      response(request.id, { activeRunId: active?.id ?? null, pending: pending ? { requestId: pending.id, kind: pending.kind } : null,
        model: project.config.llm.model, provider: project.config.llm.provider, planMode: state.planMode,
        permissions: state.settings.permissions, usage: state.metrics });
    } else if (request.method === "cancel") {
      if (active?.id !== request.params.runId) { response(request.id, null, "No matching active run"); return; }
      active.controller.abort(new Error("Cancelled by client"));
      response(request.id, { cancelled: true });
    } else if (request.method === "approve" || request.method === "answer") {
      if (!pending || active?.controller.signal.aborted || pending.id !== request.params.requestId ||
        pending.runId !== request.params.runId || pending.kind !== (request.method === "approve" ? "approval" : "question")) {
        response(request.id, null, "No matching pending interaction"); return;
      }
      pending.resolve(request.method === "approve" ? request.params.approved : request.params.answer);
      response(request.id, { accepted: true });
    } else {
      if (active) { response(request.id, null, "Busy; cancel the current run or wait"); return; }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, options.signal ?? controller.signal]);
      // Install active identity before asynchronous command dispatch can request consent.
      const work = Promise.resolve().then(async () => {
        try {
          event("turn_started", {}, request.id);
          const result = await app.submit(request.params.text, {
            signal,
            write: (text) => event("text", { text }, request.id),
            event: (name, data = {}) => event(name, data, request.id),
            confirm: async (prompt, requestSignal = signal) =>
              await ask(request.id, "approval", { prompt }, requestSignal) === true && !requestSignal.aborted,
            askUser: async (question, requestSignal) => String(await ask(request.id, "question", question, requestSignal)),
          });
          response(request.id, result);
          if (result.kind === "exit") { closing = true; input.destroy(); }
        } catch (error) { response(request.id, null, errorMessage(error)); }
        finally { pending = undefined; active = undefined; }
      });
      active = { id: request.id, controller, done: work };
    }
  };
  const stop = (): void => { active?.controller.abort(new Error("Protocol input closed")); input.destroy(); };
  const outputError = (): void => { ended = true; stop(); };
  options.signal?.addEventListener("abort", stop, { once: true });
  output.on("error", outputError);
  send({ type: "ready", protocol: "jevcode", version: 1, maxLineBytes: 65_536,
    capabilities: ["prompt", "commands", "approval", "question", "cancel", "status"],
    persistence: "explicit-save-only" });
  let buffer = "";
  let discarding = false;
  const decoder = new StringDecoder("utf8");
  try {
    for await (const chunk of input) {
      if (ended) break;
      const text = typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
      for (const part of text.split(/(?<=\n)/)) {
        if (!discarding) buffer += part;
        if (Buffer.byteLength(buffer) > 65_536) {
          buffer = ""; discarding = true; response(null, null, "Protocol line exceeds 65536 bytes");
        }
        if (part.endsWith("\n")) {
          if (!discarding && buffer.trim()) handle(buffer);
          buffer = ""; discarding = false;
        }
      }
    }
    if (buffer.trim()) response(null, null, "Incomplete protocol line; terminate each request with a newline");
  } catch (error) {
    if (!options.signal?.aborted && !ended && !closing) throw error;
  } finally {
    active?.controller.abort(new Error("Protocol input closed"));
    await active?.done;
    ended = true;
    options.signal?.removeEventListener("abort", stop);
    output.removeListener("error", outputError);
    await app.close();
  }
}
