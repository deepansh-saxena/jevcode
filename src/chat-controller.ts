import { handleChatCommand, recordRun, type ChatCommandResult, type ChatState, type CommandIO } from "./chat-commands.js";
import { contextSize } from "./context.js";
import { createEventLog, type Emit } from "./events.js";
import { run, type RunOptions, type RunResult } from "./runtime.js";
import { createChatServices } from "./chat-services.js";
import { RunBudget } from "./budget.js";

export interface ControllerIO extends CommandIO {
  event: Emit;
  askUser: NonNullable<RunOptions["askUser"]>;
}

export interface ChatServices {
  command?: (line: string, state: ChatState, io: CommandIO) => Promise<ChatCommandResult | undefined>;
  runOptions?: Partial<RunOptions>;
  refresh?: () => Promise<void>;
  readOnly?: () => Promise<void>;
  close?: () => Promise<void>;
}

export class ChatController {
  private busy = false;
  private services: ChatServices;
  private lifetime = new AbortController();
  private closing?: Promise<void>;
  constructor(readonly state: ChatState, services?: ChatServices) {
    this.services = services ?? createChatServices(state);
  }

  async submit(line: string, io: ControllerIO): Promise<{ kind: "exit" | "handled" } | { kind: "result"; result: RunResult }> {
    this.lifetime.signal.throwIfAborted();
    if (this.busy) throw new Error("Another turn is active; cancel it or wait");
    if (!line.trim() || line.length > 48_000) throw new Error("Input must contain 1-48000 characters");
    const signal = AbortSignal.any([io.signal, this.lifetime.signal]);
    const confirm = io.confirm;
    io = { ...io, signal, confirm: (prompt, requestSignal = signal) => confirm(prompt, requestSignal) };
    this.busy = true;
    try {
      io.signal.throwIfAborted();
      const command = await this.services.command?.(line, this.state, io) ?? await handleChatCommand(line, this.state, io);
      await this.services.refresh?.();
      if (command.kind !== "task") return command;
      if (command.readOnly) await this.services.readOnly?.();
      const budget = new RunBudget(this.state.project.config);
      if (this.state.autoCompact && this.state.messages.some((message) => message.role === "assistant") &&
        contextSize(this.state.model, this.state.messages, []) >= this.state.project.config.limits.maxContextChars * 0.65) {
        io.event("auto_compaction_started");
        // Failure intentionally stops this turn rather than discarding history or hiding extra model usage.
        await handleChatCommand("/compact", this.state, { ...io, budget });
        io.event("auto_compaction_completed");
      }
      const priorBudget = { turns: budget.turns, reportedCostUsd: budget.reportedCostUsd };
      const images = this.state.attachments ?? [];
      const log = await createEventLog(this.state.project.workspace.root, io.event);
      try {
        this.state.attachments = [];
        let streamed = false;
        const result = await run(this.state.project, {
          ...this.services.runOptions, ...this.state.settings,
          budget,
          task: command.task, images, model: this.state.model, conversation: this.state.messages,
          planMode: this.state.planMode, signal: io.signal, emit: log.emit,
          ...(command.skills ? { skills: command.skills } : {}),
          ...(command.skillArguments ? { skillArguments: command.skillArguments } : {}),
          ...(command.specialistId ? { specialistId: command.specialistId } : {}),
          ...(command.readOnly ? { permissions: { write: false, commands: false, execution: false, external: false } } : {}),
          onText(text) { streamed = true; io.write(text); },
          async approve(action, signal) {
            signal.throwIfAborted();
            return await io.confirm(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\nType yes to execute this exact action: `, signal) && !signal.aborted;
          },
          askUser: io.askUser,
        });
        recordRun(this.state, result, priorBudget);
        if (!streamed || result.status !== "completed") io.write(`\n${result.text}`);
        io.write("\n");
        io.event("turn_finished", { status: result.status, metrics: result.metrics, eventLog: log.path });
        return { kind: "result", result };
      } finally { log.close(); }
    } finally { this.busy = false; }
  }

  close(): Promise<void> {
    this.lifetime.abort(new Error("Chat controller closed"));
    return this.closing ??= Promise.resolve().then(() => this.services.close?.());
  }
}
