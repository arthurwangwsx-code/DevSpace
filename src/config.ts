import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHomePath } from "./roots.js";
import type { LoggingConfig, LogFormat, LogLevel } from "./logger.js";
import type { OAuthConfig } from "./oauth-provider.js";
import { devspaceAgentsDir, devspaceSkillsDir, loadDevspaceFiles } from "./user-config.js";

export type ToolMode = "minimal" | "full" | "codex";
export type WidgetMode = "off" | "changes" | "full";
export type AuthMode = "oauth" | "trusted-local";
const DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface ResourceLimitsConfig {
  mcpMaxRequestBytes: number;
  workspaceMemoryIdleTimeoutMs: number;
  mcpMaxSessions: number;
  mcpMaxIdleSessions: number;
  mcpSessionIdleTimeoutMs: number;
  mcpSessionCleanupIntervalMs: number;
  mcpMaxConcurrentRequests: number;
  mcpMaxQueuedRequests: number;
  mcpRequestQueueTimeoutMs: number;
  mcpHeapSoftLimitRatio: number;
  mcpHeapHardLimitRatio: number;
  processMaxConcurrent: number;
  processMaxConcurrentPerWorkspace: number;
  processMaxSessions: number;
  processBufferCharacters: number;
}

export interface CapabilityConfig {
  enabled: boolean;
  configDir: string;
  maxConcurrent: number;
  maxConcurrentPerProvider: number;
  queueLimit: number;
  maxOutputBytes: number;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
}

export interface ServerConfig {
  host: string;
  port: number;
  authMode: AuthMode;
  oauth: OAuthConfig;
  allowedRoots: string[];
  allowedHosts: string[];
  publicBaseUrl: string;
  toolMode: ToolMode;
  widgets: WidgetMode;
  stateDir: string;
  worktreeRoot: string;
  skillsEnabled: boolean;
  skillPaths: string[];
  devspaceSkillsDir: string;
  devspaceAgentsDir: string;
  subagents: boolean;
  agentDir: string;
  resources: ResourceLimitsConfig;
  capabilities: CapabilityConfig;
  logging: LoggingConfig;
}

function parseAuthMode(value: string | undefined, host: string): AuthMode {
  const mode = value?.trim() || "oauth";
  if (mode !== "oauth" && mode !== "trusted-local") {
    throw new Error(`Invalid DEVSPACE_AUTH_MODE: ${value}`);
  }

  if (mode === "trusted-local" && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("DEVSPACE_AUTH_MODE=trusted-local requires HOST to be a loopback address.");
  }

  return mode;
}

