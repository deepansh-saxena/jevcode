import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { serve } from "../src/stdio.js";
import { fixture, scripted, call, final } from "./helpers.js";
import type { CodingModel } from "../src/llm.js";

interface Packet {
  type: string; event?: string; id?: string; runId?: string; error?: string;
  data?: { requestId: string; details?: unknown; text?: string };
  result?: { kind?: string; result?: { status: string }; accepted?: boolean; permissions?: { write: boolean } };
}

async function protocol(t: TestContext, model: CodingModel, write = false) {
  const project = await fixture(t);
  const input = new PassThrough();
  const output = new PassThrough();
  const packets: Packet[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      packets.push(JSON.parse(buffer.slice(0, index)) as Packet);
      buffer = buffer.slice(index + 1);
    }
  });
  const running = serve(project, { permissions: { write, commands: false } }, { input, output, model });
  t.after(async () => { input.end(); await running; });
  const next = async (predicate: (packet: Packet) => boolean): Promise<Packet> => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = packets.findIndex(predicate);
      if (index >= 0) return packets.splice(index, 1)[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Protocol response timed out; packet types: ${packets.map((p) => p.event ?? p.type).join(",")}`);
  };
  await next((packet) => packet.type === "ready");
  return { project, input, next, send: (message: unknown) => input.write(`${JSON.stringify(message)}\n`) };
}

test("stdio requires exact pending approval and rejects forged, wrong-run and replayed decisions", async (t) => {
  const p = await protocol(t, scripted([call("write_file", { path: "approved.txt", content: "approved", expectedHash: null }), final()]), true);
  p.send({ id: "forged", method: "approve", params: { runId: "turn", requestId: randomUUID(), approved: true } });
  assert.match((await p.next((p) => p.id === "forged")).error!, /No matching/);
  p.send({ id: "turn", method: "prompt", params: { text: "Write a file" } });
  const approval = await p.next((p) => p.event === "approval_request");
  const requestId = approval.data!.requestId;
  assert.match(JSON.stringify(approval.data), /approved.txt/);
  p.send({ id: "wrong", method: "approve", params: { runId: "wrong-run", requestId, approved: true } });
  assert.match((await p.next((p) => p.id === "wrong")).error!, /No matching/);
  await assert.rejects(p.project.workspace.read("approved.txt"), /ENOENT/);
  p.send({ id: "correct", method: "approve", params: { runId: "turn", requestId, approved: true } });
  assert.equal((await p.next((p) => p.id === "correct")).result!.accepted, true);
  assert.equal((await p.next((p) => p.id === "turn")).result!.result!.status, "completed");
  assert.equal(await p.project.workspace.read("approved.txt"), "approved");
  p.send({ id: "replay", method: "approve", params: { runId: "turn", requestId, approved: true } });
  assert.match((await p.next((p) => p.id === "replay")).error!, /No matching/);
});

test("stdio cancellation closes pending consent and never executes a denied action", async (t) => {
  const p = await protocol(t, scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]), true);
  p.send({ id: "run", method: "prompt", params: { text: "Write" } });
  const approval = await p.next((p) => p.event === "approval_request");
  p.send({ id: "cancel", method: "cancel", params: { runId: "run" } });
  p.send({ id: "late", method: "approve", params: { runId: "run", requestId: approval.data!.requestId, approved: true } });
  assert.match((await p.next((p) => p.id === "late")).error!, /No matching/);
  assert.equal((await p.next((p) => p.id === "run")).result!.result!.status, "cancelled");
  await assert.rejects(p.project.workspace.read("no.txt"), /ENOENT/);
});

test("stdio rejects queued prompts during permissions consent and preserves denial", async (t) => {
  const p = await protocol(t, scripted([]));
  p.send({ id: "permissions", method: "prompt", params: { text: "/permissions all" } });
  const approval = await p.next((p) => p.event === "approval_request");
  p.send({ id: "queued", method: "prompt", params: { text: "yes" } });
  assert.match((await p.next((p) => p.id === "queued")).error!, /Busy/);
  p.send({ id: "deny", method: "approve", params: { runId: "permissions", requestId: approval.data!.requestId, approved: false } });
  await p.next((p) => p.id === "permissions");
  p.send({ id: "status", method: "status" });
  assert.equal((await p.next((p) => p.id === "status")).result!.permissions!.write, false);
});

test("stdio clarification uses separate correlation and never accepts approval as an answer", async (t) => {
  const model = scripted([call("ask_user", { question: "Which color?", choices: ["blue", "green"] }), final("Blue")],
    (messages, _tools, index) => { if (index === 1) assert.match(messages.at(-1)!.content!, /blue/); });
  const p = await protocol(t, model);
  p.send({ id: "question", method: "prompt", params: { text: "Pick a color" } });
  const question = await p.next((p) => p.event === "question");
  p.send({ id: "bad-kind", method: "approve", params: { runId: "question", requestId: question.data!.requestId, approved: true } });
  assert.match((await p.next((p) => p.id === "bad-kind")).error!, /No matching/);
  p.send({ id: "answer", method: "answer", params: { runId: "question", requestId: question.data!.requestId, answer: "blue" } });
  assert.equal((await p.next((p) => p.id === "question")).result!.result!.status, "completed");
});

test("stdio invalid, oversized and duplicate requests are bounded and recoverable", async (t) => {
  const p = await protocol(t, scripted([]));
  p.input.write("not-json\n");
  assert.match((await p.next((p) => p.id === null)).error!, /Invalid JSON/);
  p.input.write("x".repeat(70_000) + "\n");
  assert.match((await p.next((p) => p.id === null)).error!, /65536/);
  p.send({ id: "schema", method: "approve", params: { approved: "yes" } });
  assert.match((await p.next((p) => p.id === null)).error!, /Invalid protocol/);
  p.send({ id: "status", method: "status" });
  assert.ok((await p.next((p) => p.id === "status")).result);
  p.send({ id: "status", method: "status" });
  assert.match((await p.next((p) => p.id === "status")).error!, /Duplicate/);
});

test("stdio cancellation aborts an in-flight provider request and accepts a fresh turn", async (t) => {
  let calls = 0;
  const p = await protocol(t, { async complete(_messages, _tools, _model, signal) {
    if (calls++ === 0) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return final();
  } });
  p.send({ id: "slow", method: "prompt", params: { text: "Wait" } });
  await p.next((p) => p.event === "llm_request");
  p.send({ id: "cancel", method: "cancel", params: { runId: "slow" } });
  assert.equal((await p.next((p) => p.id === "slow")).result!.result!.status, "cancelled");
  p.send({ id: "next", method: "prompt", params: { text: "Continue" } });
  assert.equal((await p.next((p) => p.id === "next")).result!.result!.status, "completed");
});

test("stdio EOF denies pending actions and /exit closes cleanly", async (t) => {
  const p = await protocol(t, scripted([call("write_file", { path: "no.txt", content: "no", expectedHash: null })]), true);
  p.send({ id: "run", method: "prompt", params: { text: "Write" } });
  await p.next((p) => p.event === "approval_request");
  p.input.end();
  assert.equal((await p.next((p) => p.id === "run")).result!.result!.status, "cancelled");
  await assert.rejects(p.project.workspace.read("no.txt"), /ENOENT/);
  const other = await protocol(t, scripted([]));
  other.send({ id: "exit", method: "prompt", params: { text: "/exit" } });
  assert.equal((await other.next((p) => p.id === "exit")).result!.kind, "exit");
  assert.equal(other.input.destroyed, true);
});
