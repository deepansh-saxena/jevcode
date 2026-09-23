const vscode = require("vscode");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { StdioClient } = require("./client.cjs");

let client;
let panel;
let root;
let transcript = "";
let status = "Starting local Jev Code";
const safe = (text) => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

function publish(text = "") {
  transcript = (transcript + safe(text)).slice(-120_000);
  panel?.webview.postMessage({ transcript, status });
}

function html() {
  const nonce = randomBytes(24).toString("base64");
  return `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">body{font-family:var(--vscode-font-family);padding:16px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}textarea{width:100%;min-height:100px}
button{margin:6px}#status{font-weight:bold}</style></head><body>
<div id="status"></div><pre id="transcript"></pre>
<textarea id="prompt" maxlength="48000" aria-label="Prompt"></textarea><br>
<button id="send">Send</button><button id="cancel">Cancel turn</button><button id="tasks">Tasks</button>
<p>Enter newlines freely. Send submits. Permissions and exact actions require separate fresh approval.
Nothing is saved until /save or /export. Image attachment: /attach workspace/path.png.</p>
<script nonce="${nonce}">const api=acquireVsCodeApi();
window.addEventListener('message',({data})=>{document.getElementById('transcript').textContent=data.transcript;
document.getElementById('status').textContent=data.status;});
document.getElementById('send').onclick=()=>{const input=document.getElementById('prompt');
if(input.value.trim()){api.postMessage({method:'prompt',text:input.value});input.value='';}};
document.getElementById('cancel').onclick=()=>api.postMessage({method:'cancel'});
document.getElementById('tasks').onclick=()=>api.postMessage({method:'prompt',text:'/tasks'});
api.postMessage({method:'ready'});</script></body></html>`;
}

async function open(context) {
  if (!vscode.workspace.isTrusted) throw new Error("Jev Code requires a trusted workspace");
  const folder = vscode.window.activeTextEditor ?
    vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;
  const workspace = folder ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspace || workspace.uri.scheme !== "file") throw new Error("Open a local filesystem workspace first");
  if (panel && root === workspace.uri.fsPath && client && !client.closed) { panel.reveal(); return; }
  panel?.dispose();
  client?.dispose();
  const config = vscode.workspace.getConfiguration("jevcode");
  const executable = config.get("executable");
  const args = config.get("arguments", []);
  if (typeof executable !== "string" || !path.isAbsolute(executable) ||
    !Array.isArray(args) || args.length > 20 || args.some((arg) => typeof arg !== "string" || arg.length > 2000)) {
    throw new Error("Set user-level jevcode.executable to an absolute executable path and jevcode.arguments to an array");
  }
  root = workspace.uri.fsPath;
  transcript = "";
  status = "Starting local Jev Code";
  panel = vscode.window.createWebviewPanel("jevcode", "Jev Code", vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [], retainContextWhenHidden: true });
  panel.webview.html = html();
  const connection = new StdioClient(spawn(executable, [...args, "serve", "--cwd", root],
    { cwd: root, shell: false, stdio: ["pipe", "pipe", "pipe"] }));
  client = connection;
  const close = () => { connection.dispose(); if (client === connection) { client = undefined; panel = undefined; } };
  panel.onDidDispose(close, undefined, context.subscriptions);
  panel.webview.onDidReceiveMessage(async (message) => {
    try {
      if (!message || typeof message !== "object") return;
      if (Object.keys(message).some((key) => key !== "method" && key !== "text")) throw new Error("Invalid webview request");
      if (message.method === "ready") publish();
      else if (message.method === "cancel") await connection.cancel();
      else if (message.method === "prompt" && typeof message.text === "string" && message.text.trim() && message.text.length <= 48_000) {
        if (connection.active) throw new Error("A turn is active; cancel it or wait");
        publish(`\nYOU\n${message.text}\n`);
        await connection.request("prompt", { text: message.text });
      }
    } catch (error) { publish(`\nError: ${error.message}\n`); }
  }, undefined, context.subscriptions);
  connection.on("ready", () => { status = "Ready (read-only)"; publish(); });
  connection.on("closed", (reason) => { status = reason; publish(); });
  connection.on("event", async (packet) => {
    try {
      if (packet.event === "text" && typeof packet.data?.text === "string") publish(packet.data.text);
      else if (packet.event === "approval_request" || packet.event === "question") {
        if (packet.runId !== connection.active || typeof packet.data?.requestId !== "string") throw new Error("Uncorrelated interaction");
        const details = packet.data.details;
        const correlation = { runId: packet.runId, requestId: packet.data.requestId };
        if (packet.event === "approval_request") {
          if (typeof details?.prompt !== "string" || details.prompt.length > 100_000) throw new Error("Approval is too large to review");
          const choice = await vscode.window.showWarningMessage("Jev Code requests approval",
            { modal: true, detail: safe(details.prompt) }, "Approve exact request", "Deny");
          if (connection.active === packet.runId) await connection.request("approve", { ...correlation, approved: choice === "Approve exact request" });
        } else {
          if (typeof details?.question !== "string") throw new Error("Invalid clarification");
          const answer = await vscode.window.showInputBox({ title: "Jev Code clarification", prompt: safe(details.question),
            placeHolder: Array.isArray(details.choices) ? details.choices.map(safe).join(" | ") : "" });
          if (connection.active !== packet.runId) return;
          if (!answer?.trim()) await connection.cancel();
          else await connection.request("answer", { ...correlation, answer: answer.slice(0, 12_000) });
        }
      } else { status = safe(packet.event); publish(); }
    } catch (error) { publish(`\nError: ${error.message}\n`); await connection.cancel().catch(() => {}); }
  });
}

function activate(context) {
  const action = (work) => async () => {
    try { await work(); } catch (error) { vscode.window.showErrorMessage(`Jev Code: ${safe(error.message)}`); }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("jevcode.open", action(() => open(context))),
    vscode.commands.registerCommand("jevcode.cancel", action(async () => client?.cancel())),
    vscode.commands.registerCommand("jevcode.selection", action(async () => {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.document.getText(editor.selection);
      if (!selection?.trim()) throw new Error("Select text to share first");
      if (selection.length > 40_000) throw new Error("Selection exceeds 40000 characters");
      const task = await vscode.window.showInputBox({ prompt: "Task for this selection (sent to the coding provider)" });
      if (!task?.trim()) return;
      await open(context);
      const text = `${task}\n\nSelected text (untrusted context):\n${selection}`;
      publish(`\nYOU\n${text}\n`);
      await client.request("prompt", { text });
    })),
    { dispose: () => client?.dispose() },
  );
}

module.exports = { activate, deactivate: () => client?.dispose() };
