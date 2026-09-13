import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type {
  CapabilityEffects,
  CapabilityPermissionRequirement,
  CapabilityRuntimeRequirements,
} from "./types.js";

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
  permissions: z.array(z.object({
    id: z.string().min(1),
    required: z.boolean(),
    description: z.string().min(1),
  }).strict()).default([]),
  requiresLease: z.boolean().default(false),
  resourceTypes: z.array(z.string().min(1)).default([]),
  defaultTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
  maxTimeoutMs: z.number().int().positive().max(600_000).default(120_000),
}).strict().superRefine((value, context) => {
  if (value.defaultTimeoutMs > value.maxTimeoutMs) {
    context.addIssue({ code: "custom", message: "defaultTimeoutMs must not exceed maxTimeoutMs" });
  }
  if (value.requiresLease && value.resourceTypes.length === 0) {
    context.addIssue({ code: "custom", path: ["resourceTypes"], message: "lease-bound tools require resourceTypes" });
  }
  if (!value.requiresLease && value.resourceTypes.length > 0) {
    context.addIssue({ code: "custom", path: ["resourceTypes"], message: "resourceTypes require requiresLease=true" });
  }
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
    discoverAllTools: z.boolean().default(false),
    discoveredToolVersion: z.string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
      .default("1.0.0"),
    tools: z.array(toolMapping).default([]),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (!manifest.spec.discoverAllTools && manifest.spec.tools.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["spec", "tools"],
      message: "tools must not be empty unless discoverAllTools=true",
    });
  }
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
  permissions: CapabilityPermissionRequirement[];
};

export interface LoadedMcpProviderManifest {
  path: string;
  manifest: McpProviderManifest;
}

export function parseMcpProviderManifest(value: unknown): McpProviderManifest {
  return mcpProviderManifestSchema.parse(value);
}

export function loadMcpProviderManifests(configDir: string): LoadedMcpProviderManifest[] {
  if (!assertSecureProviderDirectory(configDir, false)) return [];
  const loaded = readdirSync(configDir, { withFileTypes: true })
    .filter((entry) => /\.(?:json|ya?ml)$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const path = resolve(join(configDir, entry.name));
      assertSecureProviderFile(path);
      return { path, manifest: readMcpProviderManifest(path) };
    });
  const providerIds = new Set<string>();
  for (const { manifest } of loaded) {
    if (providerIds.has(manifest.metadata.id)) {
      throw new Error(`Duplicate MCP provider id: ${manifest.metadata.id}`);
    }
    providerIds.add(manifest.metadata.id);
  }
  return loaded;
}

export function readMcpProviderManifest(path: string): McpProviderManifest {
  const resolved = resolve(path);
  const text = readFileSync(resolved, "utf8");
  const value = /\.json$/i.test(resolved) ? JSON.parse(text) : YAML.parse(text);
  return parseMcpProviderManifest(value);
}

export function installMcpProviderManifest(sourcePath: string, configDir: string): string {
  const manifest = readMcpProviderManifest(sourcePath);
  return writeMcpProviderManifest(manifest, configDir);
}

export function writeMcpProviderManifest(manifest: McpProviderManifest, configDir: string): string {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  assertSecureProviderDirectory(configDir, true);
  const target = join(configDir, `${manifest.metadata.id}.json`);
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}

export function setMcpProviderEnabled(providerId: string, enabled: boolean, configDir: string): string {
  const loaded = findMcpProviderManifest(providerId, configDir);
  replaceManifestAtomically(loaded.path, parseMcpProviderManifest({
    ...loaded.manifest,
    spec: { ...loaded.manifest.spec, enabled },
  }));
  return loaded.path;
}

export function archiveMcpProviderManifest(providerId: string, configDir: string): {
  path: string;
  archivedPath: string;
} {
  const loaded = findMcpProviderManifest(providerId, configDir);
  const archiveDirectory = join(resolve(configDir), ".removed");
  mkdirSync(archiveDirectory, { recursive: true, mode: 0o700 });
  assertSecureProviderDirectory(archiveDirectory, true);
  const extension = extname(loaded.path).toLowerCase() || ".json";
  const archivedPath = join(archiveDirectory, `${providerId}-${Date.now()}-${randomUUID()}${extension}`);
  renameSync(loaded.path, archivedPath);
  return { path: loaded.path, archivedPath };
}

export function restoreArchivedMcpProviderManifest(path: string, archivedPath: string): void {
  assertSecureProviderFile(archivedPath);
  assertSecureProviderDirectory(dirname(resolve(path)), true);
  renameSync(archivedPath, path);
}

function findMcpProviderManifest(providerId: string, configDir: string): LoadedMcpProviderManifest {
  id.parse(providerId);
  const loaded = loadMcpProviderManifests(configDir).find(({ manifest }) =>
    manifest.metadata.id === providerId);
  if (!loaded) throw new Error(`Unknown MCP provider: ${providerId}`);
  return loaded;
}

function replaceManifestAtomically(path: string, manifest: McpProviderManifest): void {
  assertSecureProviderFile(path);
  const temporary = join(dirname(resolve(path)), `.${manifest.metadata.id}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function assertSecureProviderDirectory(path: string, required: boolean): boolean {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (!required && isMissing(error)) return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`MCP provider config path must be a real directory: ${path}`);
  }
  assertCurrentUserOwnership(path, stats.uid);
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error(`MCP provider config directory must not be group/world writable: ${path}`);
  }
  return true;
}

function assertSecureProviderFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`MCP provider manifest must be a regular file: ${path}`);
  }
  assertCurrentUserOwnership(path, stats.uid);
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`MCP provider manifest must have mode 0600 or stricter: ${path}`);
  }
}

function assertCurrentUserOwnership(path: string, owner: number): void {
  const current = process.getuid?.();
  if (current !== undefined && owner !== current) {
    throw new Error(`MCP provider path must be owned by the current user: ${path}`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isSafeMcpUrl(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
}
