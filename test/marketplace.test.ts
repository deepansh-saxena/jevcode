import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SkillsMarketplace, handleMarketplaceCommand, type MarketplaceIO } from "../src/marketplace.js";
import { handleChatCommand, commandCompletions, newChatMetrics } from "../src/chat-commands.js";
import { loadProject, loadSkills } from "../src/registry.js";
import { fixture, scripted } from "./helpers.js";

const commit = "a".repeat(40);
const source = "example/skills@sample";
const markdown = "---\nname: sample\ndescription: A public test skill\nlicense: MIT\n---\nRead references/guide.md for guidance.";
const signal = () => new AbortController().signal;
function remote(files: Record<string, string> = { "SKILL.md": markdown, "references/guide.md": "Helpful instructions." },
  options: { mode?: string; truncated?: boolean; corrupt?: boolean; directory?: string } = {}) {
  const requests: string[] = [];
  const directory = options.directory ?? "skills/sample";
  const prefix = directory ? `${directory}/` : "";
  const tree = Object.entries(files).map(([name, content]) => ({
    path: `${prefix}${name}`, type: "blob", mode: options.mode ?? "100644", size: Buffer.byteLength(content),
    sha: createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex"),
  }));
  const marketplace = new SkillsMarketplace({
    async json(url) {
      requests.push(url);
      if (url.startsWith("https://skills.sh/api/search?")) return {
        skills: [{ source: "example/skills", skillId: "sample", name: "Sample skill", installs: 15 }],
      };
      if (url === "https://api.github.com/repos/example/skills/commits/HEAD") return { sha: commit };
      if (url === `https://api.github.com/repos/example/skills/git/trees/${commit}?recursive=1`) return { tree, truncated: options.truncated ?? false };
      throw new Error(`Unexpected request: ${url}`);
    },
    async text(url) {
      requests.push(url);
      const rawPrefix = `https://raw.githubusercontent.com/example/skills/${commit}/${prefix}`;
      assert.ok(url.startsWith(rawPrefix));
      const key = decodeURIComponent(url.slice(rawPrefix.length));
      const content = files[key];
      assert.notEqual(content, undefined);
      return options.corrupt ? `${content}!` : content!;
    },
  });
  return { marketplace, requests, tree };
}
function io(approve = false): MarketplaceIO & { output: string[]; prompts: string[] } {
  const output: string[] = [], prompts: string[] = [];
  return { output, prompts, signal: signal(), write: (text) => output.push(text),
    confirm: async (prompt) => { prompts.push(prompt); return approve; } };
}

test("public search uses only the query, exposes explicit sources, and never installs", async (t) => {
  const project = await fixture(t);
  const { marketplace, requests } = remote();
  const terminal = io();
  await handleMarketplaceCommand("search", "react testing", project, { write: false }, terminal, marketplace);
  assert.equal(requests.length, 1);
  assert.equal(requests[0], "https://skills.sh/api/search?q=react+testing&limit=10");
  assert.match(terminal.output.join(""), /example\/skills@sample/);
  assert.match(terminal.output.join(""), /not a safety rating/);
  assert.equal(terminal.prompts.length, 0);
  await assert.rejects(marketplace.search("x", signal()), /2-200/);
  await assert.rejects(marketplace.search("secret\nquery", signal()), /printable/);
});

test("preview pins a commit, checks Git blobs, and shows every file without local writes", async (t) => {
  const project = await fixture(t);
  const { marketplace, requests } = remote();
  const terminal = io();
  const before = await readdir(path.join(project.workspace.root, ".jev/skills"));
  await handleMarketplaceCommand("preview", source, project, { write: false }, terminal, marketplace);
  assert.match(terminal.output.join(""), /Helpful instructions/);
  assert.match(terminal.output.join(""), /"commit": "a{40}"/);
  assert.equal(terminal.prompts.length, 0);
  assert.deepEqual(await readdir(path.join(project.workspace.root, ".jev/skills")), before);
  assert.equal(requests.length, 4);
  const pinned = remote();
  await pinned.marketplace.preview(`${source}#${commit}`, signal());
  assert.equal(pinned.requests.some((url) => url.endsWith("/commits/HEAD")), false);
});

