import { createInterface } from "node:readline/promises";
import type { Project } from "./registry.js";
import { createCodingModel, type Message } from "./llm.js";
import { run, type RunOptions } from "./runtime.js";
import { createEventLog } from "./events.js";
import { errorMessage } from "./errors.js";
import { terminalSafe } from "./terminal.js";
import { restoreSession, saveSession } from "./session.js";
import { z } from "zod";

export async function chat(project: Project, settings: Pick<RunOptions, "permissions" | "skills" | "specialistId">,
  resume?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Chat requires an interactive terminal; use jevcode run for scripts");
  const model = await createCodingModel(project.config.llm, process.env, AbortSignal.timeout(project.config.llm.timeoutMs));
  let messages: Message[] = resume ? await restoreSession(project, resume, model) : [];
  const readline = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
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
  process.stderr.write(terminalSafe(`Jev Code | ${project.config.llm.provider}/${project.config.llm.model} | Jev ${project.config.jev.mode}\n`));
  process.stderr.write("Chat keeps context in memory. Type /help for commands. Ctrl-C cancels a turn; at the prompt it exits.\n");
  process.stderr.write("Writes and commands still require exact-action approval. Messages typed while busy are queued.\n");
  try {
    while (!closed) {
      const line = queued.length ? queued.shift()! : await input("jevcode> ");
      if (line === null) break;
      const task = line.trim();
      if (!task) continue;
      try {
        if (task === "/exit" || task === "/quit") break;
        if (task === "/help") {
          process.stdout.write("/help /exit /clear /status /save /resume UUID /jev off|shadow|on\n/save writes a private snapshot containing conversation and file contents. Nothing is saved automatically.\n");
          continue;
        }
        if (task === "/clear") { messages = []; process.stdout.write("Conversation cleared; workspace files are unchanged.\n"); continue; }
        if (task === "/status") {
          process.stdout.write(`${JSON.stringify({
            provider: project.config.llm.provider, model: project.config.llm.model, jev: project.config.jev.mode,
            messages: messages.length, permissions: settings.permissions, limits: project.config.limits,
          }, null, 2)}\n`);
          continue;
        }
        if (task.startsWith("/jev ")) {
          const parsed = z.enum(["off", "shadow", "on"]).safeParse(task.slice(5));
          if (!parsed.success) throw new Error("Usage: /jev off|shadow|on");
          const mode = parsed.data;
          if (mode !== "off" && !project.config.jev.allowDataSharing) {
            throw new Error("Jev requires explicit data-sharing consent. Exit and run: jevcode jev setup");
          }
          project.config.jev.mode = mode;
          process.stdout.write(`Jev routing ${mode} for this chat; required guardrails are unchanged.\n`);
          continue;
        }
        if (task === "/save") {
          const answer = await input("Save conversation, file contents, and provider history unencrypted in a private local snapshot? Type yes: ");
          if (answer?.trim().toLowerCase() !== "yes") { process.stdout.write("Not saved.\n"); continue; }
          process.stdout.write(`Saved. Resume with: jevcode --resume ${await saveSession(project, messages, model)}\n`);
          continue;
        }
        if (task.startsWith("/resume ")) {
          messages = await restoreSession(project, task.slice(8).trim(), model);
          process.stdout.write("Saved conversation restored. Current permissions and project instructions still apply.\n");
          continue;
        }
        if (task.startsWith("/")) throw new Error("Unknown chat command. Type /help");
        controller = new AbortController();
        let streamed = false;
        const log = await createEventLog(project.workspace.root, (event, data = {}) => {
          if (["tool_started", "tool_error", "routing_fallback", "context_pruned", "specialist_limit", "specialist_report_invalid", "guardrail_shadow"].includes(event)) {
            process.stderr.write(terminalSafe(`\n[${event}] ${JSON.stringify(data)}\n`));
          } else if (event === "routing") {
            process.stderr.write(terminalSafe(`\n[routing] ${JSON.stringify(data.effective ?? {
              skillIds: data.skillIds, specialistId: data.specialistId,
            })}\n`));
          } else if (event === "llm_request") process.stderr.write(`\n[thinking: ${String(data.role)}]\n`);
        });
        try {
          const result = await run(project, {
            ...settings, task, model, conversation: messages, signal: controller.signal, emit: log.emit,
            onText(text) { streamed = true; process.stdout.write(terminalSafe(text)); },
            async approve(action, signal) {
              signal.throwIfAborted();
              approving = true;
              process.stderr.write(terminalSafe(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\n`));
              const cancel = (): void => { waiting?.(null); waiting = undefined; };
              signal.addEventListener("abort", cancel, { once: true });
              try {
                const answer = await input("Type yes to execute this exact action: ");
                return !signal.aborted && answer?.trim().toLowerCase() === "yes";
              } finally { approving = false; signal.removeEventListener("abort", cancel); }
            },
          });
          if (!streamed || result.status !== "completed") process.stdout.write(terminalSafe(`\n${result.text}`));
          process.stdout.write("\n");
          process.stderr.write(`[${result.status}] ${result.metrics.durationMs}ms; ${result.metrics.turns} turns; log: ${log.path}\n`);
        } finally { log.close(); controller = undefined; }
      } catch (error) {
        controller = undefined;
        process.stderr.write(terminalSafe(`Error: ${errorMessage(error)}\n`));
      }
    }
  } finally { readline.close(); }
}
