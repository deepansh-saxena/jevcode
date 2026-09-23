import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ExtensionHost, type ExtensionIO } from "../src/extensions.js";
import { extensionsSchema, mcpServerSchema } from "../src/extension-config.js";
import { McpConnection, transportBridge } from "../src/mcp.js";
import { BoundedStdioTransport } from "../src/extension-process.js";
import { fixture, server } from "./helpers.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const io = (): ExtensionIO => ({
  permissions: { write: false, commands: false, external: true },
  signal: AbortSignal.timeout(5000), write() {}, confirm: async () => true,
});

test("cancelling a host invalidates an outstanding trust approval", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ hooks: { local: {
    event: "before", executable: process.execPath, args: ["-e", "process.exit(0)"],
  } } });
  const host = new ExtensionHost(project);
  const prompted = deferred();
  const approval = deferred();
  let approvalSignal: AbortSignal | undefined;
  t.after(async () => { approval.resolve(); await host.close(); });
  const pending = host.enableHook("local", { ...io(), confirm: async (_prompt, signal) => {
    approvalSignal = signal;
    prompted.resolve(); await approval.promise; return true;
  } });
  const rejected = assert.rejects(pending, /closed|cancelled|abort/i);
  await prompted.promise;
  await host.cancel();
  assert.equal(approvalSignal?.aborted, true);
  assert.equal(host.status().hooks[0]!.enabled, false);
  await host.enableHook("local", io());
  approval.resolve();
  await rejected;
  assert.equal(host.status().hooks[0]!.enabled, true);
});

test("concurrent host cancellation joins a disconnect and blocks fresh starts until cleanup finishes", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  } } });
  const host = new ExtensionHost(project);
  const entered = deferred();
  const release = deferred();
  t.after(async () => { release.resolve(); await host.close(); });
  await host.connect("local", io());
  const original = McpConnection.prototype.close;
  t.mock.method(McpConnection.prototype, "close", async function (this: McpConnection) {
    entered.resolve(); await release.promise; return original.call(this);
  });
  const disconnect = host.disconnect("local");
  await entered.promise;
  let cancelled = false;
  const cancel = host.cancel().then(() => { cancelled = true; });
  let cancelledAgain = false;
  const cancelAgain = host.cancel().then(() => { cancelledAgain = true; });
  try {
    await setImmediate();
    assert.equal(cancelled, false, "Cancellation must join teardown, not just clear the catalog");
    assert.equal(cancelledAgain, false);
    await assert.rejects(host.connect("local", io()), /cleanup is in progress/);
    assert.deepEqual(host.tools(io()), []);
  } finally {
    release.resolve();
    await Promise.all([disconnect, cancel, cancelAgain]);
  }
  assert.equal(host.status().mcp[0]!.connected, false);
  await host.connect("local", io());
  assert.equal(host.status().mcp[0]!.connected, true);
});

test("cancelling during MCP startup joins the process and prevents late publication", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], timeoutMs: 2000,
  } } });
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  const started = deferred();
  let closed = false;
  const start = BoundedStdioTransport.prototype.start;
  t.mock.method(BoundedStdioTransport.prototype, "start", async function (this: BoundedStdioTransport) {
    const onclose = this.onclose;
    this.onclose = () => { closed = true; onclose?.(); };
    await start.call(this);
    started.resolve();
  });
  const pending = assert.rejects(host.connect("local", io()), /failed|closed|abort/i);
  await started.promise;
  await host.cancel();
  assert.equal(closed, true);
  await pending;
  assert.equal(host.status().mcp[0]!.connected, false);
  assert.deepEqual(host.tools(io()), []);
});

test("cancellation immediately revokes already prepared MCP actions", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  } } });
  const host = new ExtensionHost(project);
  t.after(() => host.close());
  for (const cancel of [() => host.cancel(), () => host.disconnect("local")]) {
    await host.connect("local", io());
    const action = await host.tools(io())[0]!.prepare({ mode: "echo" });
    const closing = cancel();
    const execution = action.execute(io().signal);
    await assert.rejects(execution, /no longer connected/);
    await closing;
  }
});

