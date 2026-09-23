import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { ExtensionHost, handleExtensionCommand, playwrightPreset, type ExtensionIO } from "../src/extensions.js";
import { mcpServerSchema } from "../src/extension-config.js";
import { loadProject } from "../src/registry.js";
import { run } from "../src/runtime.js";
import { fixture, call, final, options, scripted } from "./helpers.js";

const config = () => mcpServerSchema.parse({ transport: "stdio", executable: process.execPath,
  args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000 });
const io = (approve = true): ExtensionIO => ({ permissions: { write: true, commands: false, external: true },
  signal: new AbortController().signal, confirm: async () => approve, write() {} });

test("MCP setup saves only approved configuration and preserves session-only model overrides", async (t) => {
  const project = await fixture(t);
  const originalModel = project.config.llm.model;
  project.config.llm.model = "session-only-model";
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  await assert.rejects(host.configure("local", config(), io(false)), /not approved/);
  assert.deepEqual(host.status().mcp, []);
  await host.configure("local", config(), io());
  assert.equal(host.status().mcp[0]!.connected, false);
  assert.equal(project.config.llm.model, "session-only-model");
  assert.ok(project.config.extensions?.mcp.local);
  const reloaded = await loadProject(project.workspace.root, { globalRoot: null });
  assert.equal(reloaded.config.llm.model, originalModel);
  assert.deepEqual(reloaded.config.extensions?.mcp.local, config());
  await assert.rejects(host.configure("local", config(), io()), /already exists/);
  await host.configure("second", config(), io());
  assert.equal(host.status().mcp.length, 2);
});

test("Playwright preset is pinned, ignores npm install scripts, and stays disconnected", async (t) => {
  const project = await fixture(t);
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  let approval = "";
  await handleExtensionCommand("/mcp add playwright", host, { ...io(), confirm: async (prompt) => { approval = prompt; return true; } });
  assert.equal(playwrightPreset.transport, "stdio");
  if (playwrightPreset.transport === "stdio") {
    assert.match(playwrightPreset.args.join(" "), /@playwright\/mcp@\d+\.\d+\.\d+/);
    assert.ok(playwrightPreset.args.includes("--ignore-scripts"));
    assert.ok(playwrightPreset.args.includes("--isolated"));
  }
  assert.match(approval, /Does not install packages/);
  assert.equal(host.status().mcp[0]!.connected, false);
});

test("MCP setup honors read-only/plan policy, protected config, cancellation and disk changes", async (t) => {
  const project = await fixture(t);
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  await assert.rejects(host.configure("local", config(), { ...io(), permissions: { write: false, commands: false } }), /edit permission/);
  await assert.rejects(host.configure("local", config(), { ...io(), planMode: true }), /plan/);
  project.workspace.protectedPaths.push(".jev/config.json");
  await assert.rejects(host.configure("local", config(), io()), /protected/);
  project.workspace.protectedPaths.length = 0;
  await assert.rejects(host.configure("local", config(), { ...io(), confirm: async () => { await host.cancel(); return true; } }), /closed/);
  const file = path.join(project.workspace.root, ".jev/config.json");
  const changed = JSON.parse(await readFile(file, "utf8"));
  changed.extensions = { plugins: {}, hooks: {}, mcp: { existing: config() } };
  await writeFile(file, JSON.stringify(changed));
  await assert.rejects(host.configure("local", config(), io()), /changed on disk/);
  assert.equal((await loadProject(project.workspace.root, { globalRoot: null })).config.extensions?.mcp.local, undefined);
});

test("custom MCP setup preserves whitespace inside JSON argument strings", async (t) => {
  const project = await fixture(t);
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  const server = mcpServerSchema.parse({ transport: "stdio", executable: "node", args: ["two  spaces\tand a tab"] });
  await handleExtensionCommand(`/mcp add custom ${JSON.stringify(server, null, 2)}`, host, io());
  assert.deepEqual((await loadProject(project.workspace.root, { globalRoot: null })).config.extensions?.mcp.custom, server);
  assert.equal(host.status().mcp[0]!.connected, false);
});

test("model-managed MCP setup, connection and calls each require approval, and newly connected tools appear next turn", async (t) => {
  const project = await fixture(t);
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  const approvals: string[] = [];
  let turn = 0;
  const result = await run(project, options({
    async complete(_messages, tools) {
      const names = tools.map((tool) => tool.function.name);
      if (turn++ === 0) {
        assert.ok(names.includes("configure_mcp") && names.includes("connect_mcp"));
        return call("configure_mcp", { id: "local", server: config() });
      }
      if (turn === 2) return call("connect_mcp", { id: "local" });
      if (turn === 3) {
        const external = names.find((name) => name.startsWith("mcp__"));
        assert.ok(external, "Fresh MCP tools must be exposed without restarting the turn");
        return call(external, { mode: "echo" });
      }
      return final();
    },
  }, { extensions: host, editApproval: "auto", permissions: io().permissions,
    approve: async (action) => { approvals.push(action.name); return true; } }));
  assert.equal(result.status, "completed", result.text);
  assert.equal(approvals[0], "configure_mcp");
  assert.equal(approvals[1], "connect_mcp");
  assert.match(approvals[2]!, /^mcp__/);
  assert.equal(approvals.length, 3);
});

test("automatic workspace editing never approves MCP setup, and unavailable contexts cannot manage servers", async (t) => {
  const project = await fixture(t);
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  const result = await run(project, options(scripted([call("configure_mcp", { id: "playwright", preset: "playwright" })]), {
    extensions: host, editApproval: "auto", permissions: io().permissions, approve: async () => false,
  }));
  assert.equal(result.status, "blocked");
  assert.deepEqual(host.status().mcp, []);
  for (const context of [{ ...io(), planMode: true }, { ...io(), background: true }, { ...io(), specialist: true }]) {
    assert.deepEqual(host.managementTools(context), []);
  }
  const withoutExternal = host.managementTools({ permissions: { write: true, commands: false } }).map((tool) => tool.name);
  assert.ok(withoutExternal.includes("configure_mcp"));
  assert.ok(!withoutExternal.includes("connect_mcp"));
  assert.ok(!host.managementTools({ permissions: { write: false, commands: false } }).some((tool) => tool.name === "configure_mcp"));
});
