import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { idSchema, type Skill } from "./config.js";
import { BlockedError, isMissing } from "./errors.js";
import { getJson, getText } from "./http.js";
import { ensureShareable } from "./jev.js";
import { reloadCapabilities } from "./capabilities.js";
import type { Project } from "./registry.js";
import { digest, resolvePath } from "./workspace.js";
import { MARKETPLACE_RECEIPT, parseSkillMarkdown, safeCapabilityPath } from "./skill-catalog.js";

const sourceSchema = z.string().regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/);
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({
    path: z.string().max(1000), mode: z.string(), type: z.string(), sha: shaSchema,
    size: z.number().int().nonnegative().optional(),
  })).max(20_000),
});
type TreeEntry = z.infer<typeof treeSchema>["tree"][number];
export interface MarketplaceIO {
  signal: AbortSignal;
  write(text: string): void;
  confirm(prompt: string, signal?: AbortSignal): Promise<boolean>;
}
export interface MarketplaceAccess { write: boolean; planMode?: boolean | undefined }
export interface SkillBundle {
  id: string;
  source: string;
  commit: string;
  directory: string;
  files: { path: string; content: string; sha256: string }[];
}

function reference(value: string) {
  const match = /^([^@#]+)@([^@#]+)(?:#([a-f0-9]{40}))?$/.exec(value);
  if (!match) throw new Error("Use OWNER/REPO@SKILL, optionally followed by #FULL_COMMIT_SHA");
  return { source: sourceSchema.parse(match[1]), skill: idSchema.parse(match[2]), commit: match[3] };
}

function safeRelative(value: string): void {
  if (!value || value.length > 1000 || /[\\\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || /[<>:"|?*]/.test(part) ||
      /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("Unsupported skill file path");
  }
}

export class SkillsMarketplace {
  constructor(private network = { json: getJson, text: getText }) {}

  async search(query: string, signal: AbortSignal) {
    signal.throwIfAborted();
    query = query.trim();
    if (query.length < 2 || query.length > 200 || /[\x00-\x1f\x7f]/.test(query)) throw new Error("Search requires 2-200 printable characters");
    ensureShareable(query);
    const response = await this.network.json(`https://skills.sh/api/search?${new URLSearchParams({ q: query, limit: "10" })}`, signal);
    const result = z.object({ skills: z.array(z.object({
      source: z.string().min(1).max(200), skillId: z.string().min(1).max(200).optional(),
      name: z.string().min(1).max(200), installs: z.number().int().nonnegative(),
    })).max(20) }).parse(response);
    return result.skills.map((item) => {
      const skill = item.skillId ?? item.name;
      const supported = sourceSchema.safeParse(item.source).success && idSchema.safeParse(skill).success;
      return { name: item.name, source: item.source, installs: item.installs,
        reference: supported ? `${item.source}@${skill}` : null, supported,
        ...(supported ? {} : { reason: "Jev supports public GitHub OWNER/REPO sources and lowercase skill IDs only" }),
        url: `https://skills.sh/${item.source.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(skill)}` };
    });
  }

  async preview(value: string, signal: AbortSignal): Promise<SkillBundle> {
    signal.throwIfAborted();
    const requested = reference(value);
    const operation = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
    const api = `https://api.github.com/repos/${requested.source}`;
    const commit = requested.commit ?? z.object({ sha: shaSchema }).parse(await this.network.json(`${api}/commits/HEAD`, operation)).sha;
    const tree = treeSchema.parse(await this.network.json(`${api}/git/trees/${commit}?recursive=1`, operation));
    if (tree.truncated) throw new Error("Repository tree is truncated; cannot safely identify the complete skill");
    const paths = new Set<string>();
    for (const entry of tree.tree) {
      safeRelative(entry.path);
      if (paths.has(entry.path)) throw new Error("Duplicate repository tree path");
      paths.add(entry.path);
    }
    const candidates = tree.tree.filter((entry) => path.posix.basename(entry.path) === "SKILL.md" &&
      (path.posix.basename(path.posix.dirname(entry.path)) === requested.skill || entry.path === "SKILL.md"));
    if (candidates.length !== 1) throw new Error("Skill directory is missing or ambiguous. Use the skillId returned by skills.sh search.");
    const candidate = candidates[0]!;
    const directory = path.posix.dirname(candidate.path);
    const prefix = directory === "." ? "" : `${directory}/`;
    const entries = tree.tree.filter((entry) => entry.path.startsWith(prefix) && entry.type !== "tree");
    if (entries.length > 17) throw new Error("This skill exceeds Jev's limit of SKILL.md plus 16 supporting files");
    if (tree.tree.some((entry) => entry.path.startsWith(prefix) &&
      entry.path.slice(prefix.length).split("/").length > (entry.type === "tree" ? 4 : 5))) {
      throw new Error("This skill exceeds Jev's resource depth limit");
    }
    const filenames = new Set<string>();
    let bytes = 0;
    for (const entry of entries) {
      const relative = entry.path.slice(prefix.length);
      safeCapabilityPath(relative);
      if (relative === MARKETPLACE_RECEIPT || (relative !== "SKILL.md" && path.posix.basename(relative) === "SKILL.md")) {
        throw new Error("Nested skills or reserved marketplace metadata are not supported");
      }
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("Skill symlinks and submodules are not supported");
      if (entry.size === undefined || entry.size > 100_000) throw new Error("Skill file size is missing or exceeds 100000 bytes");
      bytes += entry.size;
      if (bytes > 80_000) throw new Error("Skill bundle exceeds the 80000-byte review limit");
      if (filenames.has(relative.toLowerCase())) throw new Error("Skill contains case-colliding paths");
      filenames.add(relative.toLowerCase());
    }
    const files: SkillBundle["files"] = [];
    for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path))) {
      operation.throwIfAborted();
      const url = `https://raw.githubusercontent.com/${requested.source}/${commit}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
      const content = await this.network.text(url, operation);
      const size = Buffer.byteLength(content);
      const blob = createHash("sha1").update(`blob ${size}\0`).update(content).digest("hex");
      if (size !== entry.size || blob !== entry.sha) throw new Error("Downloaded skill file does not match its pinned Git blob");
      if (content.includes("\0")) throw new Error("Binary skill resources are not supported");
      ensureShareable(content);
      files.push({ path: entry.path.slice(prefix.length), content, sha256: digest(content) });
    }
    const markdown = files.find((file) => file.path === "SKILL.md");
    if (!markdown) throw new Error("Skill bundle is missing SKILL.md");
    const { metadata } = parseSkillMarkdown(markdown.content);
    if (directory === "." && metadata.name !== requested.skill) throw new Error("Root SKILL.md does not match the requested skill");
    return { id: metadata.name, source: requested.source, commit, directory, files };
  }
}

export function skillReview(bundle: SkillBundle): string {
  const review = JSON.stringify({
    warning: "UNTRUSTED public skill. Popularity is not a safety rating. Review every file. Installation persists instructions available to future tasks; it does not run scripts or grant permissions.",
    ...bundle, destination: `.jev/skills/${bundle.id}`, license: "Review the skill's license and source repository before use.",
  }, null, 2);
  if (review.length > 96_000) throw new Error("Skill contents exceed the full review limit; installation refused");
  return review;
}

async function destination(project: Project, id: string): Promise<string> {
  await project.workspace.path(".");
  await reloadCapabilities(project);
  if (project.skills.some((skill) => skill.id === id)) throw new Error("A skill with this ID already exists; installations never overwrite or shadow skills");
  if (project.skills.length >= 64) throw new Error("At most 64 skills may be installed through the marketplace");
  const relative = `.jev/skills/${id}`;
  if (project.workspace.protectedPaths.some((prefix) => relative.toLowerCase() === prefix.toLowerCase() ||
    relative.toLowerCase().startsWith(`${prefix.toLowerCase()}/`) || prefix.toLowerCase().startsWith(`${relative.toLowerCase()}/`))) {
    throw new BlockedError("Skill installation is protected by workspace policy");
  }
  const target = await resolvePath(project.workspace.root, relative, true);
  try { await lstat(target); }
  catch (error) { if (isMissing(error)) return target; throw error; }
  throw new Error("Skill destination already exists; installations never overwrite files");
}

async function publish(project: Project, bundle: SkillBundle, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const target = await destination(project, bundle.id);
  await resolvePath(project.workspace.root, ".jev/skills");
  signal.throwIfAborted();
  await mkdir(target, { mode: 0o700 });
  const created: string[] = [];
  const directories = new Set<string>();
  const stage = `.skill-${randomUUID()}.tmp`;
  let published = false;
  const origin = { marketplace: "skills.sh" as const, source: bundle.source, commit: bundle.commit, directory: bundle.directory,
    files: Object.fromEntries(bundle.files.map((file) => [file.path, file.sha256])) };
  const write = async (relative: string, content: string): Promise<void> => {
    signal.throwIfAborted();
    const parts = relative.split("/");
    for (let index = 1; index < parts.length; index++) {
      const directory = parts.slice(0, index).join("/");
      if (directories.has(directory)) continue;
      const absolute = await resolvePath(target, directory, true);
      await mkdir(absolute, { mode: 0o700 });
      directories.add(directory);
    }
    await resolvePath(project.workspace.root, `.jev/skills/${bundle.id}`);
    const filename = await resolvePath(target, relative, true);
    const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created.push(relative);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  };
  try {
    for (const file of bundle.files) if (file.path !== "SKILL.md") await write(file.path, file.content);
    await write(MARKETPLACE_RECEIPT, `${JSON.stringify(origin, null, 2)}\n`);
    await write(stage, bundle.files.find((file) => file.path === "SKILL.md")!.content);
    signal.throwIfAborted();
    await resolvePath(project.workspace.root, `.jev/skills/${bundle.id}`);
    await link(await resolvePath(target, stage), await resolvePath(target, "SKILL.md", true));
    published = true;
    await unlink(await resolvePath(target, stage));
    const { metadata } = parseSkillMarkdown(bundle.files.find((file) => file.path === "SKILL.md")!.content);
    const skill: Skill = {
      id: bundle.id, version: "1", description: metadata.description, mandatory: false,
      instructions: `.jev/skills/${bundle.id}/SKILL.md`,
      resources: bundle.files.filter((file) => file.path !== "SKILL.md").map((file) => `.jev/skills/${bundle.id}/${file.path}`),
      modelInvocable: !metadata["disable-model-invocation"], userInvocable: metadata["user-invocable"] !== false,
      argumentHint: metadata["argument-hint"],
      provenance: { root: project.workspace.root, scope: "project", format: "skill-md",
        source: `.jev/skills/${bundle.id}/SKILL.md`, marketplace: origin },
    };
    project.skills.push(skill);
  } finally {
    if (!published) {
      await resolvePath(project.workspace.root, `.jev/skills/${bundle.id}`);
      for (const relative of created.reverse()) await unlink(await resolvePath(target, relative));
      for (const directory of [...directories].reverse()) await rmdir(await resolvePath(target, directory));
      await rmdir(target);
    }
  }
}

export async function handleMarketplaceCommand(action: string, argument: string, project: Project, access: MarketplaceAccess,
  io: MarketplaceIO, marketplace = new SkillsMarketplace()): Promise<void> {
  io.signal.throwIfAborted();
  if (action === "search") {
    io.write("Searching skills.sh sends only your search terms to that public service; do not include private information.\n");
    const skills = await marketplace.search(argument, io.signal);
    io.write(`${JSON.stringify({ marketplace: "skills.sh", warning: "Install counts are popularity, not a safety rating.", skills }, null, 2)}\n`);
    return;
  }
  if (action !== "preview" && action !== "install") throw new Error("Usage: skills search QUERY | preview OWNER/REPO@SKILL | install OWNER/REPO@SKILL");
  if (action === "install" && (access.planMode || !access.write)) throw new BlockedError("Skill installation requires edit permission outside plan mode");
  const bundle = await marketplace.preview(argument, io.signal);
  const review = skillReview(bundle);
  if (action === "preview") { io.write(`${review}\n`); return; }
  await destination(project, bundle.id);
  if (!await io.confirm(`${review}\nInstall these exact files for this project? Type yes: `, io.signal)) {
    io.write("Skill installation cancelled; no files written.\n"); return;
  }
  io.signal.throwIfAborted();
  await publish(project, bundle, io.signal);
  io.write(`Installed ${bundle.id} from ${bundle.source} at ${bundle.commit}. No scripts executed or permissions granted.\n`);
}