test("a stale MCP approval cannot replace a freshly trusted connection", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  } } });
  const host = new ExtensionHost(project);
  const prompted = deferred();
  const approval = deferred();
  t.after(async () => { approval.resolve(); await host.close(); });
  const pending = assert.rejects(host.connect("local", { ...io(), confirm: async () => {
    prompted.resolve(); await approval.promise; return true;
  } }), /closed|cancelled|abort/i);
  await prompted.promise;
  await assert.rejects(host.connect("local", io()), /already connecting/);
  await host.cancel();
  await host.connect("local", io());
  approval.resolve();
  await pending;
  assert.equal(host.status().mcp[0]!.connected, true);
  assert.equal(host.tools(io()).length, 1);
});

test("permanent close invalidates outstanding plugin approval and cannot be reopened", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const directory = path.join(project.workspace.root, ".jev/plugins/local");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "jev-plugin.json"), JSON.stringify({ version: 1, id: "local", description: "Local test" }));
  project.config.extensions = extensionsSchema.parse({ plugins: { local: ".jev/plugins/local" } });
  const host = new ExtensionHost(project);
  const prompted = deferred();
  const approval = deferred();
  t.after(async () => { approval.resolve(); await host.close(); });
  const pending = assert.rejects(host.enablePlugin("local", { ...io(), confirm: async () => {
    prompted.resolve(); await approval.promise; return true;
  } }), /closed/);
  await prompted.promise;
  await Promise.all([host.close(), host.close()]);
  approval.resolve();
  await pending;
  await host.cancel();
  await assert.rejects(host.enablePlugin("local", io()), /closed/);
  await assert.rejects(host.enableHook("local", io()), /closed/);
  await assert.rejects(host.connect("local", io()), /closed/);
  assert.equal(host.status().plugins[0]!.enabled, false);
});

test("host cleanup failures remain owned and cannot be cleared by cancelling again", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  project.config.extensions = extensionsSchema.parse({ mcp: { local: {
    transport: "stdio", executable: process.execPath,
    args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  } } });
  const host = new ExtensionHost(project);
  const original = McpConnection.prototype.close;
  const failure = new Error("Simulated cleanup failure after local teardown");
  let closes = 0;
  t.mock.method(McpConnection.prototype, "close", async function (this: McpConnection) {
    closes++;
    await original.call(this);
    throw failure;
  });
  t.after(async () => { await assert.rejects(host.close(), { cause: failure }); });
  await host.connect("local", io());
  await assert.rejects(host.disconnect("local"), failure);
  await assert.rejects(host.cancel(), { cause: failure });
  await assert.rejects(host.cancel(), { cause: failure });
  await assert.rejects(host.connect("local", io()), /closed|cancelled|abort/i);
  assert.equal(closes, 1);
  assert.deepEqual(host.tools(io()), []);
});

test("concurrent MCP close calls terminate a stateful HTTP session only once", { timeout: 5000 }, async (t) => {
  const instance = new Server({ name: "cleanup-test", version: "1" }, { capabilities: { tools: {} } });
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "cleanup-session", enableJsonResponse: true });
  await instance.connect(transportBridge(transport));
  t.after(() => instance.close());
  let deletes = 0;
  const endpoint = await server(t, (request, response) => {
    if (request.method === "DELETE") deletes++;
    void transport.handleRequest(request, response);
  });
  const connection = new McpConnection("http", mcpServerSchema.parse({ transport: "http", url: endpoint, timeoutMs: 1000 }), ".", {});
  t.after(() => connection.close());
  await connection.connect(io().signal);
  const results = await Promise.allSettled([connection.close(), connection.close()]);
  assert.ok(results.every((result) => result.status === "fulfilled"), JSON.stringify(results));
  await connection.close();
  assert.equal(deletes, 1);
});

