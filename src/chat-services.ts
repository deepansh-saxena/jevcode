import type { ChatServices } from "./chat-controller.js";
import type { ChatState } from "./chat-commands.js";
import { ExtensionHost } from "./extensions.js";
import { ExecutionSession, handleExecutionCommand } from "./lifecycle.js";

export function createChatServices(state: ChatState): ChatServices {
  const session = new ExecutionSession(state.project.workspace, state.project.config);
  const extensions = state.extensions ?? new ExtensionHost(state.project);
  state.extensions = extensions;
  const stopShells = async (): Promise<void> => {
    await Promise.all(session.tasks.list().filter((task) => task.kind === "shell" && task.status === "running")
      .map((task) => session.tasks.stop(task.id)));
  };
  return {
    runOptions: { session, extensions },
    async command(line, current, io) {
      if (await handleExecutionCommand(line, session, {
        permissions: current.settings.permissions, planMode: current.planMode,
      }, io)) return { kind: "handled" };
      return undefined;
    },
    async refresh() {
      if (state.planMode || !state.settings.permissions.execution) await stopShells();
      if (state.planMode || !state.settings.permissions.external) await extensions.cancel();
    },
    async readOnly() {
      await stopShells();
      await extensions.cancel();
    },
    async close() {
      const results = await Promise.allSettled([session.close(), extensions.close()]);
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Session resource cleanup failed");
    },
  };
}
