import { constants } from "node:fs";
import { link, lstat, open, readdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { executionToolNames, idSchema, skillSchema, specialistSchema } from "./config.js";
import { BlockedError, isMissing } from "./errors.js";
import { loadProject, loadSkills, type Project } from "./registry.js";
import { digest, readText, resolvePath } from "./workspace.js";
import type { Tool } from "./tools.js";
import { skillContent, withPrecedence } from "./skill-catalog.js";

const createSkillSchema = z.object({
  id: idSchema,
  description: z.string().min(1).max(2000),
  applicability: z.string().max(2000).optional(),
  instructions: z.string().min(1).max(16_000).refine((text) => !text.includes("\0"), "Instructions must not contain NUL bytes"),
  commandIds: z.array(idSchema).max(16).default([]),
}).strict();

const createSpecialistSchema = z.object({
  id: idSchema,
  description: z.string().min(1).max(2000),
  role: z.string().min(1).max(4000),
  skills: z.array(idSchema).max(16).default([]),
  tools: z.array(z.enum(executionToolNames)).min(1).max(executionToolNames.length),
  maxTurns: z.number().int().min(1).max(20).default(5),
  maxToolCalls: z.number().int().min(1).max(40).default(10),
}).strict();

export function capabilityCatalog(project: Project, source: "user" | "model" = "user") {
  return {
    skills: project.skills.filter((skill) => source === "user" || skill.modelInvocable !== false)
      .map(({ id, description, applicability, mandatory, modelInvocable, userInvocable, argumentHint, provenance }) =>
        ({ id, description, applicability, mandatory, modelInvocable, userInvocable, argumentHint, provenance })),
    specialists: project.specialists,
  };
}

export async function reloadCapabilities(project: Project): Promise<void> {
  const loaded = await loadProject(project.workspace.root, project.catalogOptions);
  for (const skill of loaded.skills) {
    for (const id of skill.commandIds ?? []) {
      if (!Object.hasOwn(project.config.commands, id)) throw new Error(`Skill ${skill.id}: command ${id} is not configured in this session`);
    }
  }
  project.skills = withPrecedence(loaded.skills, project.skills.filter((item) => item.provenance?.scope === "plugin"));
  project.specialists = withPrecedence(loaded.specialists, project.specialists.filter((item) => item.provenance?.scope === "plugin"));
  project.instructions = loaded.instructions;
}

export async function describeCapability(project: Project, kind: "skills" | "specialists", id: string): Promise<unknown> {
  if (kind === "specialists") {
    const specialist = project.specialists.find((item) => item.id === id);
    if (!specialist) throw new Error(`Unknown specialist: ${id}`);
    return specialist;
  }
  const skill = project.skills.find((item) => item.id === id);
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  return { ...skill, content: await skillContent(skill, project.workspace.root) };
}

async function newManifest(project: Project, kind: "skills" | "specialists", id: string): Promise<string> {
  await project.workspace.path(".");
  if (project[kind].some((item) => item.id === id)) throw new Error(`A ${kind} capability with ID ${id} already exists`);
  const relative = `.jev/${kind}/${id}.json`;
  if (project.workspace.protectedPaths.some((prefix) =>
    relative.toLowerCase() === prefix.toLowerCase() || relative.toLowerCase().startsWith(`${prefix.toLowerCase()}/`))) {
    throw new BlockedError("Capability directory is protected by workspace policy");
  }
  const directory = await resolvePath(project.workspace.root, `.jev/${kind}`);
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  if (entries.length >= 64) throw new Error(`At most 64 ${kind} are supported`);
  for (const name of entries) {
    const content = z.object({ id: idSchema }).parse(
      JSON.parse(await readText(await resolvePath(project.workspace.root, `.jev/${kind}/${name}`), 32_000)));
    if (content.id === id) throw new Error(`A ${kind} capability with ID ${id} already exists; existing definitions are never overwritten`);
  }
  const target = await resolvePath(project.workspace.root, relative, true);
  try { await lstat(target); } catch (error) { if (isMissing(error)) return relative; throw error; }
  throw new Error(`Capability file already exists: ${relative}`);
}

async function publishNew(project: Project, relative: string, content: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const target = await resolvePath(project.workspace.root, relative, true);
  const temporary = path.join(path.dirname(target), `.capability-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.writeFile(content);
      await file.sync();
    } finally { await file.close(); }
    signal.throwIfAborted();
    await resolvePath(project.workspace.root, relative, true);
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}

export function capabilityTools(project: Project, writable: boolean): Tool[] {
  const tools: Tool[] = [{
    name: "list_capabilities",
    description: "List installed skills and specialists with descriptions. Discover reusable capabilities before creating or loading one.",
    schema: z.object({}).strict(),
    async prepare(input) {
      z.object({}).strict().parse(input);
      return { name: "list_capabilities", mutating: false, details: {}, execute: async () => capabilityCatalog(project, "model") };
    },
  }];
  if (!writable) return tools;
  tools.push({
    name: "create_skill",
    description: "Create a NEW reusable project skill when requested by the user. Provide complete instructions. Requires review and exact approval; cannot overwrite skills, grant permissions, or configure commands. Available after creation.",
    schema: createSkillSchema,
    async prepare(input) {
      const args = createSkillSchema.parse(input);
      const validate = async (): Promise<string> => {
        for (const id of args.commandIds) {
          if (!Object.hasOwn(project.config.commands, id)) throw new Error(`Unknown configured command: ${id}`);
        }
        const mandatory = await loadSkills(project, []);
        if (mandatory.text.length + args.instructions.length + args.id.length + 40 > project.config.limits.maxSkillChars) {
          throw new Error("New skill and mandatory instructions exceed the skill context budget");
        }
        return newManifest(project, "skills", args.id);
      };
      const manifestPath = await validate();
      return {
        name: "create_skill", mutating: true,
        details: { ...args, manifestPath, warning: "Persists trusted instructions for future tasks. No permissions are granted." },
        async execute(signal) {
          await validate();
          const instructions = `.jev/skills/${args.id}-${randomUUID()}.md`;
          const skill = skillSchema.parse({
            ...args, instructions, version: "1", mandatory: false,
          });
          await publishNew(project, instructions, args.instructions, signal);
          let published = false;
          try {
            await validate();
            await publishNew(project, manifestPath, `${JSON.stringify(skill, null, 2)}\n`, signal);
            published = true;
          } finally {
            if (!published) await unlink(await resolvePath(project.workspace.root, instructions));
          }
          project.skills.push(skill);
          return { id: skill.id, manifestPath, instructionsPath: instructions, sha256: digest(args.instructions), created: true };
        },
      };
    },
  }, {
    name: "create_specialist",
    description: "Create a NEW reusable project specialist when requested by the user. It inherits the coding model and intersects tools with session permissions, cannot create capabilities or delegate, and returns a structured report. Requires exact approval.",
    schema: createSpecialistSchema,
    async prepare(input) {
      const args = createSpecialistSchema.parse(input);
      const validate = async (): Promise<string> => {
        await loadSkills(project, args.skills, { source: "model" });
        return newManifest(project, "specialists", args.id);
      };
      const manifestPath = await validate();
      const specialist = specialistSchema.parse({ ...args, resultFormat: "structured" });
      return {
        name: "create_specialist", mutating: true,
        details: { ...specialist, manifestPath, warning: "Persists a trusted role for future tasks. Tools never exceed the calling session's permissions." },
        async execute(signal) {
          await validate();
          await publishNew(project, manifestPath, `${JSON.stringify(specialist, null, 2)}\n`, signal);
          project.specialists.push(specialist);
          return { id: specialist.id, manifestPath, created: true };
        },
      };
    },
  });
  return tools;
}
