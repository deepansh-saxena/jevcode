import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const safeText = z.string().min(1).max(4096).refine((text) => !/[\0\r\n]/.test(text));
export const localPath = z.string().min(1).max(1024).refine((text) =>
  !text.startsWith("/") && !text.includes("\\") && !text.includes("\0") &&
  text.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
"Use a normalized relative path without traversal");
export const extensionCommandSchema = z.object({
  executable: safeText,
  args: z.array(safeText).max(100).default([]),
  env: z.record(envName, envName).default({}),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();
export const mcpServerSchema = z.discriminatedUnion("transport", [
  extensionCommandSchema.extend({ transport: z.literal("stdio") }),
  z.object({
    transport: z.literal("http"),
    url: z.string().url().refine((text) => {
      const url = new URL(text);
      return !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    }, "Use HTTPS or loopback HTTP, without credentials, query, or fragment"),
    headers: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/), envName).default({}),
    timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
  }).strict(),
]);
export const hookSchema = extensionCommandSchema.extend({
  event: z.enum(["before", "after"]),
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,127}$/)).max(64).default([]),
}).strict();
export const extensionsSchema = z.object({
  plugins: z.record(identifier, localPath).default({}),
  mcp: z.record(identifier, mcpServerSchema).default({}),
  hooks: z.record(identifier, hookSchema).default({}),
}).strict();
export const pluginSchema = z.object({
  version: z.literal(1),
  id: identifier,
  description: z.string().min(1).max(2000),
  skills: localPath.optional(),
  agents: localPath.optional(),
  mcp: z.record(identifier, mcpServerSchema).default({}),
  hooks: z.record(identifier, hookSchema).default({}),
}).strict();
export type McpServerConfig = z.infer<typeof mcpServerSchema>;
export type HookConfig = z.infer<typeof hookSchema>;
export type ExtensionCommand = z.infer<typeof extensionCommandSchema>;
