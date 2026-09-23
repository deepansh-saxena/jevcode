import { z } from "zod";
import type { Project } from "./registry.js";
import { loadSkills } from "./registry.js";
import { createCodingModel, type CodingModel, type Message } from "./llm.js";
import type { RunOptions, RunResult } from "./runtime.js";
import { createTools, toolSpecs } from "./tools.js";
import { capabilityCatalog, capabilityTools, describeCapability, reloadCapabilities } from "./capabilities.js";
import { latestSession, listSessions, restoreSession, saveSession } from "./session.js";
import { compactConversation, contextSize } from "./context.js";
import { handleExtensionCommand, type ExtensionHost } from "./extensions.js";
import { readImage, requireImageSupport, MAX_IMAGES, type ImageAttachment } from "./media.js";
import { exportTranscript, workspaceDiff } from "./chat-files.js";
import { RunBudget } from "./budget.js";

const commands: Record<string, string> = {
  help: "Show commands; Tab completes commands and installed skill names",
  status: "Show model, routing, skills, specialist, planning, and permissions",
  clear: "Clear the conversation without changing files",
  new: "Alias for /clear",
  skills: "List skills; show ID | use ID... | use none | run ID [task] | create DESCRIPTION",
  agents: "List specialists; show ID | use ID | use off | run ID TASK | create DESCRIPTION",
  permissions: "Show permissions, or set read-only | edit | commands | all | execution | external (fresh approval to enable)",
  tasks: "List attached shell and specialist tasks",
  task: "Read bounded output/results for a task ID",
  stop: "Stop an attached task ID",
  checkpoints: "List in-memory checkpoints for harness file edits",
  undo: "Review and approve undo of a checkpoint ID; refuses changed files",
  plan: "Toggle planning, or set on | off; planning disables all writes and commands",
  model: "Show model, or set ID for this chat (changing model clears context after confirmation)",
  models: "List bundled account-model IDs, not live account availability",
  context: "Show context size and remaining character budget",
  compact: "Summarize conversation with the coding model; optional focus text (uses tokens)",
  usage: "Show cumulative usage since this chat started",
  cost: "Alias for /usage; dollar costs are unknown",
  config: "Show this chat's configuration without credential values",
  commands: "List configured executable commands; executions still require approval",
  plugins: "List local plugins, or enable|disable ID (fresh session-only trust)",
  mcp: "List/status MCP servers, or connect|disconnect ID (external permission and trust required)",
  hooks: "List hooks, or enable|disable ID (external permission and trust required)",
  doctor: "Check registries and local credential availability without making model requests",
  reload: "Reload capabilities and AGENTS.md; retain session settings",
  review: "Run a read-only review; optional scope text",
  jev: "Set routing off | shadow | on for this chat; guardrails are unchanged",
  save: "Confirm saving a private unencrypted conversation snapshot; optional NAME",
  sessions: "List private saved snapshots and resume UUIDs",
  resume: "List saved snapshots, or load UUID for this workspace/provider/model",
  continue: "Restore the most recently saved snapshot (never implicitly persisted)",
  name: "Set the name included in future explicit snapshots",
  attach: "Attach a workspace image to the next task after provider-sharing confirmation",
  detach: "Discard pending image attachments",
  editor: "Compose a prompt using explicitly configured JEV_EDITOR; preview and confirm before sending",
  diff: "Show bounded tracked git changes against HEAD, omitting protected paths",
  export: "Confirm exporting user/assistant text to a new private workspace file",
  "auto-compact": "Opt into between-turn semantic compaction: on | off",
  exit: "Leave the chat",
  quit: "Alias for /exit",
};

export interface ChatState {
  project: Project;
  model: CodingModel;
  messages: Message[];
  settings: Pick<RunOptions, "permissions" | "skills" | "specialistId">;
  planMode: boolean;
  runs: number;
  compactions: number;
  metrics: RunResult["metrics"];
  extensions?: ExtensionHost;
  attachments?: ImageAttachment[];
  name?: string;
  autoCompact?: boolean;
  costUnknown?: boolean;
}

