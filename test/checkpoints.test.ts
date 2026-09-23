import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture, call, final, options, scripted } from "./helpers.js";
import { CheckpointStore } from "../src/checkpoints.js";
import { ExecutionSession, handleExecutionCommand } from "../src/lifecycle.js";
import { digest, readText } from "../src/workspace.js";
import { run } from "../src/runtime.js";

const signal = (): AbortSignal => new AbortController().signal;

test("private checkpoints record only harness edits and restore the exact preimage after approval", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  await writeFile(path.join(project.workspace.root, "file"), "private before");
  const result = await run(project, options(scripted([call("replace_text", {
    path: "file", oldText: "private before", newText: "after", expectedHash: digest("private before"),
  }), final()]), { session, permissions: { write: true, commands: false }, approve: async () => true }));
  assert.equal(result.status, "completed", result.text);
  const [checkpoint] = session.checkpoints.list();
  assert.ok(checkpoint);
  assert.ok(!JSON.stringify(session.checkpoints).includes("private before"));
  assert.ok(!JSON.stringify(session.checkpoints.list()).includes("private before"));
  assert.equal(checkpoint.beforeHash, digest("private before"));
  assert.equal(checkpoint.afterHash, digest("after"));
  assert.ok(!(await readdir(project.workspace.root)).some((file) => file.startsWith(".jev-write-")));
  let approved = false;
  const handled = await handleExecutionCommand(`/undo ${checkpoint.id}`, session, { permissions: { write: true, commands: false } }, {
    signal: signal(), write: () => {}, confirm: async (text) => { assert.match(text, /Only this harness file edit/); approved = true; return true; },
  });
  assert.equal(handled, true);
  assert.equal(approved, true);
  assert.equal(await project.workspace.read("file"), "private before");
  assert.equal(session.checkpoints.list()[0]!.undone, true);
  await assert.rejects(session.checkpoints.prepareUndo(checkpoint.id), /already been undone/);
  await writeFile(path.join(project.workspace.root, "external"), "not checkpointed");
  assert.equal(session.checkpoints.list().length, 1);
});

test("undoing a newly created file deletes only that version, not the parent directory", async (t) => {
  const project = await fixture(t);
  const store = new CheckpointStore(project.workspace);
  await store.edit("nested/file", "harness", null, signal());
  const checkpoint = store.list()[0]!;
  await (await store.prepareUndo(checkpoint.id)).execute(signal());
  await assert.rejects(project.workspace.read("nested/file"), /ENOENT/);
  assert.ok((await stat(path.join(project.workspace.root, "nested"))).isDirectory());
});

test("undo refuses external modifications before or after preparation, including new-file replacement", async (t) => {
  for (const existing of [false, true]) {
    const project = await fixture(t);
    const store = new CheckpointStore(project.workspace);
    const file = path.join(project.workspace.root, "file");
    if (existing) await writeFile(file, "before");
    await store.edit("file", "agent", existing ? digest("before") : null, signal());
    const checkpoint = store.list()[0]!;
    const prepared = await store.prepareUndo(checkpoint.id);
    await writeFile(file, "user");
    await assert.rejects(prepared.execute(signal()), /changed/);
    await assert.rejects(store.prepareUndo(checkpoint.id), /changed/);
    assert.equal(await readFile(file, "utf8"), "user");
    assert.equal(store.list()[0]!.undone, false);
  }
});

test("undo cannot follow a replaced symlink or modify protected paths", async (t) => {
  const project = await fixture(t);
  const store = new CheckpointStore(project.workspace);
  await store.edit("file", "agent", null, signal());
  const prepared = await store.prepareUndo(store.list()[0]!.id);
  await writeFile(path.join(project.workspace.root, "other"), "user");
  await unlink(path.join(project.workspace.root, "file"));
  await symlink("other", path.join(project.workspace.root, "file"));
  await assert.rejects(prepared.execute(signal()), /Symbolic/);
  assert.equal(await project.workspace.read("other"), "user");
  await assert.rejects(store.edit("AGENTS.md", "bad", null, signal()), /protected/);
  await assert.rejects(store.edit(".env", "bad", null, signal()), /protected/);
});

