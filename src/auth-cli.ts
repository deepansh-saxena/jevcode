import { defaultAuthManager } from "./auth-driver.js";
import { loginAlias, type AccountProvider } from "./auth.js";
import { loadProject, selectAccountProvider } from "./registry.js";
import { accountModel, defaultAccountModels } from "./subscription-model.js";
import { loginPrompt, terminalSafe } from "./terminal.js";

export async function loginAccount(root: string, provider: AccountProvider, requestedModel?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Run login in an interactive terminal; do not paste credentials into chat");
  const project = await loadProject(root);
  const model = requestedModel ?? (project.config.llm.provider === provider ? project.config.llm.model : defaultAccountModels[provider]);
  accountModel(provider, model);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]);
  const abort = (): void => controller.abort(new Error("Login cancelled"));
  process.on("SIGINT", abort);
  try {
    if (provider === "github-copilot") {
      const answer = await loginPrompt(
        "Pi's Copilot login requests enabling its supported models, including third-party models, on your account. Continue? [yes/no]",
        false, signal,
      );
      if (answer.trim().toLowerCase() !== "yes") throw new Error("Copilot login cancelled; no account changes were requested");
    }
    await defaultAuthManager().login(provider, {
      onAuth(info) {
        const instructions = provider === "openai-codex" ?
          "Complete sign-in in your browser. The callback or hidden paste completes this login." : info.instructions ?? "";
        process.stderr.write(terminalSafe(`\nOpen in your browser:\n${info.url}\n${instructions}\n`));
      },
      onPrompt: (prompt, promptSignal) => loginPrompt(prompt.message, prompt.hidden, AbortSignal.any([signal, promptSignal])),
      onProgress: (message) => process.stderr.write(terminalSafe(`${message}\n`)),
    }, signal);
    await selectAccountProvider(project, provider, model);
    process.stdout.write(`Logged in to ${loginAlias(provider)}. This workspace now uses ${model}.\n`);
  } finally {
    process.removeListener("SIGINT", abort);
  }
}
