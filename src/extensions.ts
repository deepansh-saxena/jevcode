import { z } from "zod";
import type { Project } from "./registry.js";
import type { Permissions, PreparedAction, Tool } from "./tools.js";
import { pluginSchema, type HookConfig, type McpServerConfig } from "./extension-config.js";
import { discoverAgents, discoverSkills, readCapability, safeCapabilityPath } from "./skill-catalog.js";
import { digest, resolvePath } from "./workspace.js";
import { BlockedError } from "./errors.js";
import { ensureShareable } from "./jev.js";
import { McpConnection } from "./mcp.js";
import { runHookProcess } from "./extension-process.js";

export interface ExtensionContext {
  permissions: Permissions;
  planMode?: boolean | undefined;
  background?: boolean | undefined;
  specialist?: boolean | undefined;
}
export interface ExtensionIO extends ExtensionContext {
  write: (text: string) => void;
  confirm: (prompt: string, signal?: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
}
type Owned<T> = { config: T; cwd: string; pluginId?: string };
const hookResult = z.object({ deny: z.boolean().optional(), reason: z.string().max(2000).optional() }).strict();

export function extensionsAllowed(context: ExtensionContext): boolean {
  return context.permissions.external === true && !context.planMode && !context.background && !context.specialist;
}

export class ExtensionHost {
  private plugins = new Map<string, { root: string; hash: string }>();
  private servers = new Map<string, Owned<McpServerConfig>>();
  private hooks = new Map<string, Owned<HookConfig>>();
  private trustedHooks = new Set<string>();
  private connections = new Map<string, McpConnection>();
  private connecting = new Map<string, AbortSignal>();
  private disconnecting = new Map<string, Promise<void>>();
  private activeHooks = new Set<Promise<string>>();
  private lifetime = new AbortController();
  private cancelling: Promise<void> | undefined;
  private closed = false;

  constructor(readonly project: Project, private environment: NodeJS.ProcessEnv = process.env) {
    for (const [id, config] of Object.entries(project.config.extensions?.mcp ?? {})) {
      this.servers.set(id, { config: structuredClone(config), cwd: project.workspace.root });
    }
    for (const [id, config] of Object.entries(project.config.extensions?.hooks ?? {})) {
      this.hooks.set(id, { config: structuredClone(config), cwd: project.workspace.root });
    }
  }

  status() {
    return {
      plugins: Object.entries(this.project.config.extensions?.plugins ?? {}).map(([id, directory]) =>
        ({ id, directory, enabled: this.plugins.has(id), manifestHash: this.plugins.get(id)?.hash })),
      mcp: [...this.servers].map(([id, entry]) => ({ id, transport: entry.config.transport, pluginId: entry.pluginId,
        connected: this.connections.get(id)?.status().connected ?? false, tools: this.connections.get(id)?.status().tools ?? [],
        error: this.connections.get(id)?.status().error })),
      hooks: [...this.hooks].map(([id, entry]) => ({ id, event: entry.config.event, tools: entry.config.tools,
        pluginId: entry.pluginId, enabled: this.trustedHooks.has(id) })),
    };
  }

  private usable(io: ExtensionIO, external: boolean): void {
    if (this.closed) throw new BlockedError("Extension host is closed");
    if (this.cancelling) throw new BlockedError("Extension cleanup is in progress; wait before granting fresh trust");
    io.signal.throwIfAborted();
    if (io.planMode || io.background || io.specialist) throw new BlockedError("Extensions cannot be enabled in plan, background, or specialist contexts");
    if (external && !extensionsAllowed(io)) throw new BlockedError("Explicit external permission is required before trusting MCP or hooks");
  }

  private scopedIO(io: ExtensionIO): ExtensionIO {
    return { ...io, signal: AbortSignal.any([io.signal, this.lifetime.signal]) };
  }

  private async trust(io: ExtensionIO, label: string, details: unknown, external: boolean): Promise<void> {
    this.usable(io, external);
    ensureShareable(details);
    if (!await io.confirm(`${label}\n${JSON.stringify(details, null, 2)}\n${external ?
      "UNSANDBOXED: this may execute arbitrary code, access files (including credentials), or contact the network. Only trust code/services you reviewed. " :
      "This adds persistent on-disk instructions to this session, but never grants executable permissions. "}Trust for this session only? Type yes: `, io.signal)) {
      throw new BlockedError("Extension trust was not approved");
    }
    this.usable(io, external);
  }

  private async validatePlugin(pluginId: string | undefined): Promise<void> {
    if (!pluginId) return;
    const plugin = this.plugins.get(pluginId);
    if (!plugin || digest(await readCapability(plugin.root, "jev-plugin.json")) !== plugin.hash) {
      throw new BlockedError("Plugin manifest changed; disable and re-enable the plugin with fresh trust");
    }
  }