test("search explicitly labels unsupported external catalogs rather than hiding them or rejecting all results", async () => {
  const marketplace = new SkillsMarketplace({ text: async () => { throw new Error("No download expected"); },
    json: async () => ({ skills: [
      { source: "example/skills", skillId: "sample", name: "Sample", installs: 10 },
      { source: "skills.example.com", skillId: "sample", name: "External sample", installs: 5 },
    ] }) });
  const results = await marketplace.search("sample", signal());
  assert.equal(results.length, 2);
  assert.equal(results[0]!.reference, source);
  assert.equal(results[1]!.supported, false);
  assert.equal(results[1]!.reference, null);
  assert.match(results[1]!.reason!, /public GitHub/);
});

test("install requires write permission, is blocked in plan mode, and writes nothing on denial", async (t) => {
  const project = await fixture(t);
  const { marketplace, requests } = remote();
  for (const access of [{ write: false }, { write: true, planMode: true }]) {
    await assert.rejects(handleMarketplaceCommand("install", source, project, access, io(true), marketplace), /edit permission/);
  }
  assert.equal(requests.length, 0);
  const terminal = io();
  await handleMarketplaceCommand("install", source, project, { write: true }, terminal, marketplace);
  assert.equal(terminal.prompts.length, 1);
  assert.match(terminal.prompts[0]!, /SKILL.md/);
  assert.match(terminal.prompts[0]!, /Helpful instructions/);
  await assert.rejects(readFile(path.join(project.workspace.root, ".jev/skills/sample/SKILL.md")), /ENOENT/);
});

test("approved installation is available immediately and preserves resources and provenance across reload", async (t) => {
  const project = await fixture(t);
  const { marketplace } = remote();
  const terminal = io(true);
  await handleMarketplaceCommand("install", source, project, { write: true }, terminal, marketplace);
  assert.equal(project.skills.find((skill) => skill.id === "sample")?.provenance?.marketplace?.commit, commit);
  const loaded = await loadProject(project.workspace.root, { globalRoot: null });
  const skill = loaded.skills.find((skill) => skill.id === "sample")!;
  assert.equal(skill.provenance?.marketplace?.source, "example/skills");
  assert.deepEqual(skill.resources, [".jev/skills/sample/references/guide.md"]);
  assert.match((await loadSkills(loaded, ["sample"])).text, /Supporting resources/);
  assert.match((await loadSkills(loaded, ["sample"], { eagerResources: true })).text, /Helpful instructions/);
  assert.equal(await readFile(path.join(project.workspace.root, skill.instructions), "utf8"), markdown);
  assert.match(terminal.output.join(""), /No scripts executed/);
  await assert.rejects(handleMarketplaceCommand("install", source, project, { write: true }, io(true), marketplace), /already exists/);
});

test("cancellation or destination changes during approval cannot publish a skill", async (t) => {
  const project = await fixture(t);
  const { marketplace } = remote();
  const controller = new AbortController();
  await assert.rejects(handleMarketplaceCommand("install", source, project, { write: true }, {
    ...io(), signal: controller.signal, confirm: async () => { controller.abort(new Error("Cancelled")); return true; },
  }, marketplace), /Cancelled/);
  await assert.rejects(handleMarketplaceCommand("install", source, project, { write: true }, {
    ...io(), confirm: async () => {
      const target = path.join(project.workspace.root, ".jev/skills/sample");
      await mkdir(target);
      await writeFile(path.join(target, "keep.txt"), "Existing work");
      return true;
    },
  }, marketplace), /already exists/);
  assert.equal(await readFile(path.join(project.workspace.root, ".jev/skills/sample/keep.txt"), "utf8"), "Existing work");
  await assert.rejects(readFile(path.join(project.workspace.root, ".jev/skills/sample/SKILL.md")), /ENOENT/);
});

test("installation honors protected paths and refuses symlinked destinations", async (t) => {
  const project = await fixture(t);
  const { marketplace } = remote();
  project.workspace.protectedPaths.push(".jev/skills");
  await assert.rejects(handleMarketplaceCommand("install", source, project, { write: true }, io(true), marketplace), /protected/);
  project.workspace.protectedPaths.length = 0;
  await symlink(project.workspace.root, path.join(project.workspace.root, ".jev/skills/sample"));
  await assert.rejects(handleMarketplaceCommand("install", source, project, { write: true }, io(true), marketplace), /Symbolic links/);
});

