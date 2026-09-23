import type { Project } from "./registry.js";
import { createCodingModel } from "./llm.js";
import type { RunOptions } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { latestSession, restoreSession } from "./session.js";
import { newChatMetrics, type ChatState } from "./chat-commands.js";
import { ChatController, type ChatServices } from "./chat-controller.js";
import { fullscreenTerminal, PlainTerminal } from "./chat-terminal.js";
import { composeInEditor } from "./chat-files.js";

export interface ChatOptions {
  fullscreen?: boolean;
  continue?: boolean;
  images?: string[];
  autoCompact?: boolean;
  services?: ChatServices;
}

export async function chat(project: Project, settings: Pick<RunOptions, "permissions" | "skills" | "specialistId">,
  resume?: string, planMode = false, options: ChatOptions = {}): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Chat requires an interactive terminal; use jevcode run or serve for scripts");
  const model = await createCodingModel(project.config.llm, process.env, AbortSignal.timeout(project.config.llm.timeoutMs));
  const sessionId = resume ?? (options.continue ? await latestSession(project) : undefined);
  const state: ChatState = { project, model, messages: sessionId ? await restoreSession(project, sessionId, model) : [],
    settings, planMode, runs: 0, compactions: 0, metrics: newChatMetrics(), autoCompact: options.autoCompact ?? false };
  const app = new ChatController(state, options.services);
  const terminal = options.fullscreen ? await fullscreenTerminal(project) : new PlainTerminal(project);
  let controller: AbortController | undefined;
  let closed = false;
  terminal.onCancel = () => {
    if (controller) controller.abort(new Error("Cancelled by user"));
    else { closed = true; terminal.close(); }
  };
  const abort = (): void => { closed = true; controller?.abort(new Error("Terminal terminated")); terminal.close(); };
  process.on("SIGTERM", abort);
  process.on("SIGHUP", abort);
  terminal.write(`Jev Code | ${project.config.llm.provider}/${project.config.llm.model} | Jev ${project.config.jev.mode}\n`);
  terminal.write("Context stays in memory; /save explicitly persists it. /help lists commands. Ctrl-C cancels a turn or exits.\n");
  terminal.write(options.fullscreen ? "Enter inserts a newline; Ctrl-S submits. Tab completes commands.\n" :
    "Tab completes commands. /paste starts multiline input; /end submits it. --fullscreen opens the visual interface.\n");
  terminal.write("Each mutation needs fresh exact-action approval. Busy input is queued, never treated as approval.\n");
  if (state.planMode) terminal.write("Plan mode: read-only investigation and planning; no edits or commands.\n");
  const startup = (options.images ?? []).map((image) => `/attach ${image}`);
  try {
    while (!closed) {
      const line = startup.shift() ?? await terminal.read("jevcode> ");
      if (line === null) break;
      if (!line.trim()) continue;
      controller = new AbortController();
      const signal = controller.signal;
      let liveInput = 0;
      let liveOutput = 0;
      const activity = (text: string): void => terminal.status(options.fullscreen ?
        `${project.config.llm.model} | ${state.planMode ? "plan" : "chat"} | ${liveInput} in / ${liveOutput} out | ${text}` : text);
      try {
        const result = await app.submit(line.trim(), {
          signal, write: (text) => terminal.write(text),
          confirm: async (prompt, requestSignal = signal) => {
            const answer = await terminal.read(prompt, true, requestSignal);
            return !requestSignal.aborted && answer?.trim().toLowerCase() === "yes";
          },
          askUser: async (question, requestSignal) => {
            const answer = await terminal.read(`${question.question}\n${question.choices?.map((choice, index) => `${index + 1}. ${choice}`).join("\n") ?? ""}\nAnswer: `,
              true, requestSignal);
            requestSignal.throwIfAborted();
            if (!answer?.trim()) throw new Error("Clarification dismissed without an answer");
            return answer.trim();
          },
          editor: () => composeInEditor(signal, (work) => terminal.suspend(work)),
          event(event, data = {}) {
            if (event === "usage") {
              liveInput += typeof data.inputTokens === "number" ? data.inputTokens : 0;
              liveOutput += typeof data.outputTokens === "number" ? data.outputTokens : 0;
              if (options.fullscreen) activity("working");
            } else if (event === "llm_request") activity(`thinking: ${String(data.role)}`);
            else if (event === "turn_finished") {
              activity(String(data.status));
              terminal.write(`${state.metrics.llm.inputTokens} input / ${state.metrics.llm.outputTokens} output tokens; log: ${String(data.eventLog)}\n`);
            } else if (["routing", "tool_started", "tool_error", "routing_fallback", "context_pruned",
              "auto_compaction_started", "auto_compaction_completed", "task_started"].includes(event)) {
              activity(`${event}: ${JSON.stringify(event === "routing" ? data.effective ?? data : data)}`);
            }
          },
        });
        if (result.kind === "exit") break;
      } catch (error) {
        terminal.write(`Error: ${errorMessage(error)}\n`);
      } finally { controller = undefined; }
    }
  } finally {
    closed = true;
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGHUP", abort);
    terminal.close();
    await app.close();
  }
}
