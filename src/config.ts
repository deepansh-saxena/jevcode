import { z } from "zod";

export const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const executionToolNames = [
  "list_files", "read_file", "search_files", "write_file", "replace_text", "run_command",
] as const;
export const toolNames = [
  ...executionToolNames, "list_capabilities", "create_skill", "create_specialist", "load_skill", "delegate_task", "ask_user",
] as const;
export type ToolName = (typeof toolNames)[number];

export const commandSchema = z.object({
  description: z.string().min(1).max(1000),
  executable: z.string().min(1),
  args: z.array(z.string()).max(100),
  timeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();

const endpoint = z.string().url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
}, "Use HTTPS, or loopback HTTP for local development, without credentials/query/fragment");

export const configSchema = z.object({
  version: z.literal(1),
  llm: z.object({
    provider: z.enum(["openai-compatible", "github-copilot", "openai-codex"]).default("openai-compatible"),
    baseUrl: endpoint.default("https://api.openai.com/v1"),
    model: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("OPENAI_API_KEY"),
    maxOutputTokens: z.number().int().min(1).max(32_768).default(4096),
    timeoutMs: z.number().int().min(100).max(300_000).default(60_000),
  }).strict(),
  jev: z.object({
    mode: z.enum(["off", "shadow", "on"]).default("off"),
    endpoint: endpoint.default("https://api.typesafe.ai/v1/systemone"),
    model: z.string().min(1).default("jev-latest"),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("TYPESAFE_API_KEY"),
    allowDataSharing: z.boolean().default(false),
    timeoutMs: z.number().int().min(100).max(60_000).default(10_000),
    skillThreshold: z.number().min(0).max(1).default(0.75),
    delegationConfidence: z.number().min(0).max(1).default(0.7),
    routeSkills: z.boolean().optional(),
    routeSpecialists: z.boolean().optional(),
    guardrail: z.enum(["off", "shadow", "mutations", "all"]).default("off"),
    guardrailThreshold: z.number().min(0).max(1).default(0.95),
  }).strict().default({
    mode: "off", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY", allowDataSharing: false, timeoutMs: 10_000,
    skillThreshold: 0.75, delegationConfidence: 0.7, guardrail: "off", guardrailThreshold: 0.95,
  }),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(100).default(16),
    maxToolCalls: z.number().int().min(1).max(200).default(40),
    maxTokens: z.number().int().min(1).max(1_000_000).default(100_000),
    maxDurationMs: z.number().int().min(100).max(3_600_000).default(300_000),
    maxContextChars: z.number().int().min(1000).max(1_000_000).default(120_000),
    maxSkillChars: z.number().int().min(100).max(100_000).default(24_000),
    maxSpecialistRuns: z.number().int().min(0).max(10).default(3),
  }).strict().default({
    maxTurns: 16, maxToolCalls: 40, maxTokens: 100_000,
    maxDurationMs: 300_000, maxContextChars: 120_000, maxSkillChars: 24_000, maxSpecialistRuns: 3,
  }),
  protectedPaths: z.array(z.string().min(1).refine((value) =>
    !value.includes("\\") && !value.includes("\0") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  "Use normalized workspace-relative file or directory paths")).default([]),
  commands: z.record(idSchema, commandSchema).default({}),
}).strict().superRefine((value, context) => {
  if ((value.jev.mode !== "off" || value.jev.guardrail !== "off") && !value.jev.allowDataSharing) {
    context.addIssue({
      code: "custom", path: ["jev", "allowDataSharing"],
      message: "Enabling Jev requires explicit allowDataSharing consent",
    });
  }
});
export type Config = z.infer<typeof configSchema>;

export const skillSchema = z.object({
  id: idSchema,
  version: z.string().min(1),
  description: z.string().min(1).max(2000),
  applicability: z.string().max(2000).optional(),
  instructions: z.string().min(1),
  mandatory: z.boolean().default(false),
  resources: z.array(z.string().min(1)).max(16).optional(),
  commandIds: z.array(idSchema).max(16).optional(),
}).strict();
export type Skill = z.infer<typeof skillSchema>;

export const specialistSchema = z.object({
  id: idSchema,
  description: z.string().min(1).max(2000),
  role: z.string().min(1).max(4000),
  model: z.string().min(1).optional(),
  skills: z.array(idSchema).default([]),
  tools: z.array(z.enum(executionToolNames)).min(1),
  maxTurns: z.number().int().min(1).max(20).default(5),
  maxToolCalls: z.number().int().min(1).max(40).default(10),
  resultFormat: z.enum(["text", "structured"]).optional(),
}).strict();
export type Specialist = z.infer<typeof specialistSchema>;