test("remote references cannot change hosts, protocols, credentials or escape paths", async () => {
  const { marketplace, requests } = remote();
  for (const value of ["https://evil.test/a@sample", "example/../repo@sample", "example/skills@../sample", "example/skills@sample#main", "x:y/z@sample"]) {
    await assert.rejects(marketplace.preview(value, signal()));
  }
  assert.equal(requests.length, 0);
});

test("incomplete, corrupt, unsupported or oversized bundles fail explicitly", async () => {
  for (const [files, options, error] of [
    [{ "SKILL.md": markdown }, { truncated: true }, /truncated/],
    [{ "SKILL.md": markdown }, { corrupt: true }, /pinned Git blob/],
    [{ "SKILL.md": markdown }, { mode: "120000" }, /symlinks/],
    [{ "SKILL.md": markdown, "../escape": "no" }, {}, /file path/],
    [{ "SKILL.md": markdown, ".env": "no" }, {}, /protected/],
    [{ "SKILL.md": markdown, ".jev-marketplace.json": "{}" }, {}, /reserved/],
    [{ "SKILL.md": markdown, "nested/SKILL.md": markdown }, {}, /Nested skills/],
    [{ "SKILL.md": markdown, "data.bin": "\0" }, {}, /Binary/],
    [{ "SKILL.md": markdown, "large.txt": "a".repeat(80_001) }, {}, /review limit/],
    [{ "SKILL.md": markdown.replace("license: MIT", "allowed-tools: Bash") }, {}, /Unrecognized key/],
    [{ "SKILL.md": markdown, "Guide.md": "a", "guide.md": "b" }, {}, /case-colliding/],
  ] as const) {
    await assert.rejects(remote(files, options).marketplace.preview(source, signal()), error);
  }
  const excessive = { "SKILL.md": markdown, ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`file${i}.md`, "x"])) };
  await assert.rejects(remote(excessive).marketplace.preview(source, signal()), /16 supporting files/);
});

test("skill folder slugs can differ from frontmatter names, while root skills must match", async () => {
  const bundle = await remote({ "SKILL.md": markdown.replace("name: sample", "name: actual-name") }).marketplace.preview(source, signal());
  assert.equal(bundle.id, "actual-name");
  await assert.rejects(remote({ "SKILL.md": markdown.replace("name: sample", "name: actual-name") }, { directory: "" })
    .marketplace.preview(source, signal()), /does not match/);
});

test("marketplace slash commands share dispatch, completion, and installation approval", async (t) => {
  const project = await fixture(t);
  const mock = remote().marketplace;
  const preview = mock.preview.bind(mock), search = mock.search.bind(mock);
  t.mock.method(SkillsMarketplace.prototype, "preview", preview);
  t.mock.method(SkillsMarketplace.prototype, "search", search);
  const current = { project, model: scripted([]), messages: [], settings: { permissions: { write: true, commands: false } },
    planMode: false, runs: 0, compactions: 0, metrics: newChatMetrics() };
  const terminal = io(true);
  await handleChatCommand("/skills search testing", current, terminal);
  await handleChatCommand(`/skills preview ${source}`, current, terminal);
  await handleChatCommand(`/skills install ${source}`, current, terminal);
  assert.equal(terminal.prompts.length, 1);
  assert.equal(project.skills.some((skill) => skill.id === "sample"), true);
  assert.deepEqual(commandCompletions(project, "/skills pre")[0], ["/skills preview "]);
});

test("standalone CLI exposes marketplace commands but cannot approve installation through piped input", async () => {
  const exec = promisify(execFile);
  const cli = ["--import", "tsx", path.resolve("src/cli.ts")];
  assert.match((await exec(process.execPath, [...cli, "--help"])).stdout, /skills search QUERY/);
  await assert.rejects(exec(process.execPath, [...cli, "skills", "install", source, "--write"]), /interactive terminal/);
  await assert.rejects(exec(process.execPath, [...cli, "skills", "preview"]), /Usage: jevcode skills/);
});