function parsePort(value: string | number | undefined): number {
  if (value === undefined || value === "") return 7676;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${value}`);
  }

  return port;
}

function parseAllowedRoots(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    const roots = value.map((entry) => entry.trim()).filter(Boolean);
    return (roots.length > 0 ? roots : [process.cwd()]).map((root) => resolve(expandHomePath(root)));
  }

  const rawRoots =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  const roots = rawRoots.length > 0 ? rawRoots : [process.cwd()];
  return roots.map((root) => resolve(expandHomePath(root)));
}

function parseAllowedHosts(value: string | string[] | undefined, derivedHosts: string[]): string[] {
  if (Array.isArray(value)) {
    return normalizeAllowedHosts(value, derivedHosts);
  }

  const rawHosts =
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];

  return normalizeAllowedHosts(rawHosts, derivedHosts);
}

function normalizeAllowedHosts(rawHosts: string[], derivedHosts: string[]): string[] {
  const hosts = rawHosts.length > 0 ? rawHosts : derivedHosts;
  if (hosts.includes("*")) return ["*"];
  return Array.from(new Set(hosts.map((host) => host.trim()).filter(Boolean)));
}

function parseBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.toLowerCase() ?? "");
}

function parseToolMode(env: NodeJS.ProcessEnv): ToolMode {
  const mode = env.DEVSPACE_TOOL_MODE;
  if (mode === "minimal" || mode === "full" || mode === "codex") return mode;
  if (mode) throw new Error(`Invalid DEVSPACE_TOOL_MODE: ${mode}`);

  if (env.DEVSPACE_MINIMAL_TOOLS !== undefined) {
    return parseBoolean(env.DEVSPACE_MINIMAL_TOOLS) ? "minimal" : "full";
  }
  return "minimal";
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value || value === "info") return "info";
  if (["silent", "error", "warn", "debug"].includes(value)) return value as LogLevel;

  throw new Error(`Invalid DEVSPACE_LOG_LEVEL: ${value}`);
}

function parseLogFormat(value: string | undefined): LogFormat {
  if (!value || value === "json") return "json";
  if (value === "pretty") return "pretty";

  throw new Error(`Invalid DEVSPACE_LOG_FORMAT: ${value}`);
}

function parsePathList(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? []
  );
}

function parseStringList(value: string | undefined, fallback: string[]): string[] {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed;
}

function parsePercentage(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 100) {
    throw new Error(`Invalid ${name}: ${value}`);
  }

  return parsed / 100;
}

function parseResourceLimits(env: NodeJS.ProcessEnv): ResourceLimitsConfig {
  const mcpMaxRequestBytes = parsePositiveInteger(env.DEVSPACE_MCP_MAX_REQUEST_BYTES, 16 * 1024 * 1024, "DEVSPACE_MCP_MAX_REQUEST_BYTES");
  if (mcpMaxRequestBytes > 64 * 1024 * 1024) throw new Error("DEVSPACE_MCP_MAX_REQUEST_BYTES must not exceed 67108864 (64 MiB).");
  const mcpMaxSessions = parsePositiveInteger(
    env.DEVSPACE_MCP_MAX_SESSIONS,
    512,
    "DEVSPACE_MCP_MAX_SESSIONS",
  );
  const mcpMaxIdleSessions = parsePositiveInteger(
    env.DEVSPACE_MCP_MAX_IDLE_SESSIONS,
    128,
    "DEVSPACE_MCP_MAX_IDLE_SESSIONS",
  );
  if (mcpMaxIdleSessions > mcpMaxSessions) {
    throw new Error("DEVSPACE_MCP_MAX_IDLE_SESSIONS must not exceed DEVSPACE_MCP_MAX_SESSIONS.");
  }

  const mcpHeapSoftLimitRatio = parsePercentage(
    env.DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT,
    0.65,
    "DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT",
  );
  const mcpHeapHardLimitRatio = parsePercentage(
    env.DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT,
    0.8,
    "DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT",
  );
  if (mcpHeapSoftLimitRatio >= mcpHeapHardLimitRatio) {
    throw new Error(
      "DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT must be lower than DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT.",
    );
  }

  const processMaxConcurrent = parsePositiveInteger(
    env.DEVSPACE_PROCESS_MAX_CONCURRENT,
    16,
    "DEVSPACE_PROCESS_MAX_CONCURRENT",
  );
  const processMaxConcurrentPerWorkspace = parsePositiveInteger(
    env.DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE,
    Math.min(2, processMaxConcurrent),
    "DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE",
  );
  if (processMaxConcurrentPerWorkspace > processMaxConcurrent) {
    throw new Error(
      "DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE must not exceed DEVSPACE_PROCESS_MAX_CONCURRENT.",
    );
  }
  const processMaxSessions = parsePositiveInteger(
    env.DEVSPACE_PROCESS_MAX_SESSIONS,
    64,
    "DEVSPACE_PROCESS_MAX_SESSIONS",
  );
  if (processMaxSessions < processMaxConcurrent) {
    throw new Error("DEVSPACE_PROCESS_MAX_SESSIONS must be at least DEVSPACE_PROCESS_MAX_CONCURRENT.");
  }

  return {
    mcpMaxRequestBytes,
    workspaceMemoryIdleTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_WORKSPACE_MEMORY_IDLE_TIMEOUT_SECONDS,
      4 * 60 * 60,
      "DEVSPACE_WORKSPACE_MEMORY_IDLE_TIMEOUT_SECONDS",
    ) * 1_000,
    mcpMaxSessions,
    mcpMaxIdleSessions,
    mcpSessionIdleTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS,
      12 * 60 * 60,
      "DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS",
    ) * 1_000,
    mcpSessionCleanupIntervalMs: parsePositiveInteger(
      env.DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS,
      30,
      "DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS",
    ) * 1_000,
    mcpMaxConcurrentRequests: parsePositiveInteger(
      env.DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS,
      64,
      "DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS",
    ),
    mcpMaxQueuedRequests: parseNonNegativeInteger(
      env.DEVSPACE_MCP_MAX_QUEUED_REQUESTS,
      128,
      "DEVSPACE_MCP_MAX_QUEUED_REQUESTS",
    ),
    mcpRequestQueueTimeoutMs: parsePositiveInteger(
      env.DEVSPACE_MCP_REQUEST_QUEUE_TIMEOUT_MS,
      30_000,
      "DEVSPACE_MCP_REQUEST_QUEUE_TIMEOUT_MS",
    ),
    mcpHeapSoftLimitRatio,
    mcpHeapHardLimitRatio,
    processMaxConcurrent,
    processMaxConcurrentPerWorkspace,
    processMaxSessions,
    processBufferCharacters: parsePositiveInteger(
      env.DEVSPACE_PROCESS_BUFFER_CHARACTERS,
      512 * 1_024,
      "DEVSPACE_PROCESS_BUFFER_CHARACTERS",
    ),
  };
}

function parseCapabilityConfig(env: NodeJS.ProcessEnv): CapabilityConfig {
  const maxConcurrent = parsePositiveInteger(
    env.DEVSPACE_CAPABILITY_MAX_CONCURRENT,
    8,
    "DEVSPACE_CAPABILITY_MAX_CONCURRENT",
  );
  const maxConcurrentPerProvider = parsePositiveInteger(
    env.DEVSPACE_CAPABILITY_MAX_CONCURRENT_PER_PROVIDER,
    2,
    "DEVSPACE_CAPABILITY_MAX_CONCURRENT_PER_PROVIDER",
  );
  if (maxConcurrentPerProvider > maxConcurrent) {
    throw new Error(
      "DEVSPACE_CAPABILITY_MAX_CONCURRENT_PER_PROVIDER must not exceed DEVSPACE_CAPABILITY_MAX_CONCURRENT.",
    );
  }
  const defaultTimeoutMs = parsePositiveInteger(
    env.DEVSPACE_CAPABILITY_DEFAULT_TIMEOUT_MS,
    30_000,
    "DEVSPACE_CAPABILITY_DEFAULT_TIMEOUT_MS",
  );
  const maxTimeoutMs = parsePositiveInteger(
    env.DEVSPACE_CAPABILITY_MAX_TIMEOUT_MS,
    120_000,
    "DEVSPACE_CAPABILITY_MAX_TIMEOUT_MS",
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new Error(
      "DEVSPACE_CAPABILITY_DEFAULT_TIMEOUT_MS must not exceed DEVSPACE_CAPABILITY_MAX_TIMEOUT_MS.",
    );
  }
  return {
    enabled: parseBoolean(env.DEVSPACE_CAPABILITIES),
    configDir: resolve(expandHomePath(
      env.DEVSPACE_CAPABILITY_CONFIG_DIR ?? join(homedir(), ".devspace", "capabilities"),
    )),
    maxConcurrent,
    maxConcurrentPerProvider,
    queueLimit: parseNonNegativeInteger(
      env.DEVSPACE_CAPABILITY_QUEUE_LIMIT,
      64,
      "DEVSPACE_CAPABILITY_QUEUE_LIMIT",
    ),
    maxOutputBytes: parsePositiveInteger(
      env.DEVSPACE_CAPABILITY_MAX_OUTPUT_BYTES,
      4 * 1024 * 1024,
      "DEVSPACE_CAPABILITY_MAX_OUTPUT_BYTES",
    ),
    defaultTimeoutMs,
    maxTimeoutMs,
  };
}

function parseLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  return {
    level: parseLogLevel(env.DEVSPACE_LOG_LEVEL),
    format: parseLogFormat(env.DEVSPACE_LOG_FORMAT),
    requests: env.DEVSPACE_LOG_REQUESTS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_REQUESTS),
    assets: parseBoolean(env.DEVSPACE_LOG_ASSETS),
    toolCalls: env.DEVSPACE_LOG_TOOL_CALLS === undefined ? true : parseBoolean(env.DEVSPACE_LOG_TOOL_CALLS),
    shellCommands: parseBoolean(env.DEVSPACE_LOG_SHELL_COMMANDS),
    trustProxy: parseBoolean(env.DEVSPACE_TRUST_PROXY),
    slowRequestMs: parsePositiveInteger(
      env.DEVSPACE_LOG_SLOW_REQUEST_MS,
      3_000,
      "DEVSPACE_LOG_SLOW_REQUEST_MS",
    ),
    slowToolCallMs: parsePositiveInteger(
      env.DEVSPACE_LOG_SLOW_TOOL_CALL_MS,
      5_000,
      "DEVSPACE_LOG_SLOW_TOOL_CALL_MS",
    ),
    eventLoopLagMs: parsePositiveInteger(
      env.DEVSPACE_LOG_EVENT_LOOP_LAG_MS,
      1_000,
      "DEVSPACE_LOG_EVENT_LOOP_LAG_MS",
    ),
  };
}

function parseWidgetMode(value: string | undefined): WidgetMode {
  if (!value || value === "full") return "full";
  if (value === "off" || value === "changes") return value;

  throw new Error(`Invalid DEVSPACE_WIDGETS: ${value}`);
}

function parseRequiredSecret(value: string | undefined, name: string): string {
  const secret = value?.trim();
  if (!secret) {
    throw new Error(`${name} is required for DevSpace OAuth. Run: devspace init`);
  }
  if (secret.length < 16) {
    throw new Error(`${name} must be at least 16 characters long.`);
  }
  return secret;
}

function parseOAuthConfig(env: NodeJS.ProcessEnv, ownerToken: string | undefined): OAuthConfig {
  return {
    ownerToken: parseRequiredSecret(env.DEVSPACE_OAUTH_OWNER_TOKEN ?? ownerToken, "DEVSPACE_OAUTH_OWNER_TOKEN"),
    accessTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS",
    ),
    refreshTokenTtlSeconds: parsePositiveInteger(
      env.DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      DEFAULT_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
      "DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS",
    ),
    scopes: parseStringList(env.DEVSPACE_OAUTH_SCOPES, ["devspace"]),
    allowedRedirectHosts: parseStringList(env.DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS, [
      "chatgpt.com",
      "localhost",
      "127.0.0.1",
    ]),
  };
}

function defaultStateDir(): string {
  return join(homedir(), ".local", "share", "devspace");
}

function defaultWorktreeRoot(): string {
  return join(homedir(), ".devspace", "worktrees");
}

function defaultAgentDir(): string {
  return join(homedir(), ".codex");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = loadDevspaceFiles(env);
  const host = env.HOST ?? files.config.host ?? "127.0.0.1";
  const port = parsePort(env.PORT ?? files.config.port);
  const publicBaseUrl = parsePublicBaseUrl(
    env.DEVSPACE_PUBLIC_BASE_URL ?? files.config.publicBaseUrl ?? localPublicBaseUrl(host, port),
  );
  const derivedAllowedHosts = [
    "localhost",
    "127.0.0.1",
    "::1",
    host,
    new URL(publicBaseUrl).hostname,
    ...(files.config.allowedHosts ?? []),
  ];

  return {
    host,
    port,
    authMode: parseAuthMode(env.DEVSPACE_AUTH_MODE, host),
    oauth: parseOAuthConfig(env, files.auth.ownerToken),
    allowedRoots: parseAllowedRoots(env.DEVSPACE_ALLOWED_ROOTS ?? files.config.allowedRoots),
    allowedHosts: parseAllowedHosts(env.DEVSPACE_ALLOWED_HOSTS, derivedAllowedHosts),
    publicBaseUrl,
    toolMode: parseToolMode(env),
    widgets: parseWidgetMode(env.DEVSPACE_WIDGETS),
    stateDir: resolve(expandHomePath(env.DEVSPACE_STATE_DIR ?? files.config.stateDir ?? defaultStateDir())),
    worktreeRoot: resolve(expandHomePath(env.DEVSPACE_WORKTREE_ROOT ?? files.config.worktreeRoot ?? defaultWorktreeRoot())),
    skillsEnabled: env.DEVSPACE_SKILLS === undefined ? true : parseBoolean(env.DEVSPACE_SKILLS),
    skillPaths: parsePathList(env.DEVSPACE_SKILL_PATHS),
    devspaceSkillsDir: devspaceSkillsDir(env),
    devspaceAgentsDir: devspaceAgentsDir(env),
    subagents:
      env.DEVSPACE_SUBAGENTS === undefined
        ? files.config.subagents === true
        : parseBoolean(env.DEVSPACE_SUBAGENTS),
    agentDir: resolve(expandHomePath(env.DEVSPACE_AGENT_DIR ?? files.config.agentDir ?? defaultAgentDir())),
    resources: parseResourceLimits(env),
    capabilities: parseCapabilityConfig(env),
    logging: parseLoggingConfig(env),
  };
}

function parsePublicBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

function localPublicBaseUrl(host: string, port: number): string {
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost = publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
  return `http://${formattedHost}:${port}`;
}
