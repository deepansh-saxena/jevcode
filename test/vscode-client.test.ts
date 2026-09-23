import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
interface Client extends EventEmitter {
  active: string | null;
  closed: boolean;
  request(method: string, params?: unknown): Promise<unknown>;
  cancel(): Promise<unknown>;
  dispose(reason?: string): void;
}
const { StdioClient } = require("../editors/vscode/client.cjs") as { StdioClient: new (child: EventEmitter) => Client };

function fake() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; },
  });
  const sent: { id: string; method: string; params: Record<string, unknown> }[] = [];
  child.stdin.on("data", (line: Buffer) => sent.push(JSON.parse(line.toString())));
  const client = new StdioClient(child);
  return { client, child, sent, send: (message: unknown) => child.stdout.write(`${JSON.stringify(message)}\n`) };
}

test("VS Code transport streams events, never autoapproves, and correlates cancellation", async () => {
  const { client, child, sent, send } = fake();
  const events: unknown[] = [];
  client.on("event", (event) => events.push(event));
  const result = client.request("prompt", { text: "Work" });
  const runId = sent[0]!.id;
  send({ type: "event", event: "approval_request", runId, data: { requestId: "approval-id", details: { prompt: "Do this?" } } });
  assert.equal(events.length, 1);
  assert.equal(sent.length, 1);
  await assert.rejects(client.request("prompt", { text: "yes" }), /turn is active/);
  const cancellation = client.cancel();
  assert.equal(sent[1]!.method, "cancel");
  assert.equal(sent[1]!.params.runId, runId);
  send({ type: "response", id: sent[1]!.id, result: { cancelled: true } });
  await cancellation;
  send({ type: "response", id: runId, result: { kind: "result", result: { status: "cancelled" } } });
  assert.deepEqual(await result, { kind: "result", result: { status: "cancelled" } });
  assert.equal(client.active, null);
  client.dispose();
  assert.equal(child.killed, true);
});

test("VS Code transport rejects oversized input and malformed output, closing pending work", async () => {
  const { client, child } = fake();
  await assert.rejects(client.request("prompt", { text: "x".repeat(70_000) }), /limit/);
  const pending = client.request("prompt", { text: "Work" });
  child.stdout.write("invalid JSON\n");
  await assert.rejects(pending, /Invalid server protocol/);
  assert.equal(client.closed, true);
  assert.equal(child.killed, true);
});
