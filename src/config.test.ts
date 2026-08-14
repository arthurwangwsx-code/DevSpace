import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { ensureDevspaceDefaultSkills, resolveSubagentsFlag } from "./user-config.js";

const emptyConfigDir = mkdtempSync(join(tmpdir(), "devspace-empty-config-test-"));
const baseEnv = {
  DEVSPACE_CONFIG_DIR: emptyConfigDir,
  DEVSPACE_ALLOWED_ROOTS: process.cwd(),
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

assert.equal(loadConfig(baseEnv).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "changes" }).widgets, "changes");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "full" }).widgets, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "off" }).widgets, "off");
assert.equal(loadConfig(baseEnv).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).authMode, "oauth");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_AUTH_MODE: "trusted-local" }).authMode, "trusted-local");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "minimal" }).toolMode, "minimal");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "full" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "codex" }).toolMode, "codex");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "0" }).toolMode, "full");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_MINIMAL_TOOLS: "1" }).toolMode, "minimal");
assert.equal(loadConfig(baseEnv).skillsEnabled, true);
assert.equal(loadConfig(baseEnv).devspaceSkillsDir, join(emptyConfigDir, "skills"));
assert.equal(loadConfig(baseEnv).devspaceAgentsDir, join(emptyConfigDir, "agents"));
assert.equal(loadConfig(baseEnv).subagents, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "0" }).skillsEnabled, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_SKILLS: "1" }).skillsEnabled, true);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_SUBAGENTS: "1" }).subagents,
  true,
);
assert.equal(resolveSubagentsFlag({}, {}), undefined);
assert.equal(resolveSubagentsFlag({ subagents: true }, {}), true);
assert.equal(resolveSubagentsFlag({ subagents: true }, { DEVSPACE_SUBAGENTS: "0" }), false);
assert.equal(resolveSubagentsFlag({}, { DEVSPACE_SUBAGENTS: "1" }), true);

const seededConfigDir = mkdtempSync(join(tmpdir(), "devspace-seeded-skills-test-"));
const seededSkillPaths = ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir });
assert.deepEqual(seededSkillPaths, [join(seededConfigDir, "skills", "subagent-delegation", "SKILL.md")]);
assert.equal(existsSync(seededSkillPaths[0]), true);
assert.match(readFileSync(seededSkillPaths[0], "utf8"), /name: subagent-delegation/);
assert.deepEqual(ensureDevspaceDefaultSkills({ DEVSPACE_CONFIG_DIR: seededConfigDir }), []);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "invalid" }),
  /Invalid DEVSPACE_WIDGETS: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "minimal" }),
  /Invalid DEVSPACE_WIDGETS: minimal/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_WIDGETS: "write-only" }),
  /Invalid DEVSPACE_WIDGETS: write-only/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_TOOL_MODE: "invalid" }),
  /Invalid DEVSPACE_TOOL_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_AUTH_MODE: "invalid" }),
  /Invalid DEVSPACE_AUTH_MODE: invalid/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_AUTH_MODE: "trusted-local", HOST: "0.0.0.0" }),
  /requires HOST to be a loopback address/,
);

assert.deepEqual(loadConfig(baseEnv).logging, {
  level: "info",
  format: "json",
  requests: true,
  assets: false,
  toolCalls: true,
  shellCommands: false,
  trustProxy: false,
});

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "silent" }).logging.level, "silent");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "error" }).logging.level, "error");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "warn" }).logging.level, "warn");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "info" }).logging.level, "info");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "debug" }).logging.level, "debug");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "json" }).logging.format, "json");
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "pretty" }).logging.format, "pretty");

assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_REQUESTS: "0" }).logging.requests, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_ASSETS: "1" }).logging.assets, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_TOOL_CALLS: "0" }).logging.toolCalls, false);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_LOG_SHELL_COMMANDS: "1" }).logging.shellCommands, true);
assert.equal(loadConfig({ ...baseEnv, DEVSPACE_TRUST_PROXY: "1" }).logging.trustProxy, true);

assert.deepEqual(loadConfig(baseEnv).resources, {
  mcpMaxSessions: 256,
  mcpMaxIdleSessions: 128,
  mcpSessionIdleTimeoutMs: 600_000,
  mcpSessionCleanupIntervalMs: 30_000,
  mcpMaxConcurrentRequests: 64,
  mcpMaxQueuedRequests: 128,
  mcpRequestQueueTimeoutMs: 30_000,
  mcpHeapSoftLimitRatio: 0.6,
  mcpHeapHardLimitRatio: 0.75,
  processMaxConcurrent: 16,
  processMaxSessions: 64,
  processBufferCharacters: 524_288,
});

