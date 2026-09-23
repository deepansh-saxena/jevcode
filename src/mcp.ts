import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport, FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import type { McpServerConfig } from "./extension-config.js";
import { BoundedStdioTransport, EXTENSION_INPUT_LIMIT, EXTENSION_OUTPUT_LIMIT, referenceEnvironment } from "./extension-process.js";
import { BlockedError } from "./errors.js";
import { digest } from "./workspace.js";
import type { Tool } from "./tools.js";

// SDK transports expose undefined-valued optional properties that do not satisfy
// their own Transport type under exactOptionalPropertyTypes. Forward behavior,
// rather than weakening the project's type checking or casting the instance.
export function transportBridge(source: Pick<Transport, "start" | "send" | "close"> & {
  onclose?: Transport["onclose"]; onerror?: Transport["onerror"]; onmessage?: Transport["onmessage"];
  setProtocolVersion?: Transport["setProtocolVersion"];
}): Transport {
  const bridge: Transport = {
    async start() {
      source.onclose = () => bridge.onclose?.();
      source.onerror = (error) => bridge.onerror?.(error);
      source.onmessage = (message, extra) => bridge.onmessage?.(message, extra);
      await source.start();
    },
    async send(message, options) { await source.send(message, options); },
    async close() { await source.close(); },
    setProtocolVersion(version) { source.setProtocolVersion?.(version); },
  };
  return bridge;
}

