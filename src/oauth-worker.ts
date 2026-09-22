import { z } from "zod";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { accountProviderSchema, credentialSchema } from "./auth.js";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("login"), provider: accountProviderSchema }),
  z.object({ operation: z.literal("refresh"), provider: accountProviderSchema, credentials: credentialSchema }),
]);
const answerSchema = z.object({ type: z.literal("answer"), id: z.number().int(), answer: z.string() });
const pending = new Map<number, (answer: string) => void>();
let nextId = 0;

function send(message: object): void {
  process.send?.(message);
}

function prompt(message: string, hidden: boolean): Promise<string> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ type: "prompt", id, message, hidden });
  });
}

process.on("message", (raw: unknown) => {
  const answer = answerSchema.safeParse(raw);
  if (answer.success) {
    pending.get(answer.data.id)?.(answer.data.answer);
    pending.delete(answer.data.id);
  }
});

process.once("message", (raw: unknown) => {
  void (async () => {
    try {
      const request = requestSchema.parse(raw);
      // Pi initializes its Node-only OAuth helpers with asynchronous imports.
      await Promise.all([import("node:crypto"), import("node:http")]);
      const provider = getOAuthProvider(request.provider);
      if (!provider) throw new Error("Unavailable OAuth provider");
      const credentials = request.operation === "refresh" ?
        await provider.refreshToken(request.credentials) :
        await provider.login({
          onAuth: (info) => send({ type: "auth", ...info }),
          onPrompt: (info) => prompt(info.message, !info.allowEmpty),
          onProgress: (message) => send({ type: "progress", message }),
          ...(provider.usesCallbackServer ? {
            onManualCodeInput: () => prompt("Complete browser login, or paste the full callback URL here (input hidden):", true),
          } : {}),
        });
      const validated = credentialSchema.parse(credentials);
      process.send?.({ type: "result", credentials: validated }, () => process.exit(0));
    } catch {
      // Provider errors can contain token responses; never forward those bodies.
      process.send?.({
        type: "error",
        message: "Provider authentication failed. Check your subscription, organization policy, and connection, then try login again. Sensitive provider response details were withheld.",
      }, () => process.exit(1));
    }
  })();
});
