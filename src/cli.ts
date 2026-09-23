#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { initialize } from "./init.js";
import { loadProject } from "./registry.js";
import { createEventLog } from "./events.js";
import { run } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { providerName } from "./auth.js";
import { defaultAuthManager } from "./auth-driver.js";
import { terminalSafe } from "./terminal.js";
import { readText } from "./workspace.js";
import { readImage, MAX_IMAGES } from "./media.js";
import { PlainTerminal } from "./chat-terminal.js";

const help = `Jev Code - local coding harness

Usage:
  jevcode [--cwd DIR] [--provider copilot|openai|api] [--model ID]
          [--write] [--commands] [--plan] [--skill ID ...] [--specialist ID] [--resume UUID|--continue]
          [--plain|--fullscreen] [--image WORKSPACE_FILE ...] [--auto-compact]
  jevcode chat [same options]
  jevcode serve [--cwd DIR] [--provider copilot|openai|api] [--model ID] [--plan]
  jevcode init [--cwd DIR]
  jevcode inspect [--cwd DIR]
  jevcode login <copilot|openai> [--cwd DIR] [--model ID]
  jevcode logout <copilot|openai>
  jevcode auth status
  jevcode models <copilot|openai>
  jevcode jev <setup|status|off|logout> [--cwd DIR]
  jevcode benchmark <suite.json> [--cwd DIR]
  jevcode evaluate-guardrails <suite.json> [--cwd DIR]
  jevcode run [--cwd DIR] [--skill ID ...] [--specialist ID]
               [--provider copilot|openai|api] [--model ID]
               [--write] [--commands] [--plan] [--image WORKSPACE_FILE ...] [--json] "task"

Run is read-only by default. --write and --commands expose those tools,
but EACH mutating action still requires interactive approval.
Commands execute project code with your OS permissions, NOT in a sandbox.
--plan forces read-only investigation and planning even when edit flags are present.
In chat, /help lists commands; /permissions enables tools and /skills or /agents
can ask the coding model to create reusable capabilities after approval.
--plain is the deterministic default. --fullscreen opts into a visual TTY editor.
--image explicitly consents to sending validated image bytes to the coding provider.
serve uses versioned newline-delimited JSON over stdin/stdout; never network listeners.

Configuration: .jev/config.json
Account credentials: ~/.jev-code/auth/ (private files, separate from this project).
API-key mode: OPENAI_API_KEY; TYPESAFE_API_KEY only when using Jev.
openai login means ChatGPT/Codex subscription access, not OpenAI Platform billing.
Jev is disabled by default; enabling it requires allowDataSharing consent.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      cwd: { type: "string" }, skill: { type: "string", multiple: true },
      specialist: { type: "string" }, write: { type: "boolean" },
      commands: { type: "boolean" }, json: { type: "boolean" },
      plan: { type: "boolean" },
      provider: { type: "string" }, model: { type: "string" },
      resume: { type: "string" },
      continue: { type: "boolean" }, plain: { type: "boolean" }, fullscreen: { type: "boolean" },
      image: { type: "string", multiple: true }, "auto-compact": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || (!positionals.length && !process.stdin.isTTY)) { process.stdout.write(help); return; }
  const command = positionals[0] ?? "chat";
  if (values.plain && values.fullscreen) throw new Error("Choose --plain or --fullscreen, not both");
  if (values.resume && values.continue) throw new Error("Choose --resume or --continue, not both");
  if ((values.image?.length ?? 0) > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per task`);
  const root = path.resolve(values.cwd ?? process.cwd());
  if (command === "benchmark" || command === "evaluate-guardrails") {
    if (positionals.length !== 2) throw new Error(`Usage: jevcode ${command} <suite.json>`);
    const project = await loadProject(root);
    const suite = JSON.parse(await readText(await project.workspace.path(positionals[1]!), 1_000_000));
    const { benchmark, evaluateGuardrails } = await import("./evaluation.js");
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Evaluation cancelled by user"));
    process.on("SIGINT", abort);
    try {
      process.stdout.write(`${JSON.stringify(await (command === "benchmark" ?
        benchmark(project, suite, controller.signal) : evaluateGuardrails(project, suite, controller.signal)), null, 2)}\n`);
    } finally { process.removeListener("SIGINT", abort); }
    return;
  }
  if (command === "jev") {
    if (positionals.length !== 2) throw new Error("Usage: jevcode jev <setup|status|off|logout>");
    const { configureJev } = await import("./jev-cli.js");
    await configureJev(root, positionals[1]!);
    return;
  }
  if (command === "auth") {
    if (positionals.length !== 2 || positionals[1] !== "status") throw new Error("Usage: jevcode auth status");
    process.stdout.write(`${JSON.stringify(await defaultAuthManager().status(), null, 2)}\n`);
    return;
  }
  if (command === "login" || command === "logout" || command === "models") {
    if (positionals.length !== 2) throw new Error(`Usage: jevcode ${command} <copilot|openai>`);
    const provider = providerName(positionals[1]!);
    if (provider === "openai-compatible") throw new Error("API-key mode uses OPENAI_API_KEY, not account login or the subscription model catalog");
    if (command === "login") {
      const { loginAccount } = await import("./auth-cli.js");
      await loginAccount(root, provider, values.model);
    } else if (command === "logout") {
      await defaultAuthManager().logout(provider);
      process.stdout.write(`Removed local ${provider} credentials. This does not revoke the account grant or sign out other apps.\n`);
    } else {
      const { accountModels } = await import("./subscription-model.js");
      process.stdout.write(`${accountModels(provider).map((model) => model.id).join("\n")}\n`);
      process.stderr.write("Bundled adapter catalog, not a live account model list; subscription and organization policies apply.\n");
    }
    return;
  }
  if (command === "init") {
    if (positionals.length !== 1) throw new Error("init does not take a task");
    await initialize(root);
    process.stdout.write("Created .jev/ with separate skills and specialists. Set the model and credentials before running.\n");
    return;
  }
  if (command !== "inspect" && command !== "run" && command !== "chat" && command !== "serve") throw new Error(`Unknown command: ${command}`);
  const project = await loadProject(root);
  if (command === "inspect") {
    if (positionals.length !== 1) throw new Error("inspect does not take a task");
    process.stdout.write(`${JSON.stringify({
      config: project.config,
      skills: project.skills,
      specialists: project.specialists,
      projectInstructionsLoaded: Boolean(project.instructions),
    }, null, 2)}\n`);
    return;
  }
  if (values.provider) {
    const provider = providerName(values.provider);
    if (provider !== project.config.llm.provider && !values.model) {
      const { defaultAccountModels } = await import("./subscription-model.js");
      project.config.llm.model = provider === "openai-compatible" ? "gpt-4.1-mini" : defaultAccountModels[provider];
    }
    project.config.llm.provider = provider;
  }
  if (values.model) project.config.llm.model = values.model;
  if (command === "chat") {
    if (positionals.length > 1 || values.json) throw new Error("Chat accepts options, not a task or --json; type your task at the prompt");
    const { chat } = await import("./chat.js");
    await chat(project, {
      skills: values.skill ?? [], ...(values.specialist ? { specialistId: values.specialist } : {}),
      permissions: { write: values.write ?? false, commands: values.commands ?? false },
    }, values.resume, values.plan ?? false, {
      fullscreen: values.fullscreen ?? false, continue: values.continue ?? false,
      images: values.image ?? [], autoCompact: values["auto-compact"] ?? false,
    });
    return;
  }
  if (values.resume || values.continue || values.fullscreen || values["auto-compact"]) throw new Error("--resume, --continue, --fullscreen, and --auto-compact are only supported by interactive chat");
  if (command === "serve") {
    if (positionals.length !== 1 || values.json || values.image) throw new Error("serve uses stream JSON requests; attach images with a /attach prompt");
    const { serve } = await import("./stdio.js");
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Protocol terminated"));
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    try {
      await serve(project, { skills: values.skill ?? [], ...(values.specialist ? { specialistId: values.specialist } : {}),
        permissions: { write: values.write ?? false, commands: values.commands ?? false } },
      { signal: controller.signal, planMode: values.plan ?? false });
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    return;
  }
  const task = positionals.slice(1).join(" ").trim();
  if (!task) throw new Error("run requires a task");
  const images = await Promise.all((values.image ?? []).map((relative) => readImage(project.workspace, relative)));
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Cancelled by user"));
  const log = await createEventLog(project.workspace.root, (event, data = {}) => {
    if (["routing_fallback", "jev_error", "tool_error", "specialist_limit", "specialist_report_invalid", "guardrail_shadow"].includes(event)) {
      process.stderr.write(terminalSafe(`[${event}] ${JSON.stringify(data)}\n`));
    }
  });
  process.on("SIGINT", abort);
  const terminal = process.stdin.isTTY && process.stderr.isTTY ? new PlainTerminal(project) : undefined;
  if (terminal) terminal.onCancel = abort;
  const terminate = (): void => { abort(); terminal?.close(); };
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", terminate);
  try {
    const result = await run(project, {
      task, images, skills: values.skill ?? [],
      ...(values.specialist ? { specialistId: values.specialist } : {}),
      permissions: { write: values.write ?? false, commands: values.commands ?? false },
      planMode: values.plan ?? false,
      signal: controller.signal, emit: log.emit,
      async approve(action, signal) {
        if (!terminal) {
          process.stderr.write("Approval requires an interactive terminal; action blocked.\n");
          return false;
        }
        const answer = await terminal.read(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\nType yes to execute this exact action: `, true, signal);
        return !signal.aborted && answer?.trim().toLowerCase() === "yes";
      },
      ...(terminal ? { askUser: async (question: { question: string; choices?: string[] }, signal: AbortSignal) => {
        const answer = await terminal.read(`${question.question}\n${question.choices?.join("\n") ?? ""}\nAnswer: `, true, signal);
        signal.throwIfAborted();
        if (!answer?.trim()) throw new Error("Clarification dismissed without an answer");
        return answer.trim();
      } } : {}),
    });
    const output = { ...result, runId: log.runId, eventLog: log.path };
    if (values.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(terminalSafe(`${result.text}\n`));
      process.stderr.write(`[${result.status}] ${result.metrics.durationMs}ms; ${result.metrics.turns} model turns; log: ${log.path}\n`);
    }
    if (result.status !== "completed") process.exitCode = result.status === "cancelled" ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", terminate);
    process.removeListener("SIGHUP", terminate);
    terminal?.close();
    log.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(terminalSafe(`Error: ${errorMessage(error)}\n`));
  process.exitCode = 1;
});
