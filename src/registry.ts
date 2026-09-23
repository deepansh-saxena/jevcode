import { writeFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { configSchema, type Config, type Skill, type Specialist } from "./config.js";
import { readText, resolvePath, Workspace } from "./workspace.js";
import { isMissing } from "./errors.js";
import type { AccountProvider } from "./auth.js";
import { discoverSkills, discoverAgents, withPrecedence, skillContent, skillResource, validateCatalogRoot } from "./skill-catalog.js";

export interface Project {
  config: Config;
  workspace: Workspace;
  skills: Skill[];
  specialists: Specialist[];
  instructions: string;
  catalogOptions?: { globalRoot: string | null };
}

export async function loadProject(root: string, options: { globalRoot?: string | null } = {}): Promise<Project> {
  const initial = await Workspace.create(root);
  const configPath = await resolvePath(initial.root, ".jev/config.json");
  const config = configSchema.parse(JSON.parse(await readText(configPath, 64_000)));
  const workspace = new Workspace(initial.root, config.protectedPaths);
  const globalRoot = options.globalRoot === undefined ? path.join(homedir(), ".jev-code") : options.globalRoot;
  let userSkills: Skill[] = [];
  let userAgents: Specialist[] = [];
  if (globalRoot) {
    let exists = true;
    try { await validateCatalogRoot(globalRoot); }
    catch (error) { if (isMissing(error)) exists = false; else throw error; }
    if (exists) {
      [userSkills, userAgents] = await Promise.all([
        discoverSkills(globalRoot, "skills", { scope: "user" }),
        discoverAgents(globalRoot, "agents", { scope: "user" }),
      ]);
    }
  }
  const [localSkills, compatSkills, commands, localAgents, compatAgents] = await Promise.all([
    discoverSkills(initial.root, ".jev/skills", { scope: "project" }),
    discoverSkills(initial.root, ".claude/skills", { scope: "project" }),
    discoverSkills(initial.root, ".claude/commands", { scope: "project" }, true),
    discoverAgents(initial.root, ".jev/specialists", { scope: "project" }),
    discoverAgents(initial.root, ".claude/agents", { scope: "project" }),
  ]);
  const skills = withPrecedence(localSkills, compatSkills, commands, userSkills);
  const specialists = withPrecedence(localAgents, compatAgents, userAgents);
  for (const skill of skills) {
    for (const id of skill.commandIds ?? []) {
      if (!Object.hasOwn(config.commands, id)) throw new Error(`Skill ${skill.id}: unknown configured command ${id}`);
    }
  }
  for (const specialist of specialists) {
    for (const id of specialist.skills) {
      if (!skills.some((skill) => skill.id === id)) throw new Error(`Unknown skill ${id} in ${specialist.id}`);
    }
  }
  let instructions = "";
  try {
    instructions = await readText(await resolvePath(initial.root, "AGENTS.md"), 24_000);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { config, workspace, skills, specialists, instructions, catalogOptions: { globalRoot } };
}

export interface SkillInvocation {
  source?: "user" | "model";
  explicitIds?: string[];
  arguments?: Record<string, string> | undefined;
}

export async function loadSkills(project: Project, ids: string[], invocation: SkillInvocation = {}): Promise<{ ids: string[]; text: string }> {
  const selected = new Set([...project.skills.filter((skill) => skill.mandatory).map((skill) => skill.id), ...ids]);
  const sections: string[] = [];
  let length = 0;
  for (const id of selected) {
    const skill = project.skills.find((candidate) => candidate.id === id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    const explicit = invocation.source !== "model" || invocation.explicitIds?.includes(id);
    if (!skill.mandatory && (explicit ? skill.userInvocable === false : skill.modelInvocable === false)) {
      throw new Error(`Skill ${id} is not ${explicit ? "user" : "model"}-invocable`);
    }
    let content = await skillContent(skill, project.workspace.root);
    const args = invocation.arguments?.[id] ?? "";
    const words = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
    if ((skill.provenance && skill.provenance.format !== "json") || skill.argumentHint !== undefined) {
      content = content.replace(/\$ARGUMENTS(?:\[(\d+)\])?|\$(\d+)/g, (_match, indexed: string | undefined, numeric: string | undefined) =>
        indexed !== undefined || numeric !== undefined ? words[Number(indexed ?? numeric)] ?? "" : args);
    }
    const resources = skill.provenance && skill.provenance.format !== "json" ?
      (skill.resources?.length ? [`Supporting resources (load with load_skill_resource; never automatically executed): ${skill.resources.join(", ")}`] : []) :
      await Promise.all((skill.resources ?? []).map(async (resource) =>
        `Resource ${resource}:\n${await skillResource(skill, project.workspace.root, resource)}`));
    const commands = skill.commandIds?.length ?
      `Configured command references: ${skill.commandIds.join(", ")}. Only use run_command if available; each execution still requires approval.` : "";
    const section = [`## Skill: ${skill.id} (${skill.version})\n${content}`, ...resources, commands].filter(Boolean).join("\n\n");
    length += section.length + (sections.length ? 2 : 0);
    if (length > project.config.limits.maxSkillChars) throw new Error("Selected skills exceed the context budget");
    sections.push(section);
  }
  return { ids: [...selected], text: sections.join("\n\n") };
}

export async function selectAccountProvider(project: Project, provider: AccountProvider, model: string): Promise<void> {
  await updateProjectConfig(project, (config) => { config.llm.provider = provider; config.llm.model = model; });
}

export async function updateProjectConfig(project: Project, update: (config: Config) => void): Promise<void> {
  const filename = await resolvePath(project.workspace.root, ".jev/config.json");
  const original = await readText(filename, 64_000);
  const config = configSchema.parse(JSON.parse(original));
  if (JSON.stringify(config) !== JSON.stringify(project.config)) {
    throw new Error("Workspace config changed; settings were not overwritten");
  }
  update(config);
  const validated = configSchema.parse(config);
  const temporary = path.join(path.dirname(filename), `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (await readText(await resolvePath(project.workspace.root, ".jev/config.json"), 64_000) !== original) {
      throw new Error("Workspace config changed; settings were not overwritten");
    }
    await rename(temporary, filename);
  } finally {
    try { await unlink(temporary); } catch (error) { if (!isMissing(error)) throw error; }
  }
}
