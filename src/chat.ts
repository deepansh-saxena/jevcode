import { createInterface } from "node:readline/promises";
import type { Project } from "./registry.js";
import { createCodingModel } from "./llm.js";
import { run, type RunOptions } from "./runtime.js";
import { createEventLog } from "./events.js";
import { errorMessage } from "./errors.js";
import { terminalSafe } from "./terminal.js";
import { restoreSession } from "./session.js";
import { commandCompletions, handleChatCommand, newChatMetrics, recordRun, type ChatState } from "./chat-commands.js";

export async function chat(project: Project, settings: Pick<RunOptions, "permissions" | "skills" | "specialistId">,
  resume?: string, planMode = false): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Chat requires an interactive terminal; use jevcode run for scripts");
  const model = await createCodingModel(project.config.llm, process.env, AbortSignal.timeout(project.config.llm.timeoutMs));
  const state: ChatState = { project, model, messages: resume ? await restoreSession(project, resume, model) : [],
    settings, planMode, runs: 0, compactions: 0, metrics: newChatMetrics() };
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true,
    completer: (line: string) => commandCompletions(project, line) });
  let controller: AbortController | undefined;
  let closed = false;
  const queued: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let approving = false;
  readline.on("line", (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else if (!approving) {
      queued.push(line);
      process.stderr.write("\n[message queued; Ctrl-C cancels the current turn]\n");
    }
  });
  readline.on("close", () => {
    closed = true;
    controller?.abort(new Error("Terminal input closed"));
    waiting?.(null);
    waiting = undefined;
  });
  readline.on("SIGINT", () => {
    if (controller) {
      controller.abort(new Error("Cancelled by user"));
      waiting?.(null);
      waiting = undefined;
    } else readline.close();
  });
  const input = (prompt: string): Promise<string | null> => {
    if (closed) return Promise.resolve(null);
    readline.setPrompt(prompt);
    readline.prompt();
    return new Promise((resolve) => { waiting = resolve; });
  };
  const confirm = async (prompt: string): Promise<boolean> => {
    controller?.signal.throwIfAborted();
    approving = true;
    try {
      const answer = await input(prompt);
      return !closed && !controller?.signal.aborted && answer?.trim().toLowerCase() === "yes";
    } finally { approving = false; }
  };
  process.stderr.write(terminalSafe(`Jev Code | ${project.config.llm.provider}/${project.config.llm.model} | Jev ${project.config.jev.mode}\n`));
  process.stderr.write("Chat keeps context in memory. Type /help for commands. Ctrl-C cancels a turn; at the prompt it exits.\n");
  process.stderr.write("Use /permissions to enable edits, /skills or /agents to create capabilities. Tab completes slash commands.\n");
  process.stderr.write("Writes and commands still require exact-action approval. Messages typed while busy are queued.\n");
  if (state.planMode) process.stderr.write("Plan mode: read-only investigation and planning; no edits or commands.\n");
  try {
    while (!closed) {
      const line = queued.length ? queued.shift()! : await input("jevcode> ");
      if (line === null) break;
      const task = line.trim();
      if (!task) continue;
      try {
        controller = new AbortController();
        const command = await handleChatCommand(task, state, {
          write: (text) => process.stdout.write(terminalSafe(text)), confirm, signal: controller.signal,
        });
        if (command.kind === "exit") break;
        if (command.kind === "handled") continue;
        let streamed = false;
        const log = await createEventLog(project.workspace.root, (event, data = {}) => {
          if (["tool_started", "tool_error", "routing_fallback", "context_pruned", "specialist_limit", "specialist_report_invalid", "guardrail_shadow", "skill_loaded", "specialist_delegated"].includes(event)) {
            process.stderr.write(terminalSafe(`\n[${event}] ${JSON.stringify(data)}\n`));
          } else if (event === "routing") {
            process.stderr.write(terminalSafe(`\n[routing] ${JSON.stringify(data.effective ?? {
              skillIds: data.skillIds, specialistId: data.specialistId,
            })}\n`));
          } else if (event === "llm_request") process.stderr.write(`\n[thinking: ${String(data.role)}]\n`);
        });
        try {
          const result = await run(project, {
            ...state.settings, task: command.task, model: state.model, conversation: state.messages,
            planMode: state.planMode, signal: controller.signal, emit: log.emit,
            ...(command.skills ? { skills: command.skills } : {}),
            ...(command.specialistId ? { specialistId: command.specialistId } : {}),
            ...(command.readOnly ? { permissions: { write: false, commands: false } } : {}),
            onText(text) { streamed = true; process.stdout.write(terminalSafe(text)); },
            async approve(action, signal) {
              signal.throwIfAborted();
              process.stderr.write(terminalSafe(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\n`));
              const cancel = (): void => { waiting?.(null); waiting = undefined; };
              signal.addEventListener("abort", cancel, { once: true });
              try {
                return await confirm("Type yes to execute this exact action: ") && !signal.aborted;
              } finally { signal.removeEventListener("abort", cancel); }
            },
          });
          recordRun(state, result);
          if (!streamed || result.status !== "completed") process.stdout.write(terminalSafe(`\n${result.text}`));
          process.stdout.write("\n");
          process.stderr.write(`[${result.status}] ${result.metrics.durationMs}ms; ${result.metrics.turns} turns; log: ${log.path}\n`);
        } finally { log.close(); }
      } catch (error) {
        process.stderr.write(terminalSafe(`Error: ${errorMessage(error)}\n`));
      } finally { controller = undefined; }
    }
  } finally { readline.close(); }
}