assert.deepEqual(
  loadConfig({
    ...baseEnv,
    DEVSPACE_MCP_MAX_SESSIONS: "32",
    DEVSPACE_MCP_MAX_IDLE_SESSIONS: "16",
    DEVSPACE_MCP_SESSION_IDLE_TIMEOUT_SECONDS: "45",
    DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS: "5",
    DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: "8",
    DEVSPACE_MCP_MAX_QUEUED_REQUESTS: "0",
    DEVSPACE_MCP_REQUEST_QUEUE_TIMEOUT_MS: "250",
    DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT: "50",
    DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT: "70",
    DEVSPACE_PROCESS_MAX_CONCURRENT: "4",
    DEVSPACE_PROCESS_MAX_SESSIONS: "12",
    DEVSPACE_PROCESS_BUFFER_CHARACTERS: "4096",
  }).resources,
  {
    mcpMaxSessions: 32,
    mcpMaxIdleSessions: 16,
    mcpSessionIdleTimeoutMs: 45_000,
    mcpSessionCleanupIntervalMs: 5_000,
    mcpMaxConcurrentRequests: 8,
    mcpMaxQueuedRequests: 0,
    mcpRequestQueueTimeoutMs: 250,
    mcpHeapSoftLimitRatio: 0.5,
    mcpHeapHardLimitRatio: 0.7,
    processMaxConcurrent: 4,
    processMaxSessions: 12,
    processBufferCharacters: 4_096,
  },
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MCP_MAX_SESSIONS: "0" }),
  /Invalid DEVSPACE_MCP_MAX_SESSIONS: 0/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_MCP_MAX_SESSIONS: "4",
    DEVSPACE_MCP_MAX_IDLE_SESSIONS: "5",
  }),
  /must not exceed DEVSPACE_MCP_MAX_SESSIONS/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_MCP_HEAP_SOFT_LIMIT_PERCENT: "80",
    DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT: "75",
  }),
  /must be lower than DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT: "100" }),
  /Invalid DEVSPACE_MCP_HEAP_HARD_LIMIT_PERCENT: 100/,
);
assert.throws(
  () => loadConfig({
    ...baseEnv,
    DEVSPACE_PROCESS_MAX_CONCURRENT: "8",
    DEVSPACE_PROCESS_MAX_SESSIONS: "4",
  }),
  /must be at least DEVSPACE_PROCESS_MAX_CONCURRENT/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_LEVEL: "trace" }),
  /Invalid DEVSPACE_LOG_LEVEL: trace/,
);

assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_LOG_FORMAT: "color" }),
  /Invalid DEVSPACE_LOG_FORMAT: color/,
);

assert.equal(loadConfig(baseEnv).oauth.ownerToken, "test-owner-token-that-is-long-enough");
assert.deepEqual(loadConfig(baseEnv).oauth.scopes, ["devspace"]);
assert.deepEqual(loadConfig(baseEnv).oauth.allowedRedirectHosts, [
  "chatgpt.com",
  "localhost",
  "127.0.0.1",
]);
assert.equal(loadConfig(baseEnv).oauth.accessTokenTtlSeconds, 3600);
assert.equal(loadConfig(baseEnv).oauth.refreshTokenTtlSeconds, 2592000);

assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_SCOPES: "devspace,admin" }).oauth.scopes,
  ["devspace", "admin"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS: "chatgpt.com,example.com" }).oauth
    .allowedRedirectHosts,
  ["chatgpt.com", "example.com"],
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "120" }).oauth
    .accessTokenTtlSeconds,
  120,
);
assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS: "240" }).oauth
    .refreshTokenTtlSeconds,
  240,
);

assert.throws(
  () => loadConfig({ DEVSPACE_CONFIG_DIR: emptyConfigDir, DEVSPACE_ALLOWED_ROOTS: process.cwd() }),
  /DEVSPACE_OAUTH_OWNER_TOKEN is required/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_OWNER_TOKEN: "too-short" }),
  /DEVSPACE_OAUTH_OWNER_TOKEN must be at least 16 characters long/,
);
assert.throws(
  () => loadConfig({ ...baseEnv, DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }),
  /Invalid DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS: 0/,
);

assert.equal(loadConfig(baseEnv).publicBaseUrl, "http://127.0.0.1:7676");
assert.deepEqual(loadConfig(baseEnv).allowedHosts, ["localhost", "127.0.0.1", "::1"]);

assert.equal(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).publicBaseUrl,
  "https://abc.trycloudflare.com",
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_PUBLIC_BASE_URL: "https://abc.trycloudflare.com/" }).allowedHosts,
  ["localhost", "127.0.0.1", "::1", "abc.trycloudflare.com"],
);
assert.deepEqual(
  loadConfig({ ...baseEnv, DEVSPACE_ALLOWED_HOSTS: "*" }).allowedHosts,
  ["*"],
);

const configDir = mkdtempSync(join(tmpdir(), "devspace-config-test-"));
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    port: 8787,
    allowedRoots: [process.cwd()],
    publicBaseUrl: "https://devspace.example.com",
    subagents: true,
  }),
);
writeFileSync(
  join(configDir, "auth.json"),
  JSON.stringify({
    ownerToken: "persisted-owner-token-long-enough",
  }),
);

const fileConfig = loadConfig({ DEVSPACE_CONFIG_DIR: configDir });
assert.equal(fileConfig.port, 8787);
assert.equal(fileConfig.oauth.ownerToken, "persisted-owner-token-long-enough");
assert.equal(fileConfig.publicBaseUrl, "https://devspace.example.com");
assert.equal(fileConfig.subagents, true);
assert.deepEqual(fileConfig.allowedHosts, [
  "localhost",
  "127.0.0.1",
  "::1",
  "devspace.example.com",
]);