test("failed HTTP termination still closes the local transport and is not silently retried", { timeout: 5000 }, async (t) => {
  const instance = new Server({ name: "cleanup-test", version: "1" }, { capabilities: { tools: {} } });
  instance.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "failed-cleanup-session", enableJsonResponse: true });
  await instance.connect(transportBridge(transport));
  t.after(() => instance.close());
  let deletes = 0;
  let localCloses = 0;
  const close = StreamableHTTPClientTransport.prototype.close;
  t.mock.method(StreamableHTTPClientTransport.prototype, "close", async function (this: StreamableHTTPClientTransport) {
    localCloses++;
    await close.call(this);
  });
  const endpoint = await server(t, (request, response) => {
    if (request.method === "DELETE") { deletes++; response.writeHead(500); response.end(); }
    else void transport.handleRequest(request, response);
  });
  const connection = new McpConnection("http", mcpServerSchema.parse({ transport: "http", url: endpoint, timeoutMs: 1000 }), ".", {});
  t.after(async () => { await assert.rejects(connection.close(), /cleanup failed/); });
  await connection.connect(io().signal);
  const pending = connection.close();
  assert.equal(connection.close(), pending);
  await assert.rejects(pending, /cleanup failed/);
  await assert.rejects(connection.close(), /cleanup failed/);
  assert.equal(deletes, 1);
  assert.equal(localCloses, 1);
  assert.equal(connection.status().connected, false);
});

test("transport cleanup still runs when SDK client cleanup fails", { timeout: 5000 }, async (t) => {
  const connection = new McpConnection("local", mcpServerSchema.parse({
    transport: "stdio", executable: process.execPath, args: [path.resolve("test/fixtures/mcp-server.mjs")], timeoutMs: 2000,
  }), process.cwd(), {});
  let closed = false;
  const close = BoundedStdioTransport.prototype.close;
  t.mock.method(BoundedStdioTransport.prototype, "close", async function (this: BoundedStdioTransport) {
    await close.call(this);
    closed = true;
  });
  t.mock.method(Client.prototype, "close", async () => { throw new Error("SDK cleanup failed"); });
  t.after(async () => { await assert.rejects(connection.close(), /cleanup failed/); });
  await connection.connect(io().signal);
  await assert.rejects(connection.close(), /cleanup failed/);
  assert.equal(closed, true);
  assert.equal(connection.status().connected, false);
});

test("stdio close joins process exit after escalating a TERM-ignoring child", {
  skip: process.platform === "win32", timeout: 5000,
}, async (t) => {
  const ready = deferred();
  let pid = 0;
  let closed = false;
  const transport = new BoundedStdioTransport({
    executable: process.execPath, env: {}, timeoutMs: 2000, args: ["-e", `
      process.on('SIGTERM', () => {});
      console.log(JSON.stringify({jsonrpc:'2.0',method:'ready',params:{pid:process.pid}}));
      setInterval(() => {}, 1000);
    `],
  }, process.cwd(), {});
  transport.onmessage = (message) => {
    if ("method" in message && message.method === "ready" && typeof message.params?.pid === "number") {
      pid = message.params.pid; ready.resolve();
    }
  };
  transport.onclose = () => { closed = true; };
  t.after(() => transport.close());
  await transport.start();
  await ready.promise;
  await Promise.all([transport.close(), transport.close()]);
  assert.equal(closed, true, "Close must await the child close event after SIGKILL");
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("stdio cleanup handles spawn failure and close before start", { timeout: 5000 }, async (t) => {
  const project = await fixture(t);
  const command = { executable: path.join(project.workspace.root, "missing-executable"), args: [], env: {}, timeoutMs: 1000 };
  const failed = new BoundedStdioTransport(command, project.workspace.root, {});
  t.after(() => failed.close());
  await assert.rejects(failed.start(), /failed to start/);
  await Promise.all([failed.close(), failed.close()]);
  const unopened = new BoundedStdioTransport(command, project.workspace.root, {});
  await unopened.close();
  await assert.rejects(unopened.start(), /already started or closed/);
});

test("stdio cleanup does not signal an already cleaned process group again", {
  skip: process.platform === "win32", timeout: 5000,
}, async (t) => {
  const closed = deferred();
  const transport = new BoundedStdioTransport({
    executable: process.execPath, env: {}, timeoutMs: 1000, args: ["-e", "process.exit(0)"],
  }, process.cwd(), {});
  transport.onclose = closed.resolve;
  t.after(() => transport.close());
  await transport.start();
  await closed.promise;
  const kill = t.mock.method(process, "kill");
  await transport.close();
  await transport.close();
  assert.equal(kill.mock.callCount(), 0);
});
