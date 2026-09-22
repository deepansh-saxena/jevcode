import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function loginPrompt(message: string, hidden: boolean, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Account login requires an interactive terminal");
  process.stderr.write(terminalSafe(`${message} `));
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!hidden) process.stderr.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  const cancelled = new AbortController();
  readline.on("SIGINT", () => cancelled.abort(new Error("Login cancelled")));
  readline.on("close", () => cancelled.abort(new Error("Login input closed")));
  try {
    return await readline.question("", { signal: AbortSignal.any([signal, cancelled.signal]) });
  } finally {
    readline.close();
    output.end();
    if (hidden) process.stderr.write("\n");
  }
}
