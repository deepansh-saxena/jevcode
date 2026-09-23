import { appendFileSync, closeSync, openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolvePath } from "./workspace.js";

export type Emit = (event: string, data?: Record<string, unknown>) => void;

export async function createEventLog(root: string, notify: Emit = () => {}): Promise<{
  runId: string; path: string; emit: Emit; close: () => void;
}> {
  const directory = await resolvePath(root, ".jev/runs", true);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await resolvePath(root, ".jev/runs");
  const runId = randomUUID();
  const relative = `.jev/runs/${runId}.jsonl`;
  const fd = openSync(await resolvePath(root, relative, true), "wx", 0o600);
  let closed = false;
  return {
    runId,
    path: relative,
    emit(event, data = {}) {
      // Attached shell jobs may outlive this turn's log; keep their live notifications, not an open log descriptor.
      if (closed && event !== "shell_output" && event !== "task_completed") throw new Error("Run event log is closed");
      const metadata = event === "shell_output" ?
        { taskId: data.taskId, stream: data.stream, bytes: typeof data.text === "string" ? Buffer.byteLength(data.text) : 0 } : data;
      if (!closed) appendFileSync(fd, `${JSON.stringify({ timestamp: new Date().toISOString(), runId, event, ...metadata })}\n`);
      notify(event, data);
    },
    close() { if (!closed) { closed = true; closeSync(fd); } },
  };
}
