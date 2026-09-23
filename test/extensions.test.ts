import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadProject, loadSkills } from "../src/registry.js";
import { frontmatter, skillResource } from "../src/skill-catalog.js";
import { ExtensionHost, handleExtensionCommand, type ExtensionIO } from "../src/extensions.js";
import { extensionsSchema, mcpServerSchema, hookSchema } from "../src/extension-config.js";
import { run } from "../src/runtime.js";
import { capabilityCatalog } from "../src/capabilities.js";
import { commandEnvironment } from "../src/extension-process.js";
import { transportBridge } from "../src/mcp.js";
import { routeTask, JevClient } from "../src/jev.js";
import { commandCompletions, handleChatCommand, newChatMetrics } from "../src/chat-commands.js";
import { benchmark } from "../src/evaluation.js";
import { fixture, options, scripted, call, final, server, requestBody } from "./helpers.js";
import type { Project } from "../src/registry.js";
import type { PreparedAction } from "../src/tools.js";

const signal = () => new AbortController().signal;
const io = (overrides: Partial<ExtensionIO> = {}): ExtensionIO => ({
  permissions: { write: false, commands: false, external: true }, signal: signal(),
  write() {}, confirm: async () => true, ...overrides,
});
const mockServer = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
function stdio(project: Project, timeoutMs = 2000): ExtensionHost {
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath, args: [mockServer], env: { SELECTED: "JEV_SELECTED" }, timeoutMs,
  } } });
  return new ExtensionHost(project, { PATH: process.env.PATH, JEV_TEST_SECRET: "not-inherited", JEV_SELECTED: "chosen" });
}
async function put(project: Project, file: string, content: string): Promise<void> {
  const target = path.join(project.workspace.root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("standard and compatibility catalogs expose provenance, precedence, resources and invocation controls", async (t) => {
  const project = await fixture(t);
  const skill = "---\nname: deploy\ndescription: Deploy code\ndisable-model-invocation: true\nargument-hint: target\n---\nDeploy $ARGUMENTS; first $0 / $ARGUMENTS[0].";
  await put(project, ".jev/skills/deploy/SKILL.md", skill);
  await put(project, ".jev/skills/deploy/references/guide.md", "Deployment reference.");
  await put(project, ".claude/skills/deploy/SKILL.md", skill.replace("Deploy code", "Lower precedence"));
  await put(project, ".claude/commands/explain.md", "---\ndescription: Explain code\n---\nExplain $ARGUMENTS.");
  await put(project, ".claude/agents/reviewer.md", "---\nname: reviewer\ndescription: Review code\ntools: Read, Grep\n---\nInspect code evidence.");
  await put(project, "user-catalog/skills/deploy/SKILL.md", skill.replace("Deploy code", "Global shadowed"));
  await put(project, "user-catalog/skills/global/SKILL.md", "---\nname: global\ndescription: Global skill\nuser-invocable: false\n---\nGlobal instructions.");
  const loaded = await loadProject(project.workspace.root, { globalRoot: path.join(project.workspace.root, "user-catalog") });
  assert.equal(loaded.skills.find((item) => item.id === "deploy")?.description, "Deploy code");
  assert.equal(loaded.skills.find((item) => item.id === "global")?.provenance?.scope, "user");
  assert.deepEqual(loaded.specialists.find((item) => item.id === "reviewer")?.tools, ["read_file", "search_files"]);
  assert.equal(capabilityCatalog(loaded, "model").skills.some((item) => item.id === "deploy"), false);
  const content = await loadSkills(loaded, ["deploy"], { arguments: { deploy: "production now" } });
  assert.match(content.text, /Deploy production now; first production \/ production/);
  assert.doesNotMatch(content.text, /Deployment reference/);
  assert.equal(await skillResource(loaded.skills.find((item) => item.id === "deploy")!, loaded.workspace.root,
    ".jev/skills/deploy/references/guide.md"), "Deployment reference.");
  await assert.rejects(loadSkills(loaded, ["deploy"], { source: "model" }), /not model-invocable/);
  await assert.rejects(loadSkills(loaded, ["global"]), /not user-invocable/);
  assert.match((await loadSkills(loaded, ["global"], { source: "model" })).text, /Global instructions/);
  await assert.rejects(loaded.workspace.path(".claude/commands/explain.md", true), /protected/);
});

test("unsafe YAML, unsupported active fields, symlinks, secrets and shell interpolation are rejected", async (t) => {
  for (const yaml of ["name: x\nname: y", "name: &name test\ndescription: *name", "name: !!str test"]) {
    assert.throws(() => frontmatter(`---\n${yaml}\n---\nInstructions.`), /YAML/);
  }
  assert.throws(() => frontmatter("---\nname: test\n---\n!`echo secret`"), /shell interpolation/);
  const project = await fixture(t);
  await put(project, ".jev/skills/active/SKILL.md", "---\nname: active\ndescription: Test\nallowed-tools: Bash\n---\nInstructions.");
  await assert.rejects(loadProject(project.workspace.root, { globalRoot: null }), /allowed-tools/);
  await put(project, ".jev/skills/active/SKILL.md", "---\nname: active\ndescription: Test\n---\nInstructions.");
  await put(project, ".jev/skills/active/.env", "do-not-read");
  await assert.rejects(loadProject(project.workspace.root, { globalRoot: null }), /Credential/);
  const second = await fixture(t);
  await mkdir(path.join(second.workspace.root, ".jev/skills/linked"));
  await symlink(path.join(second.workspace.root, "AGENTS.md"), path.join(second.workspace.root, ".jev/skills/linked/SKILL.md"));
  await assert.rejects(loadProject(second.workspace.root, { globalRoot: null }), /Symbolic/);
});

test("missing global definitions fail explicitly, and legacy JSON preserves literal shell placeholders", async (t) => {
  const project = await fixture(t);
  await put(project, ".jev/skills/testing.md", "Shell documentation uses $0 and $ARGUMENTS literally.");
  assert.match((await loadSkills(project, ["testing"])).text, /\$0 and \$ARGUMENTS/);
  assert.equal((await loadProject(project.workspace.root, { globalRoot: path.join(project.workspace.root, "absent") })).skills.length, 2);
  await put(project, "user-catalog/skills/missing.json", JSON.stringify({
    id: "missing", version: "1", description: "Invalid definition", instructions: "skills/missing.md",
  }));
  await assert.rejects(loadProject(project.workspace.root, { globalRoot: path.join(project.workspace.root, "user-catalog") }), /ENOENT/);
});

test("runtime blocks model invocation of user-only skills but explicit user selection works", async (t) => {
  const project = await fixture(t);
  await put(project, ".jev/skills/manual/SKILL.md", "---\nname: manual\ndescription: User only\ndisable-model-invocation: true\n---\nTask $ARGUMENTS.");
  const loaded = await loadProject(project.workspace.root, { globalRoot: null });
  const denied = await run(loaded, options(scripted([call("load_skill", { skillId: "manual" })])));
  assert.equal(denied.status, "blocked");
  const allowed = await run(loaded, options(scripted([final()], (messages) => {
    assert.match(messages[0]!.content!, /Task chosen/);
  }), { skills: ["manual"], skillArguments: { manual: "chosen" } }));
  assert.equal(allowed.status, "completed");
});

test("Jev intake excludes user-only skills and the slash command supplies arguments without pinning", async (t) => {
  const project = await fixture(t);
  await put(project, ".jev/skills/manual/SKILL.md", "---\nname: manual\ndescription: Do not route me\ndisable-model-invocation: true\n---\nTask $ARGUMENTS.");
  await put(project, ".jev/skills/hidden/SKILL.md", "---\nname: hidden\ndescription: Background knowledge\nuser-invocable: false\n---\nKnowledge.");
  const loaded = await loadProject(project.workspace.root, { globalRoot: null });
  loaded.config.jev.mode = "on";
  class CaptureClient extends JevClient {
    override async evaluate(_state: unknown, questions: Record<string, import("../src/jev.js").Question>) {
      assert.doesNotMatch(JSON.stringify(questions), /Do not route me/);
      return Object.fromEntries(Object.entries(questions).filter(([, question]) => question.type === "noul")
        .map(([key]) => [key, { type: "noul" as const, noul: 1 }]));
    }
  }
  loaded.config.jev.routeSpecialists = false;
  const client = new CaptureClient(loaded.config.jev, undefined, () => {}, () => {});
  const route = await routeTask(loaded, "use all skills", { skillIds: [], specialistId: null }, client, signal(), () => {});
  assert.equal(route.skillIds.includes("manual"), false);
  assert.equal(route.skillIds.includes("hidden"), true);
  const state = { project: loaded, model: scripted([]), messages: [], settings: { skills: [], permissions: { write: false, commands: false } },
    planMode: false, runs: 0, compactions: 0, metrics: newChatMetrics() };
  assert.deepEqual(await handleChatCommand("/manual target", state, io()),
    { kind: "task", task: "target", skills: ["manual"], skillArguments: { manual: "target" } });
  assert.deepEqual(state.settings.skills, []);
  assert.deepEqual(commandCompletions(loaded, "/hidden")[0], []);
  await assert.rejects(handleChatCommand("/hidden target", state, io()), /not user-invocable/);
});

test("plugins are passive until approved, scoped, revocable and require renewed trust on manifest changes", async (t) => {
  const project = await fixture(t);
  const manifest = { version: 1, id: "demo", description: "Local test", skills: "skills",
    mcp: { local: { transport: "stdio", executable: process.execPath, args: [mockServer] } } };
  await put(project, ".jev/plugins/demo/jev-plugin.json", JSON.stringify(manifest));
  await put(project, ".jev/plugins/demo/skills/plugin-skill/SKILL.md", "---\nname: plugin-skill\ndescription: Plugin skill\n---\nPlugin instructions.");
  project.config.extensions = extensionsSchema.parse({ plugins: { demo: ".jev/plugins/demo" } });
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  assert.deepEqual(host.status().mcp, []);
  await assert.rejects(host.enablePlugin("demo", io({ confirm: async () => false })), /not approved/);
  assert.equal(project.skills.some((item) => item.id === "plugin-skill"), false);
  await host.enablePlugin("demo", io({ permissions: { write: false, commands: false } }));
  assert.equal(host.status().mcp[0]?.connected, false);
  assert.equal(project.skills.find((item) => item.id === "plugin-skill")?.provenance?.pluginId, "demo");
  await put(project, ".jev/plugins/demo/jev-plugin.json", JSON.stringify({ ...manifest, description: "changed" }));
  await assert.rejects(host.connect("demo--local", io()), /manifest changed/);
  await host.disablePlugin("demo");
  assert.equal(project.skills.some((item) => item.id === "plugin-skill"), false);
  assert.deepEqual(host.status().mcp, []);
});

test("MCP stdio discovery is explicitly trusted and every tool call requires approval despite readOnlyHint", async (t) => {
  const project = await fixture(t);
  const host = stdio(project);
  t.after(() => host.close());
  assert.equal(await handleExtensionCommand("/mcp status", host, io()), true);
  assert.equal(host.status().mcp[0]?.connected, false);
  for (const context of [
    io({ permissions: { write: true, commands: true } }), io({ planMode: true }), io({ background: true }), io({ specialist: true }),
  ]) await assert.rejects(host.connect("local", context), /permission|plan, background/);
  await assert.rejects(host.connect("local", io({ confirm: async () => false })), /not approved/);
  await host.connect("local", io());
  const tool = host.tools(io())[0]!;
  assert.match(tool.name, /^mcp__/);
  assert.notEqual(tool.name, "read_file");
  await assert.rejects(tool.prepare({ mode: 1 }), /schema/);
  assert.equal((await tool.prepare({ mode: "echo" })).mutating, true);
  const denied = await run(project, options(scripted([call(tool.name, { mode: "echo" })]), {
    extensions: host, permissions: io().permissions, approve: async () => false,
  }));
  assert.equal(denied.status, "blocked");
  let approved = 0;
  const success = await run(project, options(scripted([call(tool.name, { mode: "echo" }), final()], (messages, _tools, index) => {
    if (index) {
      const text = messages.at(-1)!.content!;
      assert.match(text, /inheritedSecret\\":false/);
      assert.match(text, /inheritedHome\\":false/);
      assert.match(text, /chosen/);
    }
  }), { extensions: host, permissions: io().permissions, approve: async () => { approved++; return true; } }));
  assert.equal(success.status, "completed");
  assert.equal(approved, 1);
  for (const context of [io({ planMode: true }), io({ background: true }), io({ specialist: true }), io({ permissions: { write: true, commands: true } })]) {
    assert.deepEqual(host.tools(context), []);
  }
  await host.cancel();
  assert.equal(host.status().mcp[0]?.connected, false);
  await host.connect("local", io());
  assert.equal(host.status().mcp[0]?.connected, true);
});

test("MCP pending calls settle on cancellation, EOF, deadline and oversized protocol output", async (t) => {
  const project = await fixture(t);
  for (const mode of ["hang", "eof", "oversize"]) {
    const host = stdio(project, 300);
    await host.connect("local", io());
    const action = await host.tools(io())[0]!.prepare({ mode });
    await assert.rejects(action.execute(signal()), /MCP call failed/);
    assert.equal(host.status().mcp[0]?.connected, false);
    await host.close();
  }
  const host = stdio(project);
  t.after(() => host.close());
  await host.connect("local", io());
  const controller = new AbortController();
  const action = await host.tools(io())[0]!.prepare({ mode: "hang" });
  const pending = action.execute(controller.signal);
  controller.abort();
  await assert.rejects(pending, /MCP call failed/);
  assert.equal(host.status().mcp[0]?.connected, false);
});

test("run cancellation, plan mode and read-only mode close MCP processes without hidden calls", async (t) => {
  const project = await fixture(t);
  const host = stdio(project);
  t.after(() => host.close());
  await host.connect("local", io());
  const action = await host.tools(io())[0]!.prepare({ mode: "echo" });
  const output = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(await action.execute(signal()));
  const pid = z.object({ pid: z.number() }).parse(JSON.parse(output.content[0]!.text)).pid;
  const result = await run(project, options(scripted([final()], (_messages, tools) => {
    assert.equal(tools.some((tool) => tool.function.name.startsWith("mcp__")), false);
  }), { extensions: host, planMode: true, permissions: io().permissions }));
  assert.equal(result.status, "completed");
  assert.equal(host.status().mcp[0]?.connected, false);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await host.connect("local", io());
  const controller = new AbortController();
  const cancelled = await run(project, options({ async complete() { controller.abort(new Error("cancel test")); throw new Error("cancel test"); } },
    { extensions: host, signal: controller.signal, permissions: io().permissions }));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(host.status().mcp[0]?.connected, false);
  await host.connect("local", io());
  await run(project, options(scripted([final()]), { extensions: host }));
  assert.equal(host.status().mcp[0]?.connected, false);
});

test("stdio disconnect terminates the owned Unix process group, including descendants", { skip: process.platform === "win32" }, async (t) => {
  const project = await fixture(t);
  const host = stdio(project);
  t.after(() => host.close());
  await host.connect("local", io());
  const output = z.object({ content: z.array(z.object({ text: z.string() })) })
    .parse(await (await host.tools(io())[0]!.prepare({ mode: "child" })).execute(signal()));
  const { childPid } = z.object({ childPid: z.number() }).parse(JSON.parse(output.content[0]!.text));
  await host.disconnect("local");
  let gone = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(childPid, 0); } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") { gone = true; break; }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(gone, true, "Descendant must not remain after disconnect");
});

test("official Streamable HTTP transport supports bounded trusted discovery and calls without redirects", async (t) => {
  const transports: StreamableHTTPServerTransport[] = [];
  const endpoint = await server(t, (request, response) => {
    const instance = new Server({ name: "http-test", version: "1" }, { capabilities: { tools: {} } });
    instance.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
      { name: "echo", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
    ] }));
    instance.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "HTTP works" }] }));
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    transports.push(transport);
    void instance.connect(transportBridge(transport)).then(() => transport.handleRequest(request, response));
  });
  t.after(async () => { for (const transport of transports) await transport.close(); });
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { http: { transport: "http", url: endpoint, timeoutMs: 1000 } } });
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  await host.connect("http", io());
  const result = await (await host.tools(io())[0]!.prepare({})).execute(signal());
  assert.match(JSON.stringify(result), /HTTP works/);
  const redirect = await server(t, (_request, response) => { response.writeHead(302, { Location: endpoint }); response.end(); });
  project.config.extensions = extensionsSchema.parse({ mcp: { redirect: { transport: "http", url: redirect, timeoutMs: 1000 } } });
  const other = new ExtensionHost(project);
  await assert.rejects(other.connect("redirect", io()), /connection or discovery failed/);
  await other.close();
});

