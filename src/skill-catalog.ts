import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument, visit, isAlias, isScalar } from "yaml";
import { z } from "zod";
import { idSchema, marketplaceOriginSchema, skillSchema, specialistSchema, type CapabilityProvenance, type Skill, type Specialist } from "./config.js";
import { BlockedError, isMissing } from "./errors.js";
import { excluded, readText, resolvePath } from "./workspace.js";
import { ensureShareable } from "./jev.js";

const skillMetadata = z.object({
  name: idSchema,
  description: z.string().min(1).max(2000),
  license: z.string().max(2000).optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string().max(100), z.string().max(2000)).optional(),
  "disable-model-invocation": z.boolean().optional(),
  "user-invocable": z.boolean().optional(),
  "argument-hint": z.string().max(1000).optional(),
}).strict();
const commandMetadata = skillMetadata.omit({ name: true }).extend({ description: z.string().min(1).max(2000).optional() });
const agentMetadata = z.object({
  name: idSchema,
  description: z.string().min(1).max(2000),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  skills: z.array(idSchema).max(16).optional(),
  maxTurns: z.number().int().min(1).max(20).optional(),
}).strict();

export const MARKETPLACE_RECEIPT = ".jev-marketplace.json";

export function parseSkillMarkdown(text: string) {
  const { metadata, body } = frontmatter(text);
  return { metadata: skillMetadata.parse(metadata), body };
}