export function newChatMetrics(): RunResult["metrics"] {
  return { durationMs: 0, approvalWaitMs: 0, turns: 0, toolCalls: 0, llm: { inputTokens: 0, outputTokens: 0 },
    jev: { inputTokens: 0, outputTokens: 0 }, usageIncompleteRequests: 0, costUsd: null, reportedCostUsd: 0 };
}

function recordCost(state: ChatState, costUsd: number | null, reportedCostUsd: number): void {
  state.costUnknown ||= costUsd === null;
  state.metrics.reportedCostUsd = (state.metrics.reportedCostUsd ?? 0) + reportedCostUsd;
  state.metrics.costUsd = state.costUnknown ? null : state.metrics.reportedCostUsd;
}

export function recordRun(state: ChatState, result: RunResult,
  priorBudget = { turns: 0, reportedCostUsd: 0 }): void {
  state.runs++;
  for (const key of ["durationMs", "approvalWaitMs", "turns", "toolCalls", "usageIncompleteRequests"] as const) {
    state.metrics[key] += result.metrics[key] - (key === "turns" ? priorBudget.turns : 0);
  }
  recordCost(state, result.metrics.costUsd, Math.max(0, (result.metrics.reportedCostUsd ?? 0) - priorBudget.reportedCostUsd));
  for (const source of ["llm", "jev"] as const) {
    state.metrics[source].inputTokens += result.metrics[source].inputTokens;
    state.metrics[source].outputTokens += result.metrics[source].outputTokens;
  }
}

export function commandCompletions(project: Project, line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  let candidates = [...Object.keys(commands), ...project.skills.filter((skill) => skill.userInvocable !== false).map((skill) => skill.id)].map((name) => `/${name}`);
  const match = /^(\/(?:skills (?:show|use|run)|agents (?:show|use|run)) )(\S*)$/.exec(line);
  if (match) {
    const items = match[1]!.startsWith("/skills") ? project.skills.filter((skill) =>
      match[1]!.includes("show") || skill.userInvocable !== false) : project.specialists;
    candidates = items.map((item) => `${match[1]}${item.id}`);
  }
  return [[...new Set(candidates)].filter((candidate) => candidate.startsWith(line)).sort(), line];
}

