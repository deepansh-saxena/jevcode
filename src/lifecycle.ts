import type { Config } from "./config.js";
import type { Emit } from "./events.js";
import { BlockedError } from "./errors.js";
import { CheckpointStore } from "./checkpoints.js";
import { executeProcess, type ExecutionRequest, type ExecutionResult } from "./execution.js";
import { TaskRegistry, type TaskView } from "./tasks.js";
import type { Permissions } from "./tools.js";
import type { Workspace } from "./workspace.js";

const activeSessions = new Set<ExecutionSession>();
const terminationHandlers = new Map<NodeJS.Signals, () => void>();

function registerSession(session: ExecutionSession): () => void {
  activeSessions.add(session);
  for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    if (terminationHandlers.has(signal) || process.listenerCount(signal)) continue;
    const handler = (): void => {
      void Promise.all([...activeSessions].map((active) => active.close())).then(
        () => process.exit(exitCode),
        (error: unknown) => { process.stderr.write(`Execution cleanup failed: ${String(error)}\n`); process.exit(exitCode); },
      );
    };
    terminationHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    activeSessions.delete(session);
    if (activeSessions.size) return;
    for (const [signal, handler] of terminationHandlers) process.removeListener(signal, handler);
    terminationHandlers.clear();
  };
}

export class ExecutionSession {
  readonly tasks: TaskRegistry;
  readonly checkpoints: CheckpointStore;
  readonly #controller = new AbortController();
  #closed = false;
  #closing: Promise<void> | undefined;
  #disposeExit: () => void;

  constructor(readonly workspace: Workspace, readonly config: Config) {
    this.tasks = new TaskRegistry(config.execution.maxTasks);
    this.checkpoints = new CheckpointStore(workspace);
    this.#disposeExit = registerSession(this);
  }

  get signal(): AbortSignal { return this.#controller.signal; }

  launch(request: ExecutionRequest, parent: AbortSignal, emit: Emit = () => {},
    policy = this.config.execution): TaskView {
    if (this.#closed) throw new BlockedError("Execution session is closed");
    const execution = structuredClone(policy);
    const exactRequest = structuredClone(request);
    const task = this.tasks.start("shell", request.shell ?? request.executable ?? "", AbortSignal.any([parent, this.signal]),
      async (signal, id) => {
        const result = await executeProcess(this.workspace, execution, exactRequest, signal, (stream, text, current) => {
          this.tasks.update(id, current);
          emit("shell_output", { taskId: id, stream, text });
        });
        emit("task_completed", { taskId: id, ok: result.ok, exitCode: result.exitCode });
        return result;
      }, execution.maxJobs);
    emit("task_started", { taskId: task.id, kind: task.kind });
    return task;
  }

  async execute(request: ExecutionRequest, signal: AbortSignal, emit?: Emit,
    policy = this.config.execution): Promise<TaskView | ExecutionResult> {
    const task = this.launch(request, signal, emit, policy);
    if (request.background) return task;
    const done = await this.tasks.wait(task.id);
    if (done.result === undefined) throw new Error(done.error ?? "Task returned no execution result");
    return done.result as ExecutionResult;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#controller.abort(new Error("Execution session closed"));
    this.#closing = this.tasks.close().finally(() => {
      this.checkpoints.close(); this.#disposeExit();
    });
    return this.#closing;
  }
}

export async function handleExecutionCommand(line: string, session: ExecutionSession,
  state: { permissions: Permissions; planMode?: boolean },
  io: { write: (text: string) => void; confirm: (text: string, signal?: AbortSignal) => Promise<boolean>; signal: AbortSignal }): Promise<boolean> {
  const [command, id, ...extra] = line.trim().split(/\s+/);
  if (!["/tasks", "/task", "/stop", "/checkpoints", "/undo"].includes(command ?? "")) return false;
  if (extra.length || (["/task", "/stop", "/undo"].includes(command!) ? !id : id !== undefined)) {
    throw new Error(`Usage: ${command}${["/task", "/stop", "/undo"].includes(command!) ? " <id>" : ""}`);
  }
  if (command === "/undo") {
    if (!state.permissions.write || state.planMode) throw new BlockedError("Undo requires write permission and is unavailable in plan mode");
    const action = await session.checkpoints.prepareUndo(id!);
    if (!await io.confirm(`Approve this exact undo?\n${JSON.stringify(action.details, null, 2)}\n`, io.signal)) throw new BlockedError("Undo was not approved");
    io.signal.throwIfAborted();
    io.write(`${JSON.stringify(await action.execute(io.signal), null, 2)}\n`);
  } else {
    const result = command === "/tasks" ? session.tasks.list() : command === "/task" ? session.tasks.read(id!) :
      command === "/stop" ? await session.tasks.stop(id!) : session.checkpoints.list();
    io.write(`${JSON.stringify(result, null, 2)}\n`);
  }
  return true;
}
