import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir, symlink, link, readdir } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers.js";
import { configSchema } from "../src/config.js";
import { initialize } from "../src/init.js";
import { loadProject, loadSkills } from "../src/registry.js";
import { digest } from "../src/workspace.js";
import { createTools, executeCommand } from "../src/tools.js";

test("configuration defaults are safe and reject unsafe or unknown settings", () => {
  const base = { version: 1, llm: { model: "test" } };
  assert.equal(configSchema.parse(base).jev.mode, "off");
  assert.throws(() => configSchema.parse({ ...base, surprise: true }));
  assert.throws(() => configSchema.parse({ ...base, jev: { mode: "on" } }), /allowDataSharing/);
  assert.throws(() => configSchema.parse({ ...base, jev: { guardrail: "all" } }), /allowDataSharing/);
  assert.throws(() => configSchema.parse({ ...base, llm: { model: "x", baseUrl: "http://example.com" } }));
  assert.throws(() => configSchema.parse({ ...base, protectedPaths: ["../outside"] }));
});

test("init refuses overwrite; separate registries and mandatory skills load", async (t) => {
  const project = await fixture(t);
  await assert.rejects(initialize(project.workspace.root), /EEXIST/);
  assert.equal(project.skills.length, 2);
  assert.equal(project.specialists.length, 1);
  const skills = await loadSkills(project, ["testing", "coding"]);
  assert.deepEqual(skills.ids, ["coding", "testing"]);
  assert.match(skills.text, /# Coding/);
  await assert.rejects(loadSkills(project, ["unknown"]), /Unknown skill/);
  project.config.limits.maxSkillChars = 10;
  await assert.rejects(loadSkills(project, []), /budget/);
});

test("registry rejects duplicate IDs", async (t) => {
  const project = await fixture(t);
  const root = project.workspace.root;
  const original = await readFile(path.join(root, ".jev/skills/coding.json"));
  await writeFile(path.join(root, ".jev/skills/duplicate.json"), original);
  await assert.rejects(loadProject(root), /Duplicate skill/);
});

test("selected skill resources share the context budget and command references never grant permissions", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, ".jev/skills/reference.txt"), "Resource-specific convention");
  const skill = { ...project.skills.find((candidate) => candidate.id === "testing")!,
    resources: [".jev/skills/reference.txt"], commandIds: ["test"] };
  await writeFile(path.join(project.workspace.root, ".jev/skills/testing.json"), JSON.stringify(skill));
  const loaded = await loadProject(project.workspace.root);
  assert.doesNotMatch((await loadSkills(loaded, [])).text, /Resource-specific/);
  assert.match((await loadSkills(loaded, ["testing"])).text, /Resource-specific/);
  assert.ok(!createTools(loaded.workspace, loaded.config, { write: false, commands: false }).some((tool) => tool.name === "run_command"));
  loaded.config.limits.maxSkillChars = 10;
  await assert.rejects(loadSkills(loaded, ["testing"]), /budget/);
  await writeFile(path.join(project.workspace.root, ".jev/skills/testing.json"), JSON.stringify({ ...skill, commandIds: ["missing"] }));
  await assert.rejects(loadProject(project.workspace.root), /unknown configured command/);
  await writeFile(path.join(project.workspace.root, ".jev/skills/testing.json"), JSON.stringify({ ...skill, resources: [".jev/skills/../../file"] }));
  await assert.rejects(loadProject(project.workspace.root), /traversal/);
});
test("registry rejects unknown specialist skills and escaping instruction paths", async (t) => {
  const project = await fixture(t);
  const root = project.workspace.root;
  const specialist = { ...project.specialists[0], skills: ["missing"] };
  await writeFile(path.join(root, ".jev/specialists/investigator.json"), JSON.stringify(specialist));
  await assert.rejects(loadProject(root), /Unknown skill/);
  await writeFile(path.join(root, ".jev/specialists/investigator.json"), JSON.stringify(project.specialists[0]));
  await writeFile(path.join(root, ".jev/skills/coding.json"), JSON.stringify({
    ...project.skills[0], instructions: ".jev/skills/../../../outside",
  }));
  await assert.rejects(loadProject(root), /traversal/);
});