export interface CommandIO {
  write: (text: string) => void;
  confirm: (prompt: string, signal?: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  budget?: RunBudget;
  editor?: () => Promise<string>;
}

export type ChatCommandResult =
  | { kind: "handled" }
  | { kind: "exit" }
  | { kind: "task"; task: string; skills?: string[]; specialistId?: string; readOnly?: boolean; skillArguments?: Record<string, string> };

export async function handleChatCommand(line: string, state: ChatState, io: CommandIO): Promise<ChatCommandResult> {
  if (state.extensions && await handleExtensionCommand(line, state.extensions, { ...io,
    permissions: state.settings.permissions, planMode: state.planMode })) return { kind: "handled" };
  if (!line.startsWith("/")) return { kind: "task", task: line };
  const space = line.search(/\s/);
  const name = line.slice(1, space < 0 ? undefined : space);
  const argument = space < 0 ? "" : line.slice(space).trim();
  const parts = argument ? argument.split(/\s+/) : [];
  const project = state.project;
  const print = (value: unknown): void => io.write(`${JSON.stringify(value, null, 2)}\n`);
  const handled: ChatCommandResult = { kind: "handled" };
  const noArguments = (): void => { if (argument) throw new Error(`/${name} does not take arguments`); };
  const skillTask = async (id: string, task: string): Promise<ChatCommandResult> => {
    const skills = [...new Set([...(state.settings.skills ?? []), id])];
    await loadSkills(project, skills, { arguments: { [id]: task } });
    return { kind: "task", task: task || `Follow the ${id} skill for this project.`, skills, skillArguments: { [id]: task } };
  };
  if (!Object.hasOwn(commands, name)) {
    if (project.skills.some((skill) => skill.id === name)) return skillTask(name, argument);
    throw new Error(`Unknown chat command: /${name}. Type /help`);
  }
  switch (name) {
    case "exit": case "quit":
      noArguments();
      return { kind: "exit" };
    case "help":
      noArguments();
      io.write(`${Object.entries(commands).map(([id, description]) => `/${id.padEnd(12)} ${description}`).join("\n")}\n`);
      io.write(`Installed skill commands: ${project.skills.filter((skill) => skill.userInvocable !== false).map(({ id }) =>
        Object.hasOwn(commands, id) ? `/skills run ${id}` : `/${id}`).join(", ") || "(none)"}\n`);
      return handled;
    case "clear": case "new":
      noArguments();
      state.messages = [];
      state.attachments = [];
      io.write("Conversation cleared; workspace files and session permissions are unchanged.\n");
      return handled;
    case "status":
      noArguments();
      print({
        provider: project.config.llm.provider, model: project.config.llm.model, jev: project.config.jev.mode,
        messages: state.messages.length, planMode: state.planMode,
        permissions: state.planMode ? { write: false, commands: false, execution: false, external: false } : state.settings.permissions,
        pinnedSkills: state.settings.skills ?? [], pinnedSpecialist: state.settings.specialistId ?? null,
        limits: project.config.limits,
      });
      return handled;
    case "config":
      noArguments(); print(project.config); return handled;
    case "commands":
      noArguments(); print(project.config.commands); return handled;
    case "skills": case "agents": {
      const kind = name === "skills" ? "skills" : "specialists";
      const action = parts[0];
      if (!action) { print(name === "skills" ? capabilityCatalog(project).skills : project.specialists); return handled; }
      if (action === "show" && parts.length === 2) {
        print(await describeCapability(project, kind, parts[1]!));
        return handled;
      }
      if (action === "use" && parts.length >= 2) {
        if (kind === "skills") {
          const ids = parts.length === 2 && parts[1] === "none" ? [] : [...new Set(parts.slice(1))];
          await loadSkills(project, ids);
          state.settings.skills = ids;
          io.write(`Pinned skills: ${ids.join(", ") || "(none)"}. Mandatory skills still apply.\n`);
        } else {
          if (parts.length !== 2) throw new Error("Usage: /agents use ID|off");
          if (parts[1] === "off") delete state.settings.specialistId;
          else {
            if (!project.specialists.some((item) => item.id === parts[1])) throw new Error(`Unknown specialist: ${parts[1]}`);
            state.settings.specialistId = parts[1]!;
          }
          io.write(`Pinned specialist: ${state.settings.specialistId ?? "(none; automatic selection still applies)"}\n`);
        }
        return handled;
      }
      if (action === "create" && parts.length > 1) {
        if (state.planMode || !state.settings.permissions.write) throw new Error("Creation requires edit permission outside plan mode. Use /permissions edit first.");
        const description = argument.slice("create".length).trim();
        return { kind: "task", task: `Create one reusable project ${kind === "skills" ? "skill" : "specialist"} for the following user request. Inspect relevant project conventions, use list_capabilities to avoid duplicates, then author it with ${kind === "skills" ? "create_skill" : "create_specialist"}. Do not perform the described workflow instead of creating the capability. The saved definition requires user approval.\n\n${description}` };
      }
      if (action === "run" && parts.length >= 2) {
        const id = parts[1]!;
        const task = parts.slice(2).join(" ");
        if (kind === "skills") return skillTask(id, task);
        if (!project.specialists.some((item) => item.id === id)) throw new Error(`Unknown specialist: ${id}`);
        if (!task) throw new Error("Usage: /agents run ID TASK");
        return { kind: "task", task, specialistId: id };
      }
      throw new Error(`Usage: /${name} [show ID | use ${kind === "skills" ? "ID...|none" : "ID|off"} | run ID TASK | create DESCRIPTION]`);
    }
    case "permissions": {
      if (!argument) { print({ configured: state.settings.permissions, planMode: state.planMode, approval: "Every mutation requires exact-action approval." }); return handled; }
      const mode = z.enum(["read-only", "edit", "commands", "all", "execution", "external"]).safeParse(argument);
      if (!mode.success) throw new Error("Usage: /permissions read-only|edit|commands|all|execution|external");
      if (mode.data === "execution") {
        if (state.planMode) throw new Error("Execution permission cannot be enabled in plan mode");
        if (!await io.confirm("Enable arbitrary executable and shell tools? Host execution is NOT sandboxed and can access files and the network with your OS privileges. Every launch still needs exact-action approval. Type yes: ")) {
          io.write("Permissions unchanged.\n"); return handled;
        }
        io.signal.throwIfAborted();
        state.settings.permissions = { ...state.settings.permissions, execution: true };
        io.write("Execution permission enabled; no command is preapproved.\n");
        return handled;
      }
      if (mode.data === "external") {
        if (state.planMode) throw new Error("External permission cannot be enabled in plan mode");
        if (!await io.confirm("Enable external extension controls? Unsandboxed MCP and hooks each require separate trust; every MCP call requires approval. Type yes: ")) return handled;
        io.signal.throwIfAborted();
        state.settings.permissions = { ...state.settings.permissions, external: true };
        io.write("External permission enabled; servers and hooks remain untrusted until explicitly enabled.\n");
        return handled;
      }
      const permissions = { write: ["edit", "all"].includes(mode.data), commands: ["commands", "all"].includes(mode.data) };
      if ((permissions.write && !state.settings.permissions.write) || (permissions.commands && !state.settings.permissions.commands)) {
        if (!await io.confirm(`Enable ${mode.data} tools for this chat? Commands are NOT sandboxed; each mutation still needs approval. Type yes: `)) {
          io.write("Permissions unchanged.\n"); return handled;
        }
      }
      io.signal.throwIfAborted();
      state.settings.permissions = permissions;
      await state.extensions?.cancel();
      io.write(`Permissions: ${mode.data}.${state.planMode ? " Plan mode still forces read-only tools." : ""} No action is preapproved.\n`);
      return handled;
    }
    case "plan": {
      if (argument && argument !== "on" && argument !== "off") throw new Error("Usage: /plan [on|off]");
      const enabled = argument ? argument === "on" : !state.planMode;
      if (!enabled && state.planMode && Object.values(state.settings.permissions).some(Boolean)) {
        if (!await io.confirm("Leave plan mode and restore the configured edit/command/execution/external permissions? External services need fresh trust. Type yes: ")) {
          io.write("Plan mode unchanged.\n"); return handled;
        }
      }
      io.signal.throwIfAborted();
      state.planMode = enabled;
      if (enabled) await state.extensions?.cancel();
      io.write(`Plan mode ${enabled ? "on: inspect and propose, no writes or commands" : "off: normal task execution within current permissions"}.\n`);
      return handled;
    }
    case "model": {
      if (!argument) { io.write(`${project.config.llm.provider}/${project.config.llm.model}\n`); return handled; }
      if (parts.length !== 1 || argument.length > 200) throw new Error("Usage: /model MODEL_ID");
      if (argument === project.config.llm.model) { io.write("Model unchanged.\n"); return handled; }
      if (state.messages.length && !await io.confirm("Changing models clears this conversation, not files. Use /save first to retain it. Proceed? Type yes: ")) {
        io.write("Model unchanged.\n"); return handled;
      }
      const config = { ...project.config.llm, model: argument };
      const model = await createCodingModel(config, process.env, io.signal);
      io.signal.throwIfAborted();
      state.model = model;
      project.config.llm = config;
      state.messages = [];
      state.attachments = [];
      io.write(`Model set to ${argument} for this chat; context cleared. Account access is verified on the next request.\n`);
      return handled;
    }
    case "models": {
      noArguments();
      if (project.config.llm.provider === "openai-compatible") {
        io.write(`API mode has no bundled account catalog. Current model: ${project.config.llm.model}. Use your provider's supported model ID with /model.\n`);
      } else {
        const { accountModels } = await import("./subscription-model.js");
        io.write(`${accountModels(project.config.llm.provider).map((item) => item.id).join("\n")}\nBundled adapter catalog, not live account availability.\n`);
      }
      return handled;
    }
    case "context": {
      noArguments();
      const permissions = state.planMode ? { write: false, commands: false } : state.settings.permissions;
      const specs = toolSpecs([...createTools(project.workspace, project.config, permissions), ...capabilityTools(project, permissions.write)]);
      const chars = contextSize(state.model, state.messages, specs);
      print({ messages: state.messages.length, estimatedContextChars: chars, maxContextChars: project.config.limits.maxContextChars,
        remainingChars: Math.max(0, project.config.limits.maxContextChars - chars),
        note: "Character estimate includes stored native history and base tool schemas, not the next task or dynamic skill/delegation schemas. This is not a token count." });
      return handled;
    }
    case "compact": {
      const started = performance.now();
      const budget = io.budget ?? new RunBudget(project.config);
      const previousCost = budget.reportedCostUsd;
      try {
        const compacted = await compactConversation(project, state.model, state.messages, argument,
          AbortSignal.any([io.signal, AbortSignal.timeout(project.config.llm.timeoutMs)]), (usage) => {
            state.metrics.usageIncompleteRequests--;
            state.metrics.llm.inputTokens += usage.inputTokens;
            state.metrics.llm.outputTokens += usage.outputTokens;
          }, () => {
            state.metrics.turns++;
            state.metrics.usageIncompleteRequests++;
          }, budget);
        state.messages = compacted.messages;
        state.compactions++;
        io.write(`Compacted context: ${compacted.beforeChars} -> ${compacted.afterChars} characters. Summary may omit details; reread files before editing. Not saved automatically.\n`);
      } finally {
        recordCost(state, budget.costUsd, budget.reportedCostUsd - previousCost);
        state.metrics.durationMs += Math.round(performance.now() - started);
      }
      return handled;
    }
    case "usage": case "cost":
      noArguments();
      print({ runs: state.runs, compactions: state.compactions, ...state.metrics,
        machineMs: Math.max(0, state.metrics.durationMs - state.metrics.approvalWaitMs),
        note: "Usage since this chat started, including failures and compaction; not restored from snapshots. Costs use only explicitly configured rates. Null means incomplete/unknown cost; reportedCostUsd is the known subtotal, not a provider bill or subscription allowance." });
      return handled;
    case "reload":
      noArguments();
      await reloadCapabilities(project);
      io.write(`Reloaded ${project.skills.length} skills, ${project.specialists.length} specialists, and AGENTS.md. Session settings retained.\n`);
      return handled;
    case "doctor": {
      noArguments();
      const { loadProject } = await import("./registry.js");
      await loadProject(project.workspace.root);
      const { defaultAuthManager } = await import("./auth-driver.js");
      const { readJevKey } = await import("./jev-key.js");
      print({ registries: "valid", provider: project.config.llm.provider,
        accountCredentials: await defaultAuthManager().status(),
        apiKeyAvailable: Boolean(process.env[project.config.llm.apiKeyEnv]),
        jevKeyAvailable: Boolean(process.env[project.config.jev.apiKeyEnv] ?? await readJevKey()),
        sandbox: false, note: "Local checks only; this does not verify live provider access." });
      return handled;
    }
    case "review":
      return { kind: "task", readOnly: true, task: `Review the requested code without changing files or running commands. Inspect evidence and report only concrete correctness issues with file paths, or state that none were found. Clearly identify unverified concerns.\n\nScope: ${argument || "the current task's relevant code"}` };
    case "jev": {
      const parsed = z.enum(["off", "shadow", "on"]).safeParse(argument);
      if (!parsed.success) throw new Error("Usage: /jev off|shadow|on");
      if (parsed.data !== "off" && !project.config.jev.allowDataSharing) {
        throw new Error("Jev requires explicit data-sharing consent. Exit and run: jevcode jev setup");
      }
      project.config.jev.mode = parsed.data;
      io.write(`Jev routing ${parsed.data} for this chat; required guardrails are unchanged.\n`);
      return handled;
    }
    case "save":
      if (argument.length > 80) throw new Error("Session names must be at most 80 characters");
      if (!await io.confirm("Save conversation, file contents, and provider history unencrypted in a private local snapshot? Type yes: ")) {
        io.write("Not saved.\n"); return handled;
      }
      io.signal.throwIfAborted();
      io.write(`Saved. Resume with: jevcode --resume ${await saveSession(project, state.messages, state.model, argument || state.name)}\n`);
      return handled;
    case "name":
      if (!argument || argument.length > 80) throw new Error("Usage: /name NAME (1-80 characters)");
      state.name = argument;
      io.write("Session named; nothing saved until /save.\n");
      return handled;
    case "attach": {
      if (!argument) throw new Error("Usage: /attach workspace-relative-image.png");
      if ((state.attachments?.length ?? 0) >= MAX_IMAGES) throw new Error(`At most ${MAX_IMAGES} images per task`);
      const image = await readImage(project.workspace, argument);
      requireImageSupport(state.model, project.config.llm.model, [image]);
      if (!await io.confirm(`Send this ${image.mimeType} image (${Buffer.byteLength(image.data, "base64")} bytes) to ${project.config.llm.provider}/${project.config.llm.model} with your next task? Type yes: `)) {
        io.write("Image not attached.\n"); return handled;
      }
      io.signal.throwIfAborted();
      (state.attachments ??= []).push(image);
      io.write(`Attached image ${state.attachments.length}; /detach discards pending images. Image bytes are not sent to Jev routing or event logs.\n`);
      return handled;
    }
    case "detach":
      noArguments(); state.attachments = []; io.write("Pending images discarded.\n"); return handled;
    case "editor": {
      noArguments();
      if (!io.editor) throw new Error("External editing is only available in the interactive terminal");
      const prompt = await io.editor();
      io.write(`Editor prompt preview:\n${prompt}\n`);
      if (!await io.confirm("Send this editor prompt to the coding model? Type yes: ")) {
        io.write("Editor prompt discarded.\n"); return handled;
      }
      io.signal.throwIfAborted();
      return { kind: "task", task: prompt };
    }
    case "diff":
      noArguments(); io.write(await workspaceDiff(project, io.signal)); return handled;
    case "export":
      if (!argument) throw new Error("Usage: /export NEW_WORKSPACE_FILE");
      await project.workspace.path(argument, true);
      if (!await io.confirm("Export user/assistant conversation text (may contain private source code) to a new unencrypted local file? Type yes: ")) {
        io.write("Not exported.\n"); return handled;
      }
      io.signal.throwIfAborted();
      await exportTranscript(project, argument, state.messages);
      io.write("Transcript exported privately; image bytes and tool/system messages omitted.\n");
      return handled;
    case "auto-compact":
      if (argument !== "on" && argument !== "off") throw new Error("Usage: /auto-compact on|off");
      if (argument === "on" && !state.autoCompact && !await io.confirm("Allow automatic model summaries between turns at 65% context usage? This uses tokens and may omit older detail. Nothing is saved automatically. Type yes: ")) {
        io.write("Automatic compaction unchanged.\n"); return handled;
      }
      io.signal.throwIfAborted();
      state.autoCompact = argument === "on";
      io.write(`Automatic between-turn compaction ${argument}.\n`);
      return handled;
    case "continue":
      noArguments();
      return handleChatCommand(`/resume ${await latestSession(project)}`, state, io);
    case "sessions": case "resume":
      if (!argument) { print(await listSessions(project)); return handled; }
      if (name === "sessions" || parts.length !== 1) throw new Error(`Usage: /${name}${name === "resume" ? " [UUID]" : ""}`);
      if (state.messages.length && !await io.confirm("Replace the current conversation with this snapshot? Unsaved context will be lost. Type yes: ")) {
        io.write("Conversation unchanged.\n"); return handled;
      }
      io.signal.throwIfAborted();
      state.messages = await restoreSession(project, argument, state.model);
      state.attachments = [];
      io.write("Saved conversation restored. Current permissions and project instructions still apply.\n");
      return handled;
    default:
      throw new Error(`Unimplemented chat command: /${name}`);
  }
}
