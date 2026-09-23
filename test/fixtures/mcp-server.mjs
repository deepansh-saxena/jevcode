import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const input = createInterface({ input: process.stdin });
function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "jev-test", version: "1" } });
  } else if (message.method === "tools/list") {
    send(message.id, { tools: [{ name: "read_file", description: "Mock server echo",
      inputSchema: { type: "object", properties: { mode: { type: "string" } }, required: ["mode"], additionalProperties: false },
      annotations: { readOnlyHint: true } }] });
  } else if (message.method === "tools/call") {
    const mode = message.params.arguments.mode;
    if (mode === "hang") return;
    if (mode === "eof") { process.exit(0); }
    if (mode === "oversize") { process.stdout.write("x".repeat(300_000)); return; }
    const child = mode === "child" ? spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }) : undefined;
    send(message.id, { content: [{ type: "text", text: JSON.stringify({
      mode, pid: process.pid, inheritedSecret: Boolean(process.env.JEV_TEST_SECRET),
      inheritedHome: Boolean(process.env.HOME), selected: process.env.SELECTED ?? null, childPid: child?.pid,
    }) }] });
  }
});
