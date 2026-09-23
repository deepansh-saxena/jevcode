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
          [--read-only|--confirm-edits] [--commands] [--execution] [--plan] [--skill ID ...] [--specialist ID] [--resume UUID|--continue]
          [--plain|--fullscreen] [--image WORKSPACE_FILE ...] [--auto-compact]
          [--jev-off]
  jevcode chat [same options]
  jevcode serve [--cwd DIR] [--provider copilot|openai|api] [--model ID] [--plan]
  jevcode init [--cwd DIR]
  jevcode inspect [--cwd DIR]
  jevcode skills search QUERY [--cwd DIR]
  jevcode skills preview OWNER/REPO@SKILL [--cwd DIR]
  jevcode skills install OWNER/REPO@SKILL --write [--cwd DIR]
  jevcode login <copilot|openai> [--cwd DIR] [--model ID]
  jevcode logout <copilot|openai>
  jevcode auth status
  jevcode models <copilot|openai>
  jevcode jev <setup|status|off|logout> [--cwd DIR]
  jevcode benchmark <suite.json> [--cwd DIR]
  jevcode benchmark-code <suite.json> --allow-verifier-code [--preflight] [--cwd DIR]
  jevcode evaluate-guardrails <suite.json> [--cwd DIR]
  jevcode run [--cwd DIR] [--skill ID ...] [--specialist ID]
               [--provider copilot|openai|api] [--model ID]
               [--write] [--commands] [--execution] [--plan] [--image WORKSPACE_FILE ...] [--json] "task"

Interactive chat edits workspace files automatically by default. --read-only disables edits;
--confirm-edits asks before each edit. Commands, skill installs and MCP still require approval.
Scripted run is read-only by default. --write, --commands, and --execution expose those tools,
but EACH mutating action still requires interactive approval.
--commands exposes configured commands; --execution separately enables arbitrary shell.
Commands execute project code with your OS permissions, NOT in a sandbox.
--plan forces read-only investigation and planning even when edit flags are present.
In chat, /help lists commands; /permissions enables tools and /skills or /agents
can ask the coding model to create reusable capabilities after approval.
Interactive chat uses the visual TUI by default. --plain keeps the readline interface.
--image explicitly consents to sending validated image bytes to the coding provider.
serve uses versioned newline-delimited JSON over stdin/stdout; never network listeners.
benchmark-code executes trusted suite code; the verifier is NOT a security sandbox.
--preflight validates fixture failures offline, without project configuration or provider access.

