import { randomUUID } from "node:crypto";
import { BlockedError } from "./errors.js";
import type { PreparedAction } from "./tools.js";
import { checkVersion, digest, writeVersion, type Workspace } from "./workspace.js";

export interface CheckpointView {
  id: string;
  path: string;
  beforeHash: string | null;
  afterHash: string;
  createdAt: string;
  undone: boolean;
}
interface Checkpoint {
  view: CheckpointView;
  preimage: string | null;
}

export class CheckpointStore {
  #entries = new Map<string, Checkpoint>();
  #bytes = 0;
  #busy = false;
  #closed = false;
  constructor(private workspace: Workspace, private maxEntries = 100, private maxBytes = 8_000_000) {}

  list(): CheckpointView[] { return [...this.#entries.values()].map(({ view }) => ({ ...view })); }

  async edit(relative: string, content: string, expected: string | null, signal: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new BlockedError("Checkpoint session is closed");
    if (this.#busy) throw new BlockedError("Another harness edit is in progress");
    this.#busy = true;
    try {
      await checkVersion(this.workspace, relative, expected);
      const preimage = expected === null ? null : await this.workspace.read(relative);
      if (preimage !== null && digest(preimage) !== expected) throw new Error("File changed before checkpoint");
      const bytes = Buffer.byteLength(preimage ?? "");
      if (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
        throw new BlockedError("Private checkpoint storage limit reached; start a new session before further edits");
      }
      const result = await writeVersion(this.workspace, relative, content, expected, signal);
      const view: CheckpointView = { id: randomUUID(), path: relative, beforeHash: expected,
        afterHash: digest(content), createdAt: new Date().toISOString(), undone: false };
      this.#entries.set(view.id, { view, preimage });
      this.#bytes += bytes;
      return { ...result, checkpointId: view.id };
    } finally { this.#busy = false; }
  }

  async prepareUndo(id: string): Promise<PreparedAction> {
    if (this.#closed) throw new BlockedError("Checkpoint session is closed");
    const checkpoint = this.#entries.get(id);
    if (!checkpoint) throw new Error(`Unknown checkpoint: ${id}`);
    if (checkpoint.view.undone) throw new Error("Checkpoint has already been undone");
    const { view, preimage } = checkpoint;
    await checkVersion(this.workspace, view.path, view.afterHash);
    return { name: "undo_edit", mutating: true, details: {
      checkpointId: id, path: view.path, expectedHash: view.afterHash, restoredHash: view.beforeHash,
      operation: preimage === null ? "delete harness-created file" : "restore harness preimage",
      warning: "Only this harness file edit is captured. Shell/external changes are not checkpointed.",
    }, execute: async (signal) => {
      if (this.#closed || view.undone) throw new BlockedError("Checkpoint is no longer available");
      if (this.#busy) throw new BlockedError("Another harness edit is in progress");
      this.#busy = true;
      try {
        const result = await writeVersion(this.workspace, view.path, preimage, view.afterHash, signal);
        view.undone = true;
        return { ...result, checkpointId: id, undone: true };
      } finally { this.#busy = false; }
    } };
  }

  close(): void { this.#closed = true; this.#entries.clear(); this.#bytes = 0; }
}
