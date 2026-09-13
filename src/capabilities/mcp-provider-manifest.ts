import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { CapabilityEffects, CapabilityRuntimeRequirements } from "./types.js";

const id = z.string().regex(/^[a-z0-9_-]+(?:\.[a-z0-9_-]+){2,}$/);
const effects = z.object({
  readOnly: z.boolean(),
  destructive: z.boolean(),
  idempotent: z.boolean(),
  openWorld: z.boolean(),
}).strict().refine((value) => !(value.readOnly && value.destructive), {
  message: "A read-only tool cannot be destructive.",
});
const availability = z.object({
  requiresAwake: z.boolean().default(false),
  requiresLoggedInSession: z.boolean().default(false),
  requiresUnlocked: z.boolean().default(false),
  requiresForegroundApp: z.boolean().default(false),
}).strict().default({
  requiresAwake: false,
  requiresLoggedInSession: false,
  requiresUnlocked: false,
  requiresForegroundApp: false,
});
const stdioTransport = z.object({
  type: z.literal("stdio"),
  command: z.string().refine(isAbsolute, "stdio command must be absolute"),
  args: z.array(z.string()).default([]),
  cwd: z.string().refine(isAbsolute, "stdio cwd must be absolute").optional(),
  envFrom: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
}).strict();
const httpTransport = z.object({
  type: z.literal("streamable-http"),
  url: z.string().url().refine(isSafeMcpUrl, "HTTP MCP URL must be HTTPS or loopback HTTP"),
  headersFromEnv: z.record(z.string(), z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default({}),
}).strict();
const toolMapping = z.object({
  tool: z.string().min(1),
  capabilityId: id,
  title: z.string().min(1).max(200).optional(),
  description: z.string().min(1).max(4_000).optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).default("1.0.0"),
  tags: z.array(z.string().regex(/^[a-z0-9_-]+$/)).default(["mcp"]),
  aliases: z.array(z.string()).default([]),
  effects,
  availability,
  defaultTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
  maxTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
}).strict().refine((value) => value.defaultTimeoutMs <= value.maxTimeoutMs, {
  message: "defaultTimeoutMs must not exceed maxTimeoutMs",
});

export const mcpProviderManifestSchema = z.object({
  apiVersion: z.literal("devspace.capabilities/v1"),
  kind: z.literal("McpProvider"),
  metadata: z.object({
    id,
    title: z.string().min(1).max(200).optional(),
  }).strict(),
  spec: z.object({
    enabled: z.boolean().default(true),
    transport: z.discriminatedUnion("type", [stdioTransport, httpTransport]),
    tools: z.array(toolMapping).min(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  const tools = new Set<string>();
  const capabilityIds = new Set<string>();
  for (const [index, mapping] of manifest.spec.tools.entries()) {
    if (tools.has(mapping.tool)) context.addIssue({ code: "custom", path: ["spec", "tools", index, "tool"], message: "duplicate downstream tool" });
    if (capabilityIds.has(mapping.capabilityId)) context.addIssue({ code: "custom", path: ["spec", "tools", index, "capabilityId"], message: "duplicate capability id" });
    tools.add(mapping.tool);
    capabilityIds.add(mapping.capabilityId);
  }
});

export type McpProviderManifest = z.infer<typeof mcpProviderManifestSchema>;
export type McpToolMapping = McpProviderManifest["spec"]["tools"][number] & {
  effects: CapabilityEffects;
  availability: CapabilityRuntimeRequirements;
};

export interface LoadedMcpProviderManifest {
  path: string;
  manifest: McpProviderManifest;
}

export function parseMcpProviderManifest(value: unknown): McpProviderManifest {
  return mcpProviderManifestSchema.parse(value);
}

export function loadMcpProviderManifests(configDir: string): LoadedMcpProviderManifest[] {
  try {
    if (!statSync(configDir).isDirectory()) return [];
  } catch {
    return [];
  }
  return readdirSync(configDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:json|ya?ml)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = resolve(join(configDir, entry.name));
      return { path, manifest: readMcpProviderManifest(path) };
    });
}

export function readMcpProviderManifest(path: string): McpProviderManifest {
  const resolved = resolve(path);
  const text = readFileSync(resolved, "utf8");
  const value = /\.json$/i.test(resolved) ? JSON.parse(text) : YAML.parse(text);
  return parseMcpProviderManifest(value);
}

export function installMcpProviderManifest(sourcePath: string, configDir: string): string {
  const manifest = readMcpProviderManifest(sourcePath);
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const target = join(configDir, `${manifest.metadata.id}.json`);
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}

function isSafeMcpUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
