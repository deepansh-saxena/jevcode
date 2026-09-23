import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { capabilityTools, reloadCapabilities } from "../src/capabilities.js";
import { loadProject } from "../src/registry.js";
import { run } from "../src/runtime.js";
import { fixture, scripted, options, call, final } from "./helpers.js";
import type { Message } from "../src/llm.js";

const skill = { id: "regression-workflow", description: "Check boundary cases before a bug fix",
  instructions: "# Regression workflow\nInspect regressions and record only observed results.", commandIds: ["test"] };
const specialist = { id: "boundary-reader", description: "Read boundary behavior", role: "Inspect boundary cases and report evidence",
  skills: ["regression-workflow"], tools: ["read_file"], maxTurns: 3, maxToolCalls: 2 };
const report = JSON.stringify({ summary: "Observed the fixture", findings: [{ finding: "The export is present", evidence: ["value.ts:1"] }],
  changes: [], checks: [], unresolved: [] });
const signal = (): AbortSignal => new AbortController().signal;

test("model-authored capabilities persist after review and can be loaded and delegated in the same task", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "value.ts"), "export const CHILD_ONLY_OBSERVATION = 1;\n");
  const events: unknown[] = [];
  const approvals: string[] = [];
  const conversation: Message[] = [];
  const model = scripted([
    call("list_capabilities", {}), call("create_skill", skill), call("load_skill", { skillId: skill.id }),
    call("create_specialist", specialist), call("delegate_task", { specialistId: specialist.id, task: "Inspect value.ts" }),
    call("read_file", { path: "value.ts" }), final(report), final("Created and used the requested capabilities."),
  ], (messages, tools, index) => {
    if (index === 3) assert.match(messages[0]!.content!, /# Regression workflow/);
    if (index === 5 || index === 6) {
      assert.match(messages[0]!.content!, /Specialist role/);
      assert.deepEqual(tools.map((tool) => tool.function.name), ["read_file"]);
      assert.equal(messages[1]!.content, "Inspect value.ts");
      assert.ok(!messages.some((message) => message.tool_calls?.some((item) => item.function.name === "create_skill")));
    }
    if (index === 7) {
      assert.match(messages.at(-1)!.content!, /value.ts:1/);
      assert.doesNotMatch(JSON.stringify(messages), /CHILD_ONLY_OBSERVATION/);
    }
  });
  const result = await run(project, options(model, {
    task: "Create and use a regression skill and a read-only boundary specialist.",
    conversation, permissions: { write: true, commands: false },
    approve: async (action) => { approvals.push(action.name); return true; },
    emit: (event, data) => events.push({ event, data }),
  }));
  assert.equal(result.status, "completed", result.text);
  assert.deepEqual(approvals, ["create_skill", "create_specialist"]);
  assert.equal(result.metrics.turns, 8);
  assert.equal(result.metrics.toolCalls, 6);
  const reloaded = await loadProject(project.workspace.root, { globalRoot: null });
  const created = reloaded.skills.find((item) => item.id === skill.id)!;
  assert.ok(created);
  assert.equal(created.mandatory, false);
  assert.equal(await readFile(path.join(project.workspace.root, created.instructions), "utf8"), skill.instructions);
  assert.equal(reloaded.specialists.find((item) => item.id === specialist.id)?.resultFormat, "structured");
  if (process.platform !== "win32") {
    assert.equal((await stat(path.join(project.workspace.root, created.instructions))).mode & 0o777, 0o600);
  }
  assert.doesNotMatch(JSON.stringify(events), /record only observed results|CHILD_ONLY_OBSERVATION/);
  await assert.rejects(project.workspace.read(created.instructions), /protected/);
});

test("creation is unavailable in read-only and plan modes, and denial never persists a capability", async (t) => {
  for (const mode of ["read-only", "plan", "denied"] as const) {
    const project = await fixture(t);
    let approvals = 0;
    const model = scripted([call("create_skill", skill)], (_messages, tools) => {
      assert.equal(tools.some((tool) => tool.function.name === "create_skill"), mode === "denied");
      if (mode === "plan") assert.ok(!tools.some((tool) => ["write_file", "run_command", "create_specialist"].includes(tool.function.name)));
    });
    const result = await run(project, options(model, {
      permissions: { write: mode !== "read-only", commands: true }, planMode: mode === "plan",
      approve: async () => { approvals++; return false; },
    }));
    assert.equal(result.status, "blocked");
    assert.equal(approvals, mode === "denied" ? 1 : 0);
    assert.equal((await loadProject(project.workspace.root, { globalRoot: null })).skills.length, 2);
  }
});

