import { fork } from "node:child_process";
import { z } from "zod";
import type { OAuthCredentials } from "@earendil-works/pi-ai/oauth";
import { AuthManager, CredentialStore, credentialSchema, type AuthDriver, type LoginCallbacks } from "./auth.js";

const workerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), url: z.string().url(), instructions: z.string().optional() }),
  z.object({ type: z.literal("prompt"), id: z.number().int(), message: z.string(), hidden: z.boolean() }),
  z.object({ type: z.literal("progress"), message: z.string() }),
  z.object({ type: z.literal("result"), credentials: credentialSchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

function exchange(
  request: Record<string, unknown>, callbacks: LoginCallbacks | undefined, signal: AbortSignal,
): Promise<OAuthCredentials> {
  signal.throwIfAborted();
  const worker = new URL(import.meta.url.endsWith(".ts") ? "./oauth-worker.ts" : "./oauth-worker.js", import.meta.url);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "SystemRoot", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const child = fork(worker, [], { env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const prompts = new AbortController();
  return new Promise((resolve, reject) => {
    let result: OAuthCredentials | undefined;
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error): void => {
      failure ??= error;
      prompts.abort(error);
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    const onAbort = (): void => stop(new Error("Authentication cancelled or timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("message", (raw: unknown) => {
      const parsed = workerMessageSchema.safeParse(raw);
      if (!parsed.success) { stop(new Error("Invalid authentication worker response")); return; }
      const message = parsed.data;
      try {
        if (message.type === "result") {
          result = message.credentials;
          prompts.abort();
        } else if (message.type === "error") {
          stop(new Error(message.message));
        } else if (message.type === "auth") {
          const url = new URL(message.url);
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid login URL");
          if (!callbacks) throw new Error("Unexpected interaction during token refresh");
          callbacks.onAuth({ url: message.url, ...(message.instructions ? { instructions: message.instructions } : {}) });
        } else if (message.type === "progress") {
          callbacks?.onProgress(message.message);
        } else {
          if (!callbacks) throw new Error("Unexpected prompt during token refresh");
          void callbacks.onPrompt({ message: message.message, hidden: message.hidden }, prompts.signal).then(
            (answer) => {
              if (!prompts.signal.aborted && child.connected) child.send({ type: "answer", id: message.id, answer });
            },
            () => { if (!result && !prompts.signal.aborted) stop(new Error("Authentication input was cancelled")); },
          );
        }
      } catch {
        stop(new Error("Authentication interaction failed"));
      }
    });
    child.on("error", () => stop(new Error("Could not start authentication worker")));
    child.on("close", (code) => {
      clearTimeout(killTimer);
      prompts.abort();
      signal.removeEventListener("abort", onAbort);
      if (failure) reject(failure);
      else if (code !== 0 || !result) reject(new Error("Authentication worker exited without valid credentials"));
      else resolve(result);
    });
    child.send(request, (error) => { if (error) stop(new Error("Could not contact authentication worker")); });
    if (signal.aborted) onAbort();
  });
}

export const piAuthDriver: AuthDriver = {
  login: (provider, callbacks, signal) => exchange({ operation: "login", provider }, callbacks, signal),
  refresh: (provider, credentials, signal) => exchange({ operation: "refresh", provider, credentials }, undefined, signal),
};

export function defaultAuthManager(): AuthManager {
  return new AuthManager(new CredentialStore(), piAuthDriver);
}