Configuration: .jev/config.json
Account credentials: ~/.jev-code/auth/ (private files, separate from this project).
API-key mode: OPENAI_API_KEY; TYPESAFE_API_KEY only when using Jev.
openai login means ChatGPT/Codex subscription access, not OpenAI Platform billing.
Jev-first startup guides new workspaces through key setup and data-sharing consent.
Choose off during setup or pass --jev-off explicitly; configured guardrails cannot be bypassed.
`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true, strict: true,
    options: {
      cwd: { type: "string" }, skill: { type: "string", multiple: true },
      specialist: { type: "string" }, write: { type: "boolean" },
      commands: { type: "boolean" }, json: { type: "boolean" },
      execution: { type: "boolean" },
      "read-only": { type: "boolean" }, "confirm-edits": { type: "boolean" },
      "jev-off": { type: "boolean" },
      "allow-verifier-code": { type: "boolean" }, preflight: { type: "boolean" },
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
  if (values["read-only"] && (values.write || values.commands || values.execution)) throw new Error("--read-only cannot be combined with write or command permissions");
  if (values["confirm-edits"] && command !== "chat") throw new Error("--confirm-edits is only supported by interactive chat");
  if (values["jev-off"] && !["chat", "run", "serve"].includes(command)) throw new Error("--jev-off is only supported by chat, run, or serve");
  if (values.resume && values.continue) throw new Error("Choose --resume or --continue, not both");
  if ((values.image?.length ?? 0) > MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per task`);
  const root = path.resolve(values.cwd ?? process.cwd());
  if ((values.preflight || values["allow-verifier-code"]) && command !== "benchmark-code") {
    throw new Error("--preflight and --allow-verifier-code are only supported by benchmark-code");
  }
  if (command === "benchmark-code") {
    if (positionals.length !== 2) throw new Error("Usage: jevcode benchmark-code <suite.json> --allow-verifier-code [--preflight]");
    if (!values["allow-verifier-code"]) throw new Error("Verifier code is NOT sandboxed. Review the suite and explicitly consent with --allow-verifier-code");
    const suite = JSON.parse(await readText(path.resolve(root, positionals[1]!), 1_000_000));
    const { benchmarkCode, preflightCodingBenchmark } = await import("./coding-evaluation.js");
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Coding evaluation cancelled by user"));
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    process.on("SIGHUP", abort);
    try {
      let result;
      if (values.preflight) result = await preflightCodingBenchmark(suite, controller.signal, { allowVerifierCode: true });
      else {
        const project = await loadProject(root, { globalRoot: null });
        if (values.provider) {
          const provider = providerName(values.provider);
          if (provider !== project.config.llm.provider && !values.model) {
            throw new Error("Changing the benchmark provider also requires an explicit --model");
          }
          project.config.llm.provider = provider;
        }
        if (values.model) project.config.llm.model = values.model;
        result = await benchmarkCode(project, suite, controller.signal, { allowVerifierCode: true });
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.cancelled) process.exitCode = 130;
      else if ("valid" in result ? !result.valid : !result.validComparison) process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGHUP", abort);
    }
    return;
  }
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
    process.stdout.write("Created .jev/ with separate skills and specialists. Configure the coding provider; first coding startup will guide Jev setup (default: on) or an explicit off choice.\n");
    return;
  }
  if (command === "skills") {
    const action = positionals[1];
    if (!action || !["search", "preview", "install"].includes(action) || positionals.length < 3 ||
      (action !== "search" && positionals.length !== 3)) {
      throw new Error("Usage: jevcode skills search QUERY | preview OWNER/REPO@SKILL | install OWNER/REPO@SKILL --write");
    }
    if (action === "install" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      throw new Error("Skill installation requires an interactive terminal for exact-file approval; use skills preview to inspect without installing");
    }
    const project = await loadProject(root);
    const { handleMarketplaceCommand } = await import("./marketplace.js");
    const controller = new AbortController();
    const abort = (): void => controller.abort(new Error("Marketplace operation cancelled"));
    const terminal = action === "install" ? new PlainTerminal(project) : undefined;
    if (terminal) terminal.onCancel = abort;
    for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(event, abort);
    try {
      await handleMarketplaceCommand(action, positionals.slice(2).join(" "), project,
        { write: values.write ?? false, planMode: values.plan ?? false }, {
          signal: controller.signal, write: (text) => process.stdout.write(terminalSafe(text)),
          confirm: async (prompt, signal) => {
            if (!terminal) throw new Error("Interactive approval is unavailable");
            return (await terminal.read(prompt, true, signal))?.trim().toLowerCase() === "yes";
          },
        });
    } finally {
      terminal?.close();
      for (const event of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.removeListener(event, abort);
    }
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
  const { ensureJevSetup } = await import("./jev-cli.js");
  await ensureJevSetup(project, values["jev-off"] ?? false, command !== "serve" && Boolean(process.stdin.isTTY && process.stderr.isTTY));
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
      permissions: { write: !values["read-only"], commands: values.commands ?? false, execution: values.execution ?? false },
    }, values.resume, values.plan ?? false, {
      fullscreen: values.fullscreen ?? (!values.plain && process.env.TERM !== "dumb"), continue: values.continue ?? false,
      images: values.image ?? [], autoCompact: values["auto-compact"] ?? false,
      editApproval: values["confirm-edits"] ? "confirm" : "auto",
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
    process.on("SIGHUP", abort);
    try {
      await serve(project, { skills: values.skill ?? [], ...(values.specialist ? { specialistId: values.specialist } : {}),
        permissions: { write: values.write ?? false, commands: values.commands ?? false, execution: values.execution ?? false } },
      { signal: controller.signal, planMode: values.plan ?? false });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      process.removeListener("SIGHUP", abort);
    }
    return;
  }
  const task = positionals.slice(1).join(" ").trim();
  if (!task) throw new Error("run requires a task");
  const images = await Promise.all((values.image ?? []).map((relative) => readImage(project.workspace, relative)));
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Cancelled by user"));
  const log = await createEventLog(project.workspace.root, (event, data = {}) => {
    if (event === "shell_output" && typeof data.text === "string") {
      process.stderr.write(terminalSafe(data.text));
    }
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
      permissions: { write: values.write ?? false, commands: values.commands ?? false, execution: values.execution ?? false },
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