test("undo remains denied without fresh approval, write permission, or outside plan mode", async (t) => {
  const project = await fixture(t);
  const session = new ExecutionSession(project.workspace, project.config);
  t.after(() => session.close());
  await session.checkpoints.edit("file", "agent", null, signal());
  const id = session.checkpoints.list()[0]!.id;
  for (const state of [{ permissions: { write: false, commands: false } }, { permissions: { write: true, commands: false }, planMode: true }]) {
    await assert.rejects(handleExecutionCommand(`/undo ${id}`, session, state, {
      signal: signal(), write: () => {}, confirm: async () => assert.fail("Must not ask approval when unavailable"),
    }), /requires write/);
  }
  await assert.rejects(handleExecutionCommand(`/undo ${id}`, session, { permissions: { write: true, commands: false } }, {
    signal: signal(), write: () => {}, confirm: async () => false,
  }), /not approved/);
  const denied = await run(project, options(scripted([call("undo_edit", { checkpointId: id })]), {
    session, permissions: { write: true, commands: false }, approve: async () => false,
  }));
  assert.equal(denied.status, "blocked");
  assert.equal(await project.workspace.read("file"), "agent");
});

test("cancellation and checkpoint storage limits fail before modification", async (t) => {
  const project = await fixture(t);
  const store = new CheckpointStore(project.workspace, 1, 5);
  await writeFile(path.join(project.workspace.root, "large"), "too big");
  await assert.rejects(store.edit("large", "changed", digest("too big"), signal()), /storage limit/);
  assert.equal(await project.workspace.read("large"), "too big");
  await store.edit("file", "one", null, signal());
  const undo = await store.prepareUndo(store.list()[0]!.id);
  await assert.rejects(undo.execute(AbortSignal.abort(new Error("cancel"))), /cancel/);
  assert.equal(await project.workspace.read("file"), "one");
  await assert.rejects(store.edit("next", "two", null, signal()), /storage limit/);
  store.close();
  await assert.rejects(undo.execute(signal()), /no longer available/);
  assert.deepEqual(store.list(), []);
});

test("a file recreated during commit is never overwritten and captured content remains recoverable", async (t) => {
  const project = await fixture(t);
  const store = new CheckpointStore(project.workspace);
  const file = path.join(project.workspace.root, "file");
  await writeFile(file, "before");
  const originalPath = project.workspace.path.bind(project.workspace);
  let raced = false;
  project.workspace.path = async (relative, writing) => {
    const result = await originalPath(relative, writing);
    if (relative === "file" && !raced) {
      try { await stat(file); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        raced = true;
        await writeFile(file, "concurrent user");
      }
    }
    return result;
  };
  await assert.rejects(store.edit("file", "agent", digest("before"), signal()), /no new file was overwritten/);
  assert.equal(raced, true);
  assert.equal(await readFile(file, "utf8"), "concurrent user");
  const recovery = (await readdir(project.workspace.root)).find((name) => name.startsWith(".jev-write-"))!;
  assert.equal((await stat(path.join(project.workspace.root, recovery))).mode & 0o777, 0o700);
  assert.equal(await readText(path.join(project.workspace.root, recovery, "previous")), "before");
  assert.deepEqual(store.list(), []);
});

test("non-UTF8 preimages are rejected instead of silently corrupting undo contents", async (t) => {
  const project = await fixture(t);
  await writeFile(path.join(project.workspace.root, "invalid"), Buffer.from([0xff, 0xfe]));
  await assert.rejects(project.workspace.read("invalid"), /encoded data/);
});

test("UTF-8 byte order marks survive edit and undo exactly", async (t) => {
  const project = await fixture(t);
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
  const file = path.join(project.workspace.root, "bom");
  await writeFile(file, bytes);
  const store = new CheckpointStore(project.workspace);
  await store.edit("bom", "updated", digest(bytes.toString("utf8")), signal());
  await (await store.prepareUndo(store.list()[0]!.id)).execute(signal());
  assert.deepEqual(await readFile(file), bytes);
});
