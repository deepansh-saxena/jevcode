import { randomUUID } from "node:crypto";
import { BlockedError, errorMessage } from "./errors.js";

export type TaskStatus = "running" | "completed" | "failed" | "cancelled";
export interface TaskView {
  id: string;
  kind: "shell" | "specialist";
  label: string;
  status: TaskStatus;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}
interface TaskEntry {
  view: TaskView;
  controller: AbortController;
  done: Promise<TaskView>;
}

export class TaskRegistry {
  #entries = new Map<string, TaskEntry>();
  #closed = false;

  constructor(private maxTasks = 100) {}

  start(kind: TaskView["kind"], label: string, parent: AbortSignal,
    work: (signal: AbortSignal, id: string) => Promise<unknown>, maxConcurrent: number): TaskView {
    parent.throwIfAborted();
    if (this.#closed) throw new BlockedError("Execution session is closed");
    if (this.#entries.size >= this.maxTasks) throw new BlockedError("Session task history limit reached; start a new session");
    if (this.list().filter((task) => task.kind === kind && task.status === "running").length >= maxConcurrent) {
      throw new BlockedError(`Concurrent ${kind} task limit reached`);
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, parent]);
    const view: TaskView = { id: randomUUID(), kind, label, status: "running", startedAt: new Date().toISOString() };
    const entry: TaskEntry = { view, controller, done: Promise.resolve(view) };
    this.#entries.set(view.id, entry);
    entry.done = Promise.resolve().then(() => work(signal, view.id)).then((result) => {
      view.status = signal.aborted ? "cancelled" : "completed";
      view.result = result;
      if (typeof result === "object" && result !== null && "error" in result && typeof result.error === "string") {
        view.error = result.error;
        if (!signal.aborted) view.status = "failed";
      }
    }, (error: unknown) => {
      view.status = signal.aborted ? "cancelled" : "failed";
      view.error = errorMessage(error);
    }).then(() => {
      view.finishedAt = new Date().toISOString();
      return structuredClone(view);
    });
    return structuredClone(view);
  }

  #get(id: string): TaskEntry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Unknown task: ${id}`);
    return entry;
  }

  list(): TaskView[] {
    return [...this.#entries.values()].map(({ view }) => {
      const { result: _result, ...summary } = view;
      return { ...summary };
    });
  }

  read(id: string): TaskView { return structuredClone(this.#get(id).view); }

  update(id: string, result: unknown): void {
    const entry = this.#get(id);
    if (entry.view.status === "running") entry.view.result = structuredClone(result);
  }

  async wait(id: string, signal?: AbortSignal): Promise<TaskView> {
    const entry = this.#get(id);
    if (!signal) return entry.done;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const aborted = (): void => reject(signal.reason);
      signal.addEventListener("abort", aborted, { once: true });
      void entry.done.then(resolve).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
  }

  async stop(id: string): Promise<TaskView> {
    const entry = this.#get(id);
    if (entry.view.status === "running") entry.controller.abort(new Error("Task stopped"));
    return entry.done;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.keys()].map((id) => this.stop(id)));
  }
}