test("stateful HTTP sessions are terminated explicitly on disconnect", async (t) => {
  const instance = new Server({ name: "stateful-test", version: "1" }, { capabilities: { tools: {} } });
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "jev-test-session", enableJsonResponse: true });
  await instance.connect(transportBridge(transport));
  t.after(() => instance.close());
  let deleted = false;
  const endpoint = await server(t, (request, response) => {
    if (request.method === "DELETE") deleted = true;
    void transport.handleRequest(request, response);
  });
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { stateful: { transport: "http", url: endpoint, timeoutMs: 1000 } } });
  const host = new ExtensionHost(project);
  await host.connect("stateful", io());
  await host.disconnect("stateful");
  assert.equal(deleted, true);
  await host.close();
});
test("hooks are fail-closed, cannot autoallow or alter arguments, and after failure acknowledges effects", async (t) => {
  const project = await fixture(t);
  const target = path.join(project.workspace.root, "hook-observed.json");
  const hook = hookSchema.parse({ event: "before", tools: ["write_file"], executable: process.execPath,
    args: ["-e", `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(target)},s);console.log(JSON.stringify({deny:true}));})`] });
  project.config.extensions = extensionsSchema.parse({ hooks: { policy: hook } });
  const host = new ExtensionHost(project, {});
  t.after(() => host.close());
  await assert.rejects(host.enableHook("policy", io({ permissions: { write: true, commands: true } })), /external permission/);
  await host.enableHook("policy", io());
  const result = await run(project, options(scripted([call("write_file", { path: "new.txt", content: "new", expectedHash: null })]), {
    extensions: host, permissions: { write: true, commands: false, external: true }, approve: async () => true,
  }));
  assert.equal(result.status, "blocked");
  assert.match(result.text, /not executed/);
  await assert.rejects(readFile(path.join(project.workspace.root, "new.txt")), /ENOENT/);
  assert.equal(JSON.parse(await readFile(target, "utf8")).tool, "write_file");
  host.disableHook("policy");
  project.config.extensions = extensionsSchema.parse({ hooks: { after: { ...hook, event: "after", args: ["-e", "process.exit(2)"] } } });
  const after = new ExtensionHost(project);
  t.after(() => after.close());
  await after.enableHook("after", io());
  const changed = await run(project, options(scripted([call("write_file", { path: "new.txt", content: "new", expectedHash: null })]), {
    extensions: after, permissions: { write: true, commands: false, external: true }, approve: async () => true,
  }));
  assert.equal(changed.status, "blocked");
  assert.match(changed.text, /ALREADY EXECUTED/);
  assert.equal(await readFile(path.join(project.workspace.root, "new.txt"), "utf8"), "new");
});