function boundedFetch(url: string, timeoutMs: number, lifetime: AbortSignal, headers: Record<string, string>): FetchLike {
  return async (target, init = {}) => {
    if (new URL(target).href !== new URL(url).href) throw new BlockedError("MCP requested an unapproved URL");
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]);
    const response = await fetch(target, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...headers },
      redirect: "error", signal });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let size = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) { controller.close(); return; }
          size += result.value.byteLength;
          if (size > EXTENSION_OUTPUT_LIMIT) { await reader.cancel(); throw new Error("MCP HTTP response limit exceeded"); }
          controller.enqueue(result.value);
        } catch { controller.error(new Error("MCP HTTP response failed, timed out, or exceeded its limit")); }
      },
      async cancel() { await reader.cancel(); },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export class McpConnection {
  private client = new Client({ name: "jev-code", version: "0.1.0" }, { capabilities: {} });
  private lifetime = new AbortController();
  private transport?: Transport;
  private http?: StreamableHTTPClientTransport;
  private catalog: McpTool[] = [];
  private connected = false;
  private failure?: string;
  private validator = new AjvJsonSchemaValidator();
  constructor(readonly id: string, readonly config: McpServerConfig, private cwd: string, private env: NodeJS.ProcessEnv) {}

  status() { return { id: this.id, connected: this.connected, tools: this.catalog.map((tool) => tool.name), error: this.failure }; }

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    let transport: Transport;
    if (this.config.transport === "stdio") transport = new BoundedStdioTransport(this.config, this.cwd, this.env);
    else {
      this.http = new StreamableHTTPClientTransport(new URL(this.config.url), {
        fetch: boundedFetch(this.config.url, this.config.timeoutMs, this.lifetime.signal,
          referenceEnvironment(this.config.headers, this.env)),
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      });
      transport = transportBridge(this.http);
    }
    this.transport = transport;
    this.client.onerror = () => { this.failure = "MCP transport/protocol error; disconnect and reconnect explicitly"; };
    this.client.onclose = () => { this.connected = false; };
    const abort = (): void => { this.lifetime.abort(new Error("MCP connection cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const requestSignal = AbortSignal.any([signal, this.lifetime.signal]);
      await this.client.connect(transport, { signal: requestSignal, timeout: this.config.timeoutMs });
      let cursor: string | undefined;
      let bytes = 0;
      const seen = new Set<string>();
      do {
        const page = await this.client.listTools(cursor ? { cursor } : {}, { signal: requestSignal, timeout: this.config.timeoutMs });
        bytes += Buffer.byteLength(JSON.stringify(page));
        if (bytes > EXTENSION_OUTPUT_LIMIT || this.catalog.length + page.tools.length > 64) throw new Error("MCP tool catalog limit exceeded");
        for (const tool of page.tools) {
          if (seen.has(tool.name) || tool.name.length > 128 || Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 16_000) {
            throw new Error("Invalid, duplicate, or oversized MCP tool definition");
          }
          seen.add(tool.name);
          const schema: Record<string, unknown> = tool.inputSchema;
          this.validator.getValidator(schema);
          this.catalog.push(tool);
        }
        cursor = page.nextCursor;
        if (cursor && (page.tools.length === 0 || seen.has(`cursor:${cursor}`))) throw new Error("Invalid MCP pagination");
        if (cursor) seen.add(`cursor:${cursor}`);
      } while (cursor);
      signal.throwIfAborted();
      this.connected = true;
    } catch {
      await this.close();
      throw new Error("MCP connection or discovery failed; server details withheld. Check executable, environment references, endpoint, and protocol.");
    } finally { signal.removeEventListener("abort", abort); }
  }

  tools(): Tool[] {
    if (!this.connected || this.failure) return [];
    return this.catalog.map((definition) => {
      const name = `mcp__${this.id.slice(0, 20)}__${digest(`${this.id}/${definition.name}`).slice(0, 20)}` as const;
      const inputSchema: Record<string, unknown> = definition.inputSchema;
      const validate = this.validator.getValidator(inputSchema);
      return {
        name, description: `External MCP ${this.id}/${definition.name} (untrusted; exact approval always required). ${(definition.description ?? "").slice(0, 2000)}`,
        schema: z.record(z.string(), z.unknown()), inputSchema: definition.inputSchema,
        prepare: async (input: unknown) => {
          const args = z.record(z.string(), z.unknown()).parse(input);
          if (Buffer.byteLength(JSON.stringify(args)) > EXTENSION_INPUT_LIMIT - 1024) throw new Error("MCP arguments exceed limit");
          if (!validate(args).valid) throw new Error("Arguments do not match the MCP tool schema");
          const approved = JSON.stringify(args);
          return {
            name, mutating: true,
            details: { server: this.id, tool: definition.name, arguments: JSON.parse(approved) as unknown,
              warning: "External call; annotations never grant permission. Server runs outside the sandbox." },
            execute: async (signal: AbortSignal) => {
              signal.throwIfAborted();
              if (!this.connected || this.failure) throw new BlockedError("MCP server is no longer connected");
              try {
                const result = await this.client.callTool({ name: definition.name, arguments: JSON.parse(approved) as Record<string, unknown> },
                  undefined, { signal: AbortSignal.any([signal, this.lifetime.signal]), timeout: this.config.timeoutMs });
                if (Buffer.byteLength(JSON.stringify(result)) > EXTENSION_OUTPUT_LIMIT) throw new Error("MCP output limit exceeded");
                return result;
              } catch {
                let cleanupFailed = false;
                try { await this.close(); } catch { cleanupFailed = true; }
                throw new Error(`MCP call failed or was cancelled; ${cleanupFailed ? "cleanup also failed; inspect server-side state" : "server disconnected"}. External effects may already have occurred; do not retry without checking.`);
              }
            },
          };
        },
      };
    });
  }

  async close(): Promise<void> {
    this.connected = false;
    const timer = setTimeout(() => this.lifetime.abort(new Error("MCP session cleanup deadline")), 1000);
    let failure = false;
    try {
      if (this.http?.sessionId && !this.lifetime.signal.aborted) {
        try { await this.http.terminateSession(); } catch { failure = true; }
      }
    } finally {
      clearTimeout(timer);
      this.lifetime.abort(new Error("MCP connection closed"));
      await this.client.close();
      await this.transport?.close();
    }
    if (failure) throw new Error("MCP transport closed, but remote session termination failed; server-side cleanup may be needed");
  }
}