export function frontmatter(text: string): { metadata: unknown; body: string } {
  if (text.includes("\0")) throw new Error("Binary capability content is not supported");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error("Markdown capability requires YAML frontmatter");
  const document = parseDocument(match[1]!, { schema: "core", uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error("Invalid or unsupported YAML frontmatter");
  visit(document, (_key, node) => {
    if (isAlias(node) || (node && typeof node === "object" && (("anchor" in node && node.anchor) || ("tag" in node && node.tag)))) {
      throw new Error("YAML aliases, anchors, and explicit tags are not supported");
    }
    if (isScalar(node) && ["__proto__", "constructor", "prototype"].includes(String(node.value))) {
      throw new Error("Unsafe YAML key or value");
    }
  });
  const body = text.slice(match[0].length).trim();
  if (!body) throw new Error("Markdown capability instructions must not be empty");
  if (/!\s*`/.test(body)) throw new Error("Dynamic shell interpolation in Markdown is not supported");
  return { metadata: document.toJS({ maxAliasCount: 0 }), body };
}

export function safeCapabilityPath(relative: string): void {
  if (excluded(relative) || relative.split("/").some((part) => /^\.?(?:auth|credentials?|secrets?|tokens?)(?:\.|$)/i.test(part))) {
    throw new BlockedError("Credential and protected files cannot be capability resources");
  }
}

async function entries(root: string, relative: string) {
  try { return (await readdir(await resolvePath(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
  catch (error) { if (isMissing(error)) return []; throw error; }
}

export async function readCapability(root: string, relative: string): Promise<string> {
  // Only the registry may cross the reserved catalog root; descendants still obey the secret policy.
  safeCapabilityPath(relative.replace(/^(?:\.jev|\.claude)\//, ""));
  await validateCatalogRoot(root);
  const content = await readText(await resolvePath(root, relative), 100_000);
  ensureShareable(content);
  return content;
}

export async function skillContent(skill: Skill, projectRoot: string): Promise<string> {
  const content = await readCapability(skill.provenance?.root ?? projectRoot, skill.instructions);
  return skill.provenance && skill.provenance.format !== "json" ? frontmatter(content).body : content;
}

export async function skillResource(skill: Skill, projectRoot: string, resource: string): Promise<string> {
  if (!skill.resources?.includes(resource)) throw new BlockedError("Resource is not in this skill's declared catalog");
  return readCapability(skill.provenance?.root ?? projectRoot, resource);
}

async function resources(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  let count = 0;
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > 4 || ++count > 64) throw new Error("Skill resource directory limit exceeded");
    for (const entry of await entries(root, relative)) {
      const filename = `${relative}/${entry.name}`;
      if (entry.name === "SKILL.md" || (depth === 0 && entry.name === MARKETPLACE_RECEIPT)) continue;
      safeCapabilityPath(filename.replace(/^(?:\.jev|\.claude)\//, ""));
      if (entry.isSymbolicLink()) throw new BlockedError("Symbolic links are not supported in capabilities");
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile()) {
        if (result.length >= 16) throw new Error("A skill supports at most 16 resources");
        result.push(filename);
      } else throw new Error("Capability resources must be regular files");
    }
  };
  await walk(directory, 0);
  return result;
}

export interface CatalogOptions {
  scope: CapabilityProvenance["scope"];
  pluginId?: string;
}

function provenance(root: string, source: string, format: CapabilityProvenance["format"], options: CatalogOptions): CapabilityProvenance {
  return { ...options, root, source, format };
}

export async function discoverSkills(root: string, directory: string, options: CatalogOptions, commands = false): Promise<Skill[]> {
  const result: Skill[] = [];
  for (const entry of await entries(root, directory)) {
    if (entry.isSymbolicLink()) throw new BlockedError("Symbolic links are not supported in catalogs");
    const source = `${directory}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith(".json") && !commands) {
      const skill = skillSchema.parse(JSON.parse(await readCapability(root, source)));
      if (!skill.instructions.startsWith(`${directory}/`) || skill.resources?.some((item) => !item.startsWith(`${directory}/`))) {
        throw new Error(`Skill ${skill.id}: instructions and resources must remain inside ${directory}`);
      }
      for (const item of [skill.instructions, ...(skill.resources ?? [])]) {
        safeCapabilityPath(item.slice(directory.length + 1));
        await resolvePath(root, item);
      }
      if (skill.mandatory && skill.modelInvocable === false) throw new Error("Mandatory skills cannot disable model invocation");
      result.push({ ...skill, provenance: provenance(root, source, "json", options) });
    } else if ((entry.isDirectory() && !commands) || (commands && entry.isFile() && entry.name.endsWith(".md"))) {
      const filename = commands ? source : `${source}/SKILL.md`;
      if (!commands) {
        try { await lstat(await resolvePath(root, filename)); }
        catch (error) { if (isMissing(error)) continue; throw error; }
      }
      const { metadata } = frontmatter(await readCapability(root, filename));
      const parsed = commands ? { ...commandMetadata.parse(metadata), name: idSchema.parse(entry.name.slice(0, -3)) } : skillMetadata.parse(metadata);
      if (!commands && parsed.name !== entry.name) throw new Error("SKILL.md name must match its directory");
      const origin = provenance(root, filename, commands ? "claude-command" : "skill-md", options);
      if (!commands) {
        try { origin.marketplace = marketplaceOriginSchema.parse(JSON.parse(await readCapability(root, `${source}/${MARKETPLACE_RECEIPT}`))); }
        catch (error) { if (!isMissing(error)) throw error; }
      }
      result.push({
        id: parsed.name, version: "1", description: parsed.description ?? parsed.name, mandatory: false,
        instructions: filename, resources: commands ? [] : await resources(root, source),
        modelInvocable: !parsed["disable-model-invocation"], userInvocable: parsed["user-invocable"] !== false,
        argumentHint: parsed["argument-hint"],
        provenance: origin,
      });
    }
    if (result.length > 64) throw new Error(`${directory}: at most 64 capabilities are supported`);
  }
  assertUnique(result, "skill");
  return result;
}

export async function discoverAgents(root: string, directory: string, options: CatalogOptions): Promise<Specialist[]> {
  const result: Specialist[] = [];
  const toolMap = {
    Read: ["read_file"], Glob: ["list_files"], Grep: ["search_files"], Write: ["write_file"],
    Edit: ["replace_text"], Bash: ["run_command"],
  } satisfies Record<string, Specialist["tools"]>;
  for (const entry of await entries(root, directory)) {
    if (entry.isSymbolicLink()) throw new BlockedError("Symbolic links are not supported in catalogs");
    if (!entry.isFile() || !/\.(json|md)$/.test(entry.name)) continue;
    const source = `${directory}/${entry.name}`;
    const content = await readCapability(root, source);
    let agent: Specialist;
    if (entry.name.endsWith(".json")) agent = specialistSchema.parse(JSON.parse(content));
    else {
      const { metadata, body } = frontmatter(content);
      const parsed = agentMetadata.parse(metadata);
      const names = typeof parsed.tools === "string" ? parsed.tools.split(/[\s,]+/).filter(Boolean) : parsed.tools;
      const tools: Specialist["tools"] = names ? names.flatMap((name) => {
        if (!Object.hasOwn(toolMap, name)) throw new Error(`Unsupported agent tool: ${name}`);
        return toolMap[name as keyof typeof toolMap];
      }) : ["list_files", "read_file", "search_files"];
      agent = specialistSchema.parse({ id: parsed.name, description: parsed.description, role: body, tools,
        skills: parsed.skills, maxTurns: parsed.maxTurns });
    }
    result.push({ ...agent, provenance: provenance(root, source, entry.name.endsWith(".json") ? "json" : "claude-agent", options) });
    if (result.length > 64) throw new Error(`${directory}: at most 64 capabilities are supported`);
  }
  assertUnique(result, "specialist");
  return result;
}

export function assertUnique(items: { id: string }[], label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Duplicate ${label} IDs within a catalog`);
}

export function withPrecedence<T extends { id: string }>(...catalogs: T[][]): T[] {
  const selected = new Map<string, T>();
  for (const items of catalogs) for (const item of items) if (!selected.has(item.id)) selected.set(item.id, item);
  return [...selected.values()];
}

export async function validateCatalogRoot(root: string): Promise<void> {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BlockedError("Catalog root must be a real directory");
  await resolvePath(path.parse(root).root, path.relative(path.parse(root).root, root).split(path.sep).join("/"));
}