test("capability validation rejects escalation, unknown references, invalid text, traversal, and over-budget skills", async (t) => {
  const project = await fixture(t);
  const tools = capabilityTools(project, true);
  const createSkill = tools.find((tool) => tool.name === "create_skill")!;
  const createSpecialist = tools.find((tool) => tool.name === "create_specialist")!;
  for (const args of [
    { ...skill, id: "../escape" }, { ...skill, mandatory: true },
    { ...skill, instructions: "NUL\0text" }, { ...skill, commandIds: ["unconfigured"] },
  ]) await assert.rejects(createSkill.prepare(args));
  for (const args of [
    { ...specialist, skills: ["missing"] }, { ...specialist, skills: [], tools: ["create_skill"] },
    { ...specialist, skills: [], tools: ["delegate_task"] }, { ...specialist, skills: [], permissions: { write: true } },
  ]) await assert.rejects(createSpecialist.prepare(args));
  project.config.limits.maxSkillChars = 100;
  await assert.rejects(createSkill.prepare(skill), /budget/);
  assert.equal((await loadProject(project.workspace.root, { globalRoot: null })).skills.length, 2);
});

test("creation revalidates after approval and refuses collisions and symbolic-link directories", async (t) => {
  const project = await fixture(t);
  const create = capabilityTools(project, true).find((tool) => tool.name === "create_skill")!;
  await assert.rejects(create.prepare({ ...skill, id: "testing" }), /already exists/);
  const prepared = await create.prepare(skill);
  const filename = path.join(project.workspace.root, `.jev/skills/${skill.id}.json`);
  const existing = JSON.stringify({ id: skill.id, version: "1", description: "Existing", instructions: ".jev/skills/testing.md" });
  await writeFile(filename, existing);
  await assert.rejects(prepared.execute(signal()), /already exists/);
  assert.equal(await readFile(filename, "utf8"), existing);
  assert.ok(!(await readdir(path.join(project.workspace.root, ".jev/skills"))).some((name) => name.startsWith(`${skill.id}-`)));
  const next = await create.prepare({ ...skill, id: "different" });
  await mkdir(path.join(project.workspace.root, "outside"));
  await rename(path.join(project.workspace.root, ".jev/skills"), path.join(project.workspace.root, ".jev/skills-original"));
  await symlink(path.join(project.workspace.root, "outside"), path.join(project.workspace.root, ".jev/skills"));
  await assert.rejects(next.execute(signal()), /Symbolic links/);
  assert.deepEqual(await readdir(path.join(project.workspace.root, "outside")), []);
});

test("cancelled creation and protected capability directories never write", async (t) => {
  const project = await fixture(t);
  const create = capabilityTools(project, true).find((tool) => tool.name === "create_skill")!;
  const prepared = await create.prepare(skill);
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await assert.rejects(prepared.execute(controller.signal), /Cancelled/);
  assert.equal((await readdir(path.join(project.workspace.root, ".jev/skills"))).length, 4);
  project.workspace.protectedPaths.push(".jev/skills");
  await assert.rejects(create.prepare(skill), /protected/);
});

test("dynamic delegation stays isolated, cannot nest or escalate, and consumes the shared specialist budget", async (t) => {
  const project = await fixture(t);
  project.config.limits.maxSpecialistRuns = 1;
  const result = await run(project, options(scripted([
    call("delegate_task", { specialistId: "investigator", task: "Read only" }), final(report),
    call("delegate_task", { specialistId: "investigator", task: "Read more" }),
  ])));
  assert.equal(result.status, "limited");
  assert.match(result.text, /Specialist run budget/);
  for (const tool of ["create_skill", "delegate_task"]) {
    const nested = await run(project, options(scripted([
      call("delegate_task", { specialistId: "investigator", task: "Read" }), call(tool, {}),
    ])));
    assert.equal(nested.status, "blocked");
    assert.match(nested.text, /Unavailable tool/);
  }
});

test("explicitly disabled dynamic capabilities and independent routing flags remove their tools", async (t) => {
  const project = await fixture(t);
  project.config.jev.routeSkills = false;
  project.config.jev.routeSpecialists = false;
  const model = scripted([final()], (_messages, tools) => {
    assert.ok(!tools.some((tool) => ["load_skill", "delegate_task"].includes(tool.function.name)));
  });
  assert.equal((await run(project, options(model))).status, "completed");
  const noDynamic = scripted([final()], (_messages, tools) => {
    assert.deepEqual(tools.map((tool) => tool.function.name), ["list_files", "read_file", "search_files"]);
  });
  assert.equal((await run(project, options(noDynamic, { dynamicCapabilities: false }))).status, "completed");
  project.config.llm.model = "session-override";
  await reloadCapabilities(project);
  assert.equal(project.config.llm.model, "session-override");
});

test("a dynamically delegated writer still cannot exceed parent permissions", async (t) => {
  const project = await fixture(t);
  project.specialists.push({ id: "writer", description: "Scoped writer", role: "Edit one file",
    skills: [], tools: ["write_file"], maxTurns: 2, maxToolCalls: 1, resultFormat: "structured" });
  const result = await run(project, options(scripted([
    call("delegate_task", { specialistId: "writer", task: "Create no.txt" }),
    call("write_file", { path: "no.txt", content: "no", expectedHash: null }),
  ], (_messages, tools, index) => { if (index === 1) assert.deepEqual(tools, []); })));
  assert.equal(result.status, "blocked");
  await assert.rejects(project.workspace.read("no.txt"), /ENOENT/);
});