test("hooks reject unsupported output, bound process output/deadline, and cancel on host teardown", async (t) => {
  const project = await fixture(t);
  const action: PreparedAction = { name: "read_file", mutating: false, details: { path: "file.txt" }, execute: async () => null };
  for (const code of ["console.log('{\"allow\":true}')", "console.log('x'.repeat(300000))", "setTimeout(()=>{},10000)"]) {
    project.config.extensions = extensionsSchema.parse({ hooks: { policy: { event: "before", executable: process.execPath, args: ["-e", code], timeoutMs: 150 } } });
    const host = new ExtensionHost(project);
    await host.enableHook("policy", io());
    await assert.rejects(host.beforeTool(action, signal()), /Before hook policy denied or failed/);
    await host.close();
  }
  project.config.extensions = extensionsSchema.parse({ hooks: { policy: { event: "before", executable: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"] } } });
  const host = new ExtensionHost(project);
  await host.enableHook("policy", io());
  const pending = host.beforeTool(action, signal());
  await host.cancel();
  await assert.rejects(pending, /Before hook/);
  await host.close();
});

test("trusted hooks never run in read-only, plan, specialist or background contexts", async (t) => {
  const project = await fixture(t);
  await put(project, "safe.txt", "safe");
  project.config.extensions = extensionsSchema.parse({ hooks: { deny: { event: "before", executable: process.execPath,
    args: ["-e", "console.log('{\"deny\":true}')"] } } });
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  for (const extra of [{}, { planMode: true, permissions: io().permissions }, { background: true, permissions: io().permissions }]) {
    await host.enableHook("deny", io());
    const result = await run(project, options(scripted([call("read_file", { path: "safe.txt" }), final()]), { extensions: host, ...extra }));
    assert.equal(result.status, "completed");
    assert.equal(host.status().hooks[0]?.enabled, false);
  }
  await host.enableHook("deny", io());
  const result = await run(project, options(scripted([call("read_file", { path: "safe.txt" }), final("report"), final()]), {
    extensions: host, permissions: io().permissions, specialistId: "investigator",
  }));
  assert.equal(result.status, "completed");
});
test("extension config accepts only named secret references and paths without traversal", () => {
  assert.throws(() => mcpServerSchema.parse({ transport: "http", url: "https://example.com/?token=value" }), z.ZodError);
  assert.throws(() => mcpServerSchema.parse({ transport: "http", url: "https://example.com", headers: { Authorization: "Bearer secret" } }), z.ZodError);
  assert.throws(() => extensionsSchema.parse({ plugins: { bad: "../auth" } }), z.ZodError);
  assert.deepEqual(commandEnvironment({ executable: "node", args: [], env: {}, timeoutMs: 100 }, { PATH: "/bin", HOME: "/secret", TOKEN: "secret" }), { PATH: "/bin" });
});

test("read-only benchmark snapshots standard/global resources without provenance or user-only routing", async (t) => {
  const project = await fixture(t);
  await put(project, "user-catalog/skills/manual/SKILL.md", "---\nname: manual\ndescription: User only\ndisable-model-invocation: true\n---\nNever automatically select this.");
  await put(project, "user-catalog/skills/references/SKILL.md", "---\nname: references\ndescription: Useful references\nuser-invocable: false\n---\nConsult the resource.");
  await put(project, "user-catalog/skills/references/guide.md", "Global resource instruction.");
  const loaded = await loadProject(project.workspace.root, { globalRoot: path.join(project.workspace.root, "user-catalog") });
  const endpoint = await server(t, (request, response) => {
    void requestBody(request).then((body) => {
      assert.doesNotMatch(JSON.stringify(body), /User only|user-catalog/);
      const questions = z.record(z.string(), z.unknown()).parse(body.questions);
      response.end(JSON.stringify({ model: "mock", answers: Object.fromEntries(Object.keys(questions).map((key) =>
        [key, { type: "noul", noul: 1 }])), usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  Object.assign(loaded.config.jev, { allowDataSharing: true, endpoint });
  let resourcePrompts = 0;
  const result = await benchmark(loaded, { version: 1, split: "development", feature: "skills", repetitions: 1,
    tasks: [{ id: "test", task: "Explain code", files: {}, answerIncludes: ["Done"], minToolCalls: 0 }] }, signal(),
  scripted([final(), final()], (messages) => {
    assert.doesNotMatch(messages[0]!.content!, /Never automatically select this|user-catalog/);
    if (messages[0]!.content!.includes("Global resource instruction.")) resourcePrompts++;
  }), { TYPESAFE_API_KEY: "test-jev-key" });
  assert.equal(resourcePrompts, 1);
  assert.doesNotMatch(JSON.stringify(result), /user-catalog|test-jev-key/);
});
