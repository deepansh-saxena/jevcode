const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");

class StdioClient extends EventEmitter {
  constructor(child) {
    super();
    this.child = child;
    this.pending = new Map();
    this.active = null;
    this.buffer = "";
    this.closed = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      this.buffer += text;
      if (Buffer.byteLength(this.buffer) > 2_000_000) return this.dispose("Protocol output exceeded the client limit");
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let packet;
        try { packet = JSON.parse(line); } catch { return this.dispose("Invalid server protocol"); }
        if (!packet || typeof packet !== "object") return this.dispose("Invalid server packet");
        if (packet.type === "ready") {
          if (packet.protocol !== "jevcode" || packet.version !== 1) return this.dispose("Unsupported server protocol");
          this.emit("ready");
        } else if (packet.type === "response") {
          const waiting = this.pending.get(packet.id);
          if (!waiting) continue;
          this.pending.delete(packet.id);
          if (this.active === packet.id) this.active = null;
          if (typeof packet.error === "string") waiting.reject(new Error(packet.error));
          else waiting.resolve(packet.result);
        } else if (packet.type === "event") this.emit("event", packet);
        else return this.dispose("Unknown server packet type");
      }
    });
    // Consume stderr without copying credential-bearing environment or diagnostics into the webview.
    child.stderr.resume();
    child.once("error", () => this.dispose("Jev Code could not start; check your executable configuration"));
    child.once("exit", () => this.dispose("Jev Code exited"));
    child.stdin.on("error", () => this.dispose("Jev Code input closed"));
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("Jev Code is not running"));
    if (method === "prompt" && this.active) return Promise.reject(new Error("A turn is active; cancel it or wait"));
    const id = randomUUID();
    const line = JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n";
    if (Buffer.byteLength(line) > 65_536) return Promise.reject(new Error("Request exceeds the protocol limit"));
    if (this.pending.size >= 50 || this.child.stdin.writableLength > 100_000) return Promise.reject(new Error("Client request limit reached"));
    if (method === "prompt") this.active = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(line);
    });
  }

  cancel() { return this.active ? this.request("cancel", { runId: this.active }) : Promise.resolve(); }

  dispose(reason = "Jev Code client closed") {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    this.active = null;
    this.emit("closed", reason);
  }
}

module.exports = { StdioClient };
