#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { initialize } from "./init.js";
import { loadProject } from "./registry.js";
import { createEventLog } from "./events.js";
import { run } from "./runtime.js";
import { errorMessage } from "./errors.js";
import { providerName } from "./auth.js";
import { defaultAuthManager } from "./auth-driver.js";
import { terminalSafe } from "./terminal.js";

const help = `Jev Code - local coding harness

Usage:
  jevcode init [--cwd DIR]
  jevcode inspect [--cwd DIR]
  jevcode login <copilot|openai> [--cwd DIR] [--model ID]
  jevcode logout <copilot|openai>
  jevcode auth status
  jevcode models <copilot|openai>
  jevcode run [--cwd DIR] [--skill ID ...] [--specialist ID]
               [--provider copilot|openai|api] [--model ID]
               [--write] [--commands] [--json] "task"

Run is read-only by default. --write and --commands expose those tools,
but EACH mutating action still requires interactive approval.
Commands execute project code with your OS permissions, NOT in a sandbox.

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
      provider: { type: "string" }, model: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const command = positionals[0];
  const root = path.resolve(values.cwd ?? process.cwd());
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
  if (command !== "inspect" && command !== "run") throw new Error(`Unknown command: ${command}`);
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
  const task = positionals.slice(1).join(" ").trim();
  if (!task) throw new Error("run requires a task");
  if (values.provider) {
    const provider = providerName(values.provider);
    if (provider !== project.config.llm.provider && !values.model) {
      const { defaultAccountModels } = await import("./subscription-model.js");
      project.config.llm.model = provider === "openai-compatible" ? "gpt-4.1-mini" : defaultAccountModels[provider];
    }
    project.config.llm.provider = provider;
  }
  if (values.model) project.config.llm.model = values.model;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new Error("Cancelled by user"));
  process.on("SIGINT", abort);
  const log = await createEventLog(project.workspace.root, (event, data = {}) => {
    if (["routing_fallback", "jev_error", "tool_error", "specialist_limit"].includes(event)) {
      process.stderr.write(terminalSafe(`[${event}] ${JSON.stringify(data)}\n`));
    }
  });
  try {
    const result = await run(project, {
      task, skills: values.skill ?? [],
      ...(values.specialist ? { specialistId: values.specialist } : {}),
      permissions: { write: values.write ?? false, commands: values.commands ?? false },
      signal: controller.signal, emit: log.emit,
      async approve(action, signal) {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
          process.stderr.write("Approval requires an interactive terminal; action blocked.\n");
          return false;
        }
        process.stderr.write(terminalSafe(`\nApprove ${action.name}?\n${JSON.stringify(action.details, null, 2)}\n`));
        const readline = createInterface({ input: process.stdin, output: process.stderr });
        readline.on("SIGINT", abort);
        try {
          const answer = await readline.question("Type yes to execute this exact action: ", { signal });
          return answer.trim().toLowerCase() === "yes";
        } finally {
          readline.close();
        }
      },
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
    log.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(terminalSafe(`Error: ${errorMessage(error)}\n`));
  process.exitCode = 1;
});
