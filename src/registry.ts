import { readdir, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { configSchema, skillSchema, specialistSchema, type Config, type Skill, type Specialist } from "./config.js";
import { readText, resolvePath, Workspace } from "./workspace.js";
import { isMissing } from "./errors.js";
import type { AccountProvider } from "./auth.js";

export interface Project {
  config: Config;
  workspace: Workspace;
  skills: Skill[];
  specialists: Specialist[];
  instructions: string;
}

async function manifests<T>(root: string, directory: string, schema: z.ZodType<T>): Promise<T[]> {
  const absolute = await resolvePath(root, directory);
  const entries = (await readdir(absolute)).filter((name) => name.endsWith(".json")).sort();
  if (entries.length > 64) throw new Error(`${directory}: at most 64 manifests are supported`);
  return Promise.all(entries.map(async (name) => {
    const filename = await resolvePath(root, `${directory}/${name}`);
    return schema.parse(JSON.parse(await readText(filename, 32_000)));
  }));
}

function unique(items: { id: string }[], label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(`Duplicate ${label} IDs`);
  }
}

export async function loadProject(root: string): Promise<Project> {
  const initial = await Workspace.create(root);
  const configPath = await resolvePath(initial.root, ".jev/config.json");
  const config = configSchema.parse(JSON.parse(await readText(configPath, 64_000)));
  const workspace = new Workspace(initial.root, config.protectedPaths);
  const [skills, specialists] = await Promise.all([
    manifests(initial.root, ".jev/skills", skillSchema),
    manifests(initial.root, ".jev/specialists", specialistSchema),
  ]);
  unique(skills, "skill");
  unique(specialists, "specialist");
  for (const skill of skills) {
    if (!skill.instructions.startsWith(".jev/skills/")) {
      throw new Error(`Skill ${skill.id}: instructions must be under .jev/skills/`);
    }
    await resolvePath(initial.root, skill.instructions);
    for (const resource of skill.resources ?? []) {
      if (!resource.startsWith(".jev/skills/")) throw new Error(`Skill ${skill.id}: resources must be under .jev/skills/`);
      await resolvePath(initial.root, resource);
    }
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
  return { config, workspace, skills, specialists, instructions };
}

export async function loadSkills(project: Project, ids: string[]): Promise<{ ids: string[]; text: string }> {
  const selected = new Set([...project.skills.filter((skill) => skill.mandatory).map((skill) => skill.id), ...ids]);
  const sections: string[] = [];
  let length = 0;
  for (const id of selected) {
    const skill = project.skills.find((candidate) => candidate.id === id);
    if (!skill) throw new Error(`Unknown skill: ${id}`);
    const content = await readText(await resolvePath(project.workspace.root, skill.instructions), 100_000);
    const resources = await Promise.all((skill.resources ?? []).map(async (resource) =>
      `Resource ${resource}:\n${await readText(await resolvePath(project.workspace.root, resource), 100_000)}`));
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