test("workspace rejects escapes, protected paths, symlinks, and hard links", async (t) => {
  const { workspace } = await fixture(t);
  await writeFile(path.join(workspace.root, "file.txt"), "safe");
  await symlink("file.txt", path.join(workspace.root, "alias.txt"));
  for (const relative of ["../outside", "/etc/passwd", ".jev/config.json", ".JEV/config.json", ".env.local", "x/../../y", "private.pem"]) {
    await assert.rejects(workspace.path(relative), /./, relative);
  }
  await assert.rejects(workspace.read("alias.txt"), /Symbolic/);
  await link(path.join(workspace.root, "file.txt"), path.join(workspace.root, "hard.txt"));
  await assert.rejects(workspace.read("hard.txt"), /Hard-linked/);
  const listing = await workspace.files();
  assert.ok(!listing.files.some((file) => file.includes(".jev") || file === "alias.txt"));
});

test("approved edits are versioned, atomic and support new directories", async (t) => {
  const project = await fixture(t);
  const tools = createTools(project.workspace, project.config, { write: true, commands: false });
  const write = tools.find((tool) => tool.name === "write_file")!;
  const replace = tools.find((tool) => tool.name === "replace_text")!;
  const signal = new AbortController().signal;
  await (await write.prepare({ path: "nested/file.txt", content: "first", expectedHash: null })).execute(signal);
  assert.equal(await project.workspace.read("nested/file.txt"), "first");
  await assert.rejects(write.prepare({ path: "nested/file.txt", content: "oops", expectedHash: null }), /changed/);
  const prepared = await replace.prepare({
    path: "nested/file.txt", oldText: "first", newText: "second", expectedHash: digest("first"),
  });
  await prepared.execute(signal);
  assert.equal(await project.workspace.read("nested/file.txt"), "second");
  assert.deepEqual(await readdir(path.join(project.workspace.root, "nested")), ["file.txt"]);
  await assert.rejects(write.prepare({ path: "AGENTS.md", content: "override", expectedHash: null }), /protected/);
});

test("edits recheck version after approval and do not follow new symlinks", async (t) => {
  const project = await fixture(t);
  const tools = createTools(project.workspace, project.config, { write: true, commands: false });
  const write = tools.find((tool) => tool.name === "write_file")!;
  await writeFile(path.join(project.workspace.root, "file.txt"), "before");
  const prepared = await write.prepare({ path: "file.txt", content: "agent", expectedHash: digest("before") });
  await writeFile(path.join(project.workspace.root, "file.txt"), "user edit");
  await assert.rejects(prepared.execute(new AbortController().signal), /changed/);
  assert.equal(await project.workspace.read("file.txt"), "user edit");
  const newFile = await write.prepare({ path: "new/file.txt", content: "no", expectedHash: null });
  await mkdir(path.join(project.workspace.root, "other"));
  await symlink("other", path.join(project.workspace.root, "new"));
  await assert.rejects(newFile.execute(new AbortController().signal), /Symbolic/);
});

test("tool schemas reject unexpected arguments and unavailable command IDs", async (t) => {
  const project = await fixture(t);
  const tools = createTools(project.workspace, project.config, { write: false, commands: true });
  assert.ok(!tools.some((tool) => tool.name === "write_file"));
  await assert.rejects(tools[0]!.prepare({ directory: ".", shell: "ignored?" }));
  const command = tools.find((tool) => tool.name === "run_command")!;
  await assert.rejects(command.prepare({ commandId: "constructor" }), /Unknown/);
});

test("configured commands return exit status and terminate on timeout", async (t) => {
  const project = await fixture(t);
  const result = await executeCommand(project.workspace, {
    description: "test", executable: process.execPath,
    args: ["-e", "process.stdout.write('hello');process.exitCode=2"], timeoutMs: 2000,
  }, new AbortController().signal);
  assert.deepEqual(result, { ok: false, exitCode: 2, signal: null, output: "hello" });
  await assert.rejects(executeCommand(project.workspace, {
    description: "test", executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"], timeoutMs: 100,
  }, new AbortController().signal), /deadline/);
});
