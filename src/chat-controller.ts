import { handleChatCommand, recordRun, type ChatCommandResult, type ChatState, type CommandIO } from "./chat-commands.js";
import { contextSize } from "./context.js";
import { createEventLog, type Emit } from "./events.js";
import { run, type RunOptions, type RunResult } from "./runtime.js";

export interface ControllerIO extends CommandIO {
  event: Emit;
  askUser: NonNullable<RunOptions["askUser"]>;
}

export interface ChatServices {
  command?: (line: string, state: ChatState, io: CommandIO) => Promise<ChatCommandResult | undefined>;
  runOptions?: Partial<RunOptions>;
  close?: () => Promise<void>;
}

export class ChatController {
  private busy = false;
  constructor(readonly state: ChatState, private services: ChatServices = {}) {}

  async submit(line: string, io: ControllerIO): Promise<{ kind: "exit" | "handled" } | { kind: "result"; result: RunResult }> {
    if (this.busy) throw new Error("Another turn is active; cancel it or wait");
    if (!line.trim() || line.length > 48_000) throw new Error("Input must contain 1-48000 characters");
    this.busy = true;
    try {
      io.signal.throwIfAborted();
      const command = await this.services.command?.(line, this.state, io) ?? await handleChatCommand(line, this.state, io);
      if (command.kind !== "task") return command;
      if (this.state.autoCompact && this.state.messages.some((message) => message.role === "assistant") &&
        contextSize(this.state.model, this.state.messages, []) >= this.state.project.config.limits.maxContextChars * 0.65) {
        const config = this.state.project.config;
        if ("spend" in config && typeof config.spend === "object" && config.spend !== null &&
          "maxUsd" in config.spend && config.spend.maxUsd != null) {
          throw new Error("Automatic compaction is disabled with a dollar cap until its spend can share the run ledger; compact explicitly or start a new conversation");
        }
        io.event("auto_compaction_started");
        // Failure intentionally stops this turn rather than discarding history or hiding extra model usage.
        await handleChatCommand("/compact", this.state, io);
        io.event("auto_compaction_completed");
      }
      const images = this.state.attachments ?? [];
      const log = await createEventLog(this.state.project.workspace.root, io.event);
      try {
        this.state.attachments = [];
        let streamed = false;
        const result = await run(this.state.project, {
          ...this.services.runOptions, ...this.state.settings,
          task: command.task, images, model: this.state.model, conversation: this.state.messages,
          planMode: this.state.planMode, signal: io.signal, emit: log.emit,
          ...(command.skills ? { skills: command.skills } : {}),
          ...(command.specialistId ? { specialistId: command.specialistId } : {}),
          ...(command.readOnly ? { permissions: { write: false, commands: false } } : {}),
          onText(text) { streamed = true; io.write(text); },
          async approve(action, signal) {
            signal.throwIfAborted();
            return await io.confirm(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\nType yes to execute this exact action: `, signal) && !signal.aborted;
          },
          askUser: io.askUser,
        });
        recordRun(this.state, result);
        if (!streamed || result.status !== "completed") io.write(`\n${result.text}`);
        io.write("\n");
        io.event("turn_finished", { status: result.status, metrics: result.metrics, eventLog: log.path });
        return { kind: "result", result };
      } finally { log.close(); }
    } finally { this.busy = false; }
  }

  async close(): Promise<void> { await this.services.close?.(); }
}