  async enablePlugin(id: string, io: ExtensionIO): Promise<void> {
    io = this.scopedIO(io);
    this.usable(io, false);
    if (this.plugins.has(id)) throw new Error(`Plugin ${id} is already enabled; disable before re-enabling`);
    const directory = this.project.config.extensions?.plugins[id];
    if (!directory) throw new Error(`Unknown configured plugin: ${id}`);
    safeCapabilityPath(directory.replace(/^\.jev\//, ""));
    const root = await resolvePath(this.project.workspace.root, directory);
    const text = await readCapability(root, "jev-plugin.json");
    const manifest = pluginSchema.parse(JSON.parse(text));
    if (manifest.id !== id) throw new Error("Plugin manifest ID must match the configured ID");
    for (const target of [manifest.skills, manifest.agents].filter((item) => item !== undefined)) safeCapabilityPath(target);
    const [skills, agents] = await Promise.all([
      manifest.skills ? discoverSkills(root, manifest.skills, { scope: "plugin", pluginId: id }) : [],
      manifest.agents ? discoverAgents(root, manifest.agents, { scope: "plugin", pluginId: id }) : [],
    ]);
    for (const skill of skills) {
      if (skill.mandatory) throw new Error("Plugins cannot install mandatory skills");
      for (const command of skill.commandIds ?? []) {
        if (!Object.hasOwn(this.project.config.commands, command)) throw new Error("Plugin skill references an unknown command");
      }
    }
    for (const agent of agents) for (const skill of agent.skills) {
      if (![...skills, ...this.project.skills].some((item) => item.id === skill)) throw new Error("Plugin agent references an unknown skill");
    }
    const qualify = (name: string): string => `${id}--${name}`;
    for (const name of Object.keys(manifest.mcp)) if (this.servers.has(qualify(name))) throw new Error("Plugin MCP ID collision");
    for (const name of Object.keys(manifest.hooks)) if (this.hooks.has(qualify(name))) throw new Error("Plugin hook ID collision");
    await this.trust(io, `Enable local plugin ${id}?`, { directory, manifest, manifestHash: digest(text),
      skills: skills.map((skill) => ({ id: skill.id, description: skill.description })),
      agents: agents.map((agent) => ({ id: agent.id, description: agent.description })),
      note: "MCP servers and hooks remain disabled until separately trusted. Existing project/user capabilities win ID collisions." }, false);
    if (await readCapability(root, "jev-plugin.json") !== text) throw new Error("Plugin manifest changed during approval");
    this.usable(io, false);
    this.plugins.set(id, { root, hash: digest(text) });
    this.project.skills.push(...skills.filter((item) => !this.project.skills.some((existing) => existing.id === item.id)));
    this.project.specialists.push(...agents.filter((item) => !this.project.specialists.some((existing) => existing.id === item.id)));
    for (const [name, config] of Object.entries(manifest.mcp)) this.servers.set(qualify(name), { config, cwd: root, pluginId: id });
    for (const [name, config] of Object.entries(manifest.hooks)) this.hooks.set(qualify(name), { config, cwd: root, pluginId: id });
  }

  async disablePlugin(id: string): Promise<void> {
    if (!this.plugins.has(id)) throw new Error(`Plugin ${id} is not enabled`);
    for (const [name, entry] of this.servers) if (entry.pluginId === id) { await this.disconnect(name); this.servers.delete(name); }
    for (const [name, entry] of this.hooks) if (entry.pluginId === id) { this.trustedHooks.delete(name); this.hooks.delete(name); }
    this.project.skills = this.project.skills.filter((item) => item.provenance?.pluginId !== id);
    this.project.specialists = this.project.specialists.filter((item) => item.provenance?.pluginId !== id);
    this.plugins.delete(id);
  }

  async connect(id: string, io: ExtensionIO): Promise<void> {
    io = this.scopedIO(io);
    this.usable(io, true);
    const entry = this.servers.get(id);
    if (!entry) throw new Error(`Unknown MCP server: ${id}`);
    const pending = this.connecting.get(id);
    if (pending && !pending.aborted) throw new BlockedError(`MCP server ${id} is already connecting`);
    this.connecting.set(id, io.signal);
    try {
      await this.validatePlugin(entry.pluginId);
      await this.trust(io, `Connect MCP server ${id}?`, { ...entry, protocol:
        "Trust covers initialize, bounded tools/list, protocol ping/cancellation/notifications, and connection teardown. Each tools/call requires a new exact-action approval. No sampling, elicitation, resources, prompts, or automatic reconnect." }, true);
      await this.disconnect(id);
      await this.validatePlugin(entry.pluginId);
      this.usable(io, true);
      const connection = new McpConnection(id, entry.config, entry.cwd, this.environment);
      this.connections.set(id, connection);
      try {
        await connection.connect(io.signal);
        this.usable(io, true);
      } catch (error) {
        if (this.connections.get(id) === connection) await this.disconnect(id);
        else await connection.close();
        throw error;
      }
    } finally {
      if (this.connecting.get(id) === io.signal) this.connecting.delete(id);
    }
  }

  disconnect(id: string): Promise<void> {
    if (!this.servers.has(id)) throw new Error(`Unknown MCP server: ${id}`);
    const pending = this.disconnecting.get(id);
    if (pending) return pending;
    const connection = this.connections.get(id);
    this.connections.delete(id);
    if (!connection) return Promise.resolve();
    const closing = connection.close().then(() => { this.disconnecting.delete(id); });
    this.disconnecting.set(id, closing);
    return closing;
  }

  async enableHook(id: string, io: ExtensionIO): Promise<void> {
    io = this.scopedIO(io);
    this.usable(io, true);
    const entry = this.hooks.get(id);
    if (!entry) throw new Error(`Unknown hook: ${id}`);
    await this.validatePlugin(entry.pluginId);
    await this.trust(io, `Enable ${entry.config.event}-tool hook ${id}?`, { ...entry,
      input: "Tool name and approved arguments. After hooks receive only completed:true, not file results, conversation, images, or auth.",
      result: "Hooks can only deny; they cannot approve or change tool arguments. Before-hook failure prevents execution." }, true);
    this.usable(io, true);
    this.trustedHooks.add(id);
  }

  disableHook(id: string): void {
    if (!this.hooks.has(id)) throw new Error(`Unknown hook: ${id}`);
    this.trustedHooks.delete(id);
  }

  tools(context: ExtensionContext): Tool[] {
    if (this.closed || this.cancelling || this.lifetime.signal.aborted || !extensionsAllowed(context)) return [];
    return [...this.connections.values()].flatMap((connection) => connection.tools());
  }

  private async hooksFor(event: "before" | "after", action: PreparedAction, signal: AbortSignal): Promise<void> {
    const lifetime = this.lifetime.signal;
    for (const id of this.trustedHooks) {
      const entry = this.hooks.get(id)!;
      if (entry.config.event !== event || (entry.config.tools.length && !entry.config.tools.includes(action.name))) continue;
      const payload = { event, tool: action.name, arguments: action.details, ...(event === "after" ? { completed: true } : {}) };
      try {
        await this.validatePlugin(entry.pluginId);
        ensureShareable(payload);
        const pending = runHookProcess(entry.config, entry.cwd, this.environment, payload, AbortSignal.any([signal, lifetime]));
        this.activeHooks.add(pending);
        let text: string;
        try { text = await pending; } finally { this.activeHooks.delete(pending); }
        const result = text.trim() ? hookResult.parse(JSON.parse(text)) : {};
        if (result.deny) throw new Error(`Hook denied the action${result.reason ? `: ${result.reason}` : ""}`);
      } catch {
        throw new BlockedError(event === "before" ? `Before hook ${id} denied or failed; tool was not executed.` :
          `After hook ${id} denied or failed; the tool ALREADY EXECUTED and its effects are not rolled back. Check state before retrying.`);
      }
    }
  }

  async beforeTool(action: PreparedAction, signal: AbortSignal): Promise<void> { await this.hooksFor("before", action, signal); }
  async afterTool(action: PreparedAction, _result: unknown, signal: AbortSignal): Promise<void> { await this.hooksFor("after", action, signal); }

  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    const closing = [...this.connections.keys()].map((id) => this.disconnect(id));
    this.cancelling = Promise.all([
      Promise.allSettled([...new Set([...closing, ...this.disconnecting.values()])]),
      Promise.allSettled([...this.activeHooks]),
    ]).then(([results]) => {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw new Error("An MCP connection failed to clean up", { cause: failure.reason });
      if (!this.closed) this.lifetime = new AbortController();
    }).finally(() => { this.cancelling = undefined; });
    this.lifetime.abort(new Error("Extensions closed"));
    this.trustedHooks.clear();
    return this.cancelling;
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.cancel(); } finally {
      this.project.skills = this.project.skills.filter((item) => item.provenance?.scope !== "plugin");
      this.project.specialists = this.project.specialists.filter((item) => item.provenance?.scope !== "plugin");
      this.plugins.clear();
    }
  }
}

export async function handleExtensionCommand(line: string, host: ExtensionHost, io: ExtensionIO): Promise<boolean> {
  const [command, operation = "list", id, ...rest] = line.trim().split(/\s+/);
  if (!["/plugins", "/mcp", "/hooks"].includes(command!)) return false;
  if (rest.length || (!id && !["list", "status"].includes(operation)) || (id && ["list", "status"].includes(operation))) {
    throw new Error(`Invalid ${command} arguments`);
  }
  if (operation === "list" || operation === "status") {
    const status = host.status();
    io.write(`${JSON.stringify(command === "/plugins" ? status.plugins : command === "/hooks" ? status.hooks : status.mcp, null, 2)}\n`);
  } else if (command === "/plugins" && operation === "enable") await host.enablePlugin(id!, io);
  else if (command === "/plugins" && operation === "disable") await host.disablePlugin(id!);
  else if (command === "/mcp" && operation === "connect") await host.connect(id!, io);
  else if (command === "/mcp" && operation === "disconnect") await host.disconnect(id!);
  else if (command === "/hooks" && operation === "enable") await host.enableHook(id!, io);
  else if (command === "/hooks" && operation === "disable") host.disableHook(id!);
  else throw new Error(`Usage: ${command} list|status|${command === "/mcp" ? "connect|disconnect" : "enable|disable"} ID`);
  if (!["list", "status"].includes(operation)) io.write(`${command} ${operation} ${id}: complete (session-local trust only).\n`);
  return true;
}
