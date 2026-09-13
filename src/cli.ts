#!/usr/bin/env node
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as prompts from "@clack/prompts";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import { satisfies } from "semver";
import { loadConfig } from "./config.js";
import { runLocalAgentProvider } from "./local-agent-adapters.js";
import {
  isLocalAgentProvider,
  loadLocalAgentProfiles,
  type LocalAgentProfile,
} from "./local-agent-profiles.js";
import {
  assertLocalAgentProviderAvailable,
  formatLocalAgentProviderAvailabilitySummary,
} from "./local-agent-availability.js";
import {
  formatAvailableLocalAgentTargets,
  parseLocalAgentRunArgs,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import { createLocalAgentStore, type LocalAgentRecord } from "./local-agent-store.js";
import type { LocalAgentRunResult } from "./local-agent-runtime.js";
import {
  ensureDevspaceDefaultSkills,
  generateOwnerToken,
  loadDevspaceFiles,
  resolveSubagentsFlag,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceUserConfig,
} from "./user-config.js";
import { expandHomePath } from "./roots.js";
import { shutdownHttpServer } from "./server-shutdown.js";
import { runMcpCanary } from "./mcp-canary.js";
import { installMcpProviderManifest, writeMcpProviderManifest } from "./capabilities/mcp-provider-manifest.js";
import {
  createChromeDevToolsManifest,
  findChromeDevToolsMcpCommand,
} from "./capabilities/providers/chrome-devtools-provider.js";

type Command = "serve" | "init" | "doctor" | "verify" | "config" | "agents" | "capabilities" | "providers" | "grants" | "help" | "version";
const require = createRequire(import.meta.url);
const SUPPORTED_NODE_RANGE = ">=20.12 <27";

async function main(argv: string[]): Promise<void> {
  assertSupportedNode();

  const [rawCommand, ...args] = argv;
  const command = normalizeCommand(rawCommand);

  switch (command) {
    case "serve":
      await ensureConfigured();
      await serve();
      return;
    case "init":
      await runInit({ force: args.includes("--force") });
      return;
    case "doctor":
      await runDoctor();
      return;
    case "verify":
      await runVerify(args);
      return;
    case "config":
      runConfigCommand(args);
      return;
    case "agents":
      await runAgentsCommand(args);
      return;
    case "capabilities":
      await runCapabilitiesCommand(args);
      return;
    case "providers":
      await runProvidersCommand(args);
      return;
    case "grants":
      await runGrantsCommand(args);
      return;
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
  }
}

function normalizeCommand(command: string | undefined): Command {
  if (!command || command === "serve" || command === "start") return "serve";
  if (command === "init" || command === "doctor" || command === "verify" || command === "config" || command === "agents" || command === "capabilities" || command === "providers" || command === "grants") return command;
  if (command === "help" || command === "--help" || command === "-h") return "help";
  if (command === "version" || command === "--version" || command === "-v") return "version";
  throw new Error(`Unknown command: ${command}`);
}

async function ensureConfigured(): Promise<void> {
  const files = loadDevspaceFiles();
  if (files.configExists && files.authExists) return;
  if (process.env.DEVSPACE_OAUTH_OWNER_TOKEN) return;

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      [
        "DevSpace is not configured and this terminal is non-interactive.",
        "",
        "Run:",
        "  devspace init",
        "",
        "Or provide DEVSPACE_OAUTH_OWNER_TOKEN and DEVSPACE_ALLOWED_ROOTS.",
      ].join("\n"),
    );
  }

  await runInit({ force: false });
}

async function runInit({ force }: { force: boolean }): Promise<void> {
  const files = loadDevspaceFiles();
  if (!force && files.configExists && files.authExists) {
    prompts.log.info(`DevSpace is already configured at ${files.dir}`);
    prompts.log.info("Run `devspace init --force` to update it.");
    return;
  }

  try {
    prompts.intro("DevSpace setup");

    const defaultRoots = files.config.allowedRoots?.join(", ") || process.cwd();
    const rootsAnswer = await textPrompt({
      message: `Where are your projects located? Press Enter to use ${defaultRoots}`,
      placeholder: defaultRoots,
      defaultValue: defaultRoots,
      validate: (value) => value?.trim() ? undefined : "Enter at least one project root.",
    });
    const allowedRoots = rootsAnswer
      .split(",")
      .map((root) => resolve(expandHomePath(root.trim())))
      .filter(Boolean);

    const defaultPort = String(files.config.port ?? 7676);
    const portAnswer = await textPrompt({
      message: `Which local port should DevSpace use? Press Enter to use ${defaultPort}`,
      placeholder: defaultPort,
      defaultValue: defaultPort,
      validate: validatePort,
    });
    const port = Number(portAnswer);

    prompts.note(
      [
        "DevSpace needs a public base URL so ChatGPT or Claude can reach this MCP server.",
        "Create a tunnel or reverse proxy with Cloudflare Tunnel, ngrok, Pinggy, Tailscale Funnel, or your own HTTPS proxy.",
        "Paste the public origin here, without /mcp.",
        "",
        "Example: https://your-tunnel-host.example.com",
      ].join("\n"),
      "Public URL required",
    );
    const publicBaseUrl = normalizePublicBaseUrl(await textPrompt({
      message: files.config.publicBaseUrl
        ? `What is the public base URL? Press Enter to keep ${files.config.publicBaseUrl}`
        : "What is the public base URL?",
      placeholder: files.config.publicBaseUrl ?? "https://your-tunnel-host.example.com",
      defaultValue: files.config.publicBaseUrl ?? "",
      validate: validateRequiredPublicBaseUrl,
    }));

    const config: DevspaceUserConfig = {
      host: files.config.host ?? "127.0.0.1",
      port,
      allowedRoots,
      publicBaseUrl,
      subagents: resolveSubagentsFlag(files.config),
    };
    const auth = {
      ownerToken: files.auth.ownerToken ?? generateOwnerToken(),
    };

    const configPath = writeDevspaceConfig(config);
    const authPath = writeDevspaceAuth(auth);
    const seededSkillPaths = config.subagents ? ensureDevspaceDefaultSkills() : [];

    const lines = [
      `Config: ${configPath}`,
      `Auth: ${authPath}`,
      ...seededSkillPaths.map((path) => `Default skill: ${path}`),
      `Local MCP URL: http://${config.host}:${config.port}/mcp`,
      ...(publicBaseUrl ? [`Public MCP URL: ${publicBaseUrl}/mcp`] : []),
    ];
    prompts.note(lines.join("\n"), "DevSpace configured");
    prompts.note(
      [
        `Owner password: ${auth.ownerToken}`,
        "Use this when ChatGPT or Claude asks you to approve DevSpace access.",
        `Stored at: ${authPath}`,
      ].join("\n"),
      "Owner password",
    );
    prompts.outro("Run `devspace serve` to start the MCP server.");
  } catch (error) {
    if (error instanceof SetupCancelledError) {
      prompts.cancel("Setup cancelled");
      return;
    }
    throw error;
  }
}

async function serve(): Promise<void> {
  const sqliteStatus = checkSqliteNative();
  if (sqliteStatus !== "ok") {
    throw new Error(
      [
        "better-sqlite3 could not load for this Node runtime.",
        sqliteStatus,
        "",
        "Try reinstalling or rebuilding dependencies under the active Node version:",
        "  npm rebuild better-sqlite3",
      ].join("\n"),
    );
  }

  const { createServer } = await import("./server.js");
  const config = loadConfig();
  const { app, close, localAgentProviders } = createServer(config);
  const httpServer = app.listen(config.port, config.host, () => {
    console.log(`devspace listening on http://${config.host}:${config.port}/mcp`);
    console.log(`public base url: ${config.publicBaseUrl}`);
    if (config.capabilities.enabled) {
      console.log(`capability MCP: ${new URL("/capabilities/mcp", config.publicBaseUrl)}`);
      console.log(`capability REST: ${new URL("/api/capabilities/v1", config.publicBaseUrl)}`);
    }
    console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`allowed hosts: ${config.allowedHosts.join(", ")}`);
    if (config.allowedHosts.includes("*")) {
      console.warn("warning: Host header allowlist is disabled because DEVSPACE_ALLOWED_HOSTS=*");
    }
    console.log(`auth: ${config.authMode === "oauth" ? "Owner password approval required" : "trusted local tunnel"}`);
    console.log(`logging: ${config.logging.level} ${config.logging.format}`);
    console.log(
      `mcp resources: sessions=${config.resources.mcpMaxSessions} idle=${config.resources.mcpMaxIdleSessions} requests=${config.resources.mcpMaxConcurrentRequests}+${config.resources.mcpMaxQueuedRequests}`,
    );
    console.log(
      `process resources: active=${config.resources.processMaxConcurrent} per-workspace=${config.resources.processMaxConcurrentPerWorkspace} retained=${config.resources.processMaxSessions} buffer=${config.resources.processBufferCharacters}`,
    );
    if (config.subagents) {
      console.log(`subagent providers: ${formatLocalAgentProviderAvailabilitySummary(localAgentProviders)}`);
    }
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHttpServer(httpServer, close);
    process.exit(0);
  };
  const handleShutdown = () => {
    void shutdown().catch((error) => {
      console.error("devspace shutdown failed", error);
      process.exit(1);
    });
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

async function runDoctor(): Promise<void> {
  const files = loadDevspaceFiles();
  console.log(`Config dir: ${files.dir}`);
  console.log(`Config file: ${files.configExists ? files.configPath : "missing"}`);
  console.log(`Auth file: ${files.authExists ? files.authPath : "missing"}`);
  console.log(`Node: ${process.version} (${nodeVersionStatus()})`);
  console.log(`Node ABI: ${process.versions.modules}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log(`Git: ${checkGitAvailable()}`);
  console.log(`Bash shell: ${checkBashShell()}`);
  console.log(`SQLite native dependency: ${checkSqliteNative()}`);

  try {
    const config = loadConfig();
    console.log(`Local MCP URL: http://${config.host}:${config.port}/mcp`);
    console.log(`Public MCP URL: ${new URL("/mcp", config.publicBaseUrl).toString()}`);
    console.log(`Capabilities: ${config.capabilities.enabled ? "enabled" : "disabled"}`);
    if (config.capabilities.enabled) {
      console.log(`Capability MCP URL: ${new URL("/capabilities/mcp", config.publicBaseUrl)}`);
      console.log(`Capability REST URL: ${new URL("/api/capabilities/v1", config.publicBaseUrl)}`);
      console.log(`Capability provider config: ${config.capabilities.configDir}`);
    }
    console.log(`Allowed roots: ${config.allowedRoots.join(", ")}`);
    console.log(`Allowed hosts: ${config.allowedHosts.join(", ")}`);
  } catch (error) {
    console.log(`Config status: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runVerify(args: string[]): Promise<void> {
  let url = "http://127.0.0.1:7676/mcp";
  let readPath: string | undefined;
  let timeoutMs = 15_000;
  let workspacePath: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--url" || argument === "--file" || argument === "--timeout-ms") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value`);
      if (argument === "--url") url = value;
      else if (argument === "--file") readPath = value;
      else timeoutMs = Number(value);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown verify option: ${argument}`);
    if (workspacePath) throw new Error("verify accepts at most one workspace path");
    workspacePath = argument;
  }

  const resolvedWorkspacePath = resolve(workspacePath ?? process.cwd());
  readPath ??= await findCanaryReadPath(resolvedWorkspacePath);
  const result = await runMcpCanary({
    url,
    workspacePath: resolvedWorkspacePath,
    readPath,
    timeoutMs,
  });
  console.log(JSON.stringify(result));
}

async function findCanaryReadPath(workspacePath: string): Promise<string> {
  for (const candidate of ["AGENTS.md", "README.md", "package.json", ".gitignore"]) {
    try {
      await access(join(workspacePath, candidate));
      return candidate;
    } catch {}
  }
  throw new Error("No small canary file found; pass --file <workspace-relative-path>.");
}

function runConfigCommand(args: string[]): void {
  const [subcommand, key, ...rest] = args;
  const files = loadDevspaceFiles();

  if (!subcommand || subcommand === "get") {
    console.log(JSON.stringify(files.config, null, 2));
    return;
  }

  if (subcommand !== "set") {
    throw new Error(`Unknown config command: ${subcommand}`);
  }
  if (key !== "publicBaseUrl") {
    throw new Error("Only `devspace config set publicBaseUrl <url|null>` is supported right now.");
  }

  const value = rest.join(" ").trim();
  if (!value) {
    throw new Error("Missing publicBaseUrl value.");
  }

  writeDevspaceConfig({
    ...files.config,
    publicBaseUrl: normalizeOptionalPublicBaseUrl(value),
  });
  console.log(`Updated ${files.configPath}`);
}

function printHelp(): void {
  console.log(
    [
      "DevSpace",
      "",
      "Usage:",
      "  devspace                 Run first-time setup if needed, then start the server",
      "  devspace serve           Start the server",
      "  devspace init            Create or update ~/.devspace/config.json and auth.json",
      "  devspace doctor          Show config, runtime, and native dependency status",
      "  devspace verify [path]   Run a real local MCP tool canary (use --url/--file to override)",
      "  devspace config get      Print persisted config",
      "  devspace config set publicBaseUrl <url|null>",
      "  devspace agents ls       List subagent sessions",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] <prompt>",
      "  devspace agents show <id>",
      "  devspace capabilities list|search|describe|open|call|status|cancel|close [options]",
      "  devspace providers list [--json]",
      "  devspace providers add-chrome [--command <absolute-path>]",
      "  devspace grants list|add|revoke [options]",
      "  devspace -v, --version   Print the installed version",
      "",
      "For temporary tunnels:",
      "  DEVSPACE_PUBLIC_BASE_URL=https://example.trycloudflare.com devspace serve",
    ].join("\n"),
  );
}

async function runCapabilitiesCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const options = capabilityCliOptions(rest);
  switch (subcommand) {
    case "list": {
      const query = new URLSearchParams();
      addQuery(query, "providerId", options.values.provider);
      addQuery(query, "tag", options.values.tag);
      addQuery(query, "cursor", options.values.cursor);
      addQuery(query, "limit", options.values.limit);
      if (options.flags.has("available-only")) query.set("availableOnly", "true");
      await printCapabilityResponse(await capabilityFetch(`/capabilities?${query}`, options), options);
      return;
    }
    case "search": {
      const query = options.positionals.join(" ").trim();
      if (!query) throw new Error("Usage: devspace capabilities search <query> [--json]");
      await printCapabilityResponse(await capabilityFetch("/capabilities/search", options, {
        query,
        filters: {
          providerIds: options.values.provider ? [options.values.provider] : undefined,
          tags: options.values.tag ? [options.values.tag] : undefined,
          availableOnly: options.flags.has("available-only") || undefined,
        },
        limit: numberOption(options.values.limit, "limit"),
      }), options);
      return;
    }
    case "describe": {
      const [capabilityId] = options.positionals;
      if (!capabilityId) throw new Error("Usage: devspace capabilities describe <capability-id>");
      await printCapabilityResponse(await capabilityFetch(`/capabilities/${encodeURIComponent(capabilityId)}`, options), options);
      return;
    }
    case "open": {
      const [providerId] = options.positionals;
      if (!providerId || !options.values.type) {
        throw new Error("Usage: devspace capabilities open <provider-id> --type TYPE --selector JSON");
      }
      await printCapabilityResponse(await capabilityFetch("/leases", options, {
        providerId,
        resourceType: options.values.type,
        selector: jsonOption(options.values.selector ?? "{}", "selector"),
        ttlSeconds: numberOption(options.values["ttl-seconds"], "ttl-seconds"),
      }), options);
      return;
    }
    case "call": {
      const [capabilityId] = options.positionals;
      if (!capabilityId) throw new Error("Usage: devspace capabilities call <capability-id> --arguments JSON");
      await printCapabilityResponse(await capabilityFetch("/invocations", options, {
        capabilityId,
        arguments: jsonOption(options.values.arguments ?? "{}", "arguments"),
        leaseId: options.values.lease,
        mode: options.flags.has("async") ? "async" : "sync",
        timeoutMs: numberOption(options.values["timeout-ms"], "timeout-ms"),
        idempotencyKey: options.values["idempotency-key"],
      }), options);
      return;
    }
    case "status": {
      const [invocationId] = options.positionals;
      const path = invocationId
        ? `/invocations/${encodeURIComponent(invocationId)}`
        : "/providers";
      await printCapabilityResponse(await capabilityFetch(path, options), options);
      return;
    }
    case "cancel": {
      const [invocationId] = options.positionals;
      if (!invocationId) throw new Error("Usage: devspace capabilities cancel <invocation-id>");
      await printCapabilityResponse(await capabilityFetch(
        `/invocations/${encodeURIComponent(invocationId)}/cancel`, options, {}, "POST",
      ), options);
      return;
    }
    case "close": {
      const [leaseId] = options.positionals;
      if (!leaseId) throw new Error("Usage: devspace capabilities close <lease-id>");
      await printCapabilityResponse(await capabilityFetch(
        `/leases/${encodeURIComponent(leaseId)}`, options, undefined, "DELETE",
      ), options);
      return;
    }
    case undefined:
    case "help":
    case "--help":
      printCapabilitiesHelp();
      return;
    default:
      throw new Error(`Unknown capabilities command: ${subcommand}`);
  }
}

async function runProvidersCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  if (subcommand === "add-chrome") {
    let command: string | undefined;
    if (rest.length > 0) {
      if (rest[0] !== "--command" || !rest[1] || rest.length !== 2) {
        throw new Error("Usage: devspace providers add-chrome [--command <absolute-path>]");
      }
      command = rest[1];
    }
    const config = loadConfig();
    const resolvedCommand = command
      ? findChromeDevToolsMcpCommand({ ...process.env, DEVSPACE_CHROME_MCP_COMMAND: command })
      : findChromeDevToolsMcpCommand();
    const target = writeMcpProviderManifest(createChromeDevToolsManifest(resolvedCommand), config.capabilities.configDir);
    console.log(JSON.stringify({
      installed: true,
      path: target,
      providerId: "browser.chrome.devtools",
      connection: "current-chrome-auto-connect",
      restartRequired: true,
    }));
    return;
  }
  if (subcommand === "add-mcp") {
    if (rest[0] !== "--manifest" || !rest[1] || rest.length !== 2) {
      throw new Error("Usage: devspace providers add-mcp --manifest <absolute-path>");
    }
    if (!isAbsolute(rest[1])) {
      throw new Error("The MCP provider manifest path must be absolute.");
    }
    const config = loadConfig();
    const target = installMcpProviderManifest(rest[1], config.capabilities.configDir);
    console.log(JSON.stringify({ installed: true, path: target, restartRequired: true }));
    return;
  }
  if (subcommand !== "list" && subcommand !== "ls") {
    throw new Error("Usage: devspace providers list [--json] | add-mcp --manifest <absolute-path> | add-chrome [--command <absolute-path>]");
  }
  const options = capabilityCliOptions(rest);
  await printCapabilityResponse(await capabilityFetch("/providers", options), options);
}

async function runGrantsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  const options = capabilityCliOptions(rest);
  if (subcommand === "list" || subcommand === "ls") {
    await printCapabilityResponse(await capabilityFetch("/grants", options), options);
    return;
  }
  if (subcommand === "add") {
    const principalId = options.values.principal;
    const capabilityPattern = options.values["capability-pattern"];
    const providerPattern = options.values["provider-pattern"];
    const effects = options.values.effects?.split(",").map((value) => value.trim()).filter(Boolean);
    if (!principalId || !capabilityPattern || !providerPattern || !effects?.length) {
      throw new Error("Usage: devspace grants add --principal ID --capability-pattern GLOB --provider-pattern GLOB --effects readOnly,openWorld [--resource-type TYPE] [--expires-at ISO]");
    }
    await printCapabilityResponse(await capabilityFetch("/grants", options, {
      id: options.values.id,
      principalId,
      capabilityPattern,
      providerPattern,
      allowedEffects: effects,
      resourceType: options.values["resource-type"],
      expiresAt: options.values["expires-at"],
    }), options);
    return;
  }
  if (subcommand === "revoke") {
    const [grantId] = options.positionals;
    if (!grantId) throw new Error("Usage: devspace grants revoke <grant-id>");
    await printCapabilityResponse(await capabilityFetch(
      `/grants/${encodeURIComponent(grantId)}`, options, undefined, "DELETE",
    ), options);
    return;
  }
  throw new Error("Usage: devspace grants list|add|revoke [options]");
}

interface ParsedCapabilityCliOptions {
  flags: Set<string>;
  values: Record<string, string | undefined>;
  positionals: string[];
}

function capabilityCliOptions(args: string[]): ParsedCapabilityCliOptions {
  const flags = new Set<string>();
  const values: Record<string, string | undefined> = {};
  const positionals: string[] = [];
  const valueOptions = new Set([
    "url", "provider", "tag", "cursor", "limit", "type", "selector", "ttl-seconds",
    "arguments", "lease", "timeout-ms", "idempotency-key",
    "id", "principal", "capability-pattern", "provider-pattern", "effects", "resource-type", "expires-at",
  ]);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (valueOptions.has(name)) {
      const value = args[++index];
      if (!value) throw new Error(`--${name} requires a value`);
      values[name] = value;
    } else if (["json", "available-only", "async"].includes(name)) {
      flags.add(name);
    } else {
      throw new Error(`Unknown capability option: --${name}`);
    }
  }
  return { flags, values, positionals };
}

async function capabilityFetch(
  path: string,
  options: ParsedCapabilityCliOptions,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
): Promise<unknown> {
  const config = loadConfig();
  const base = options.values.url
    ?? `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}/api/capabilities/v1`;
  const headers: Record<string, string> = {};
  const token = process.env.DEVSPACE_CAPABILITY_BEARER_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json() as unknown;
  if (!response.ok) {
    const message = typeof payload === "object" && payload
      && "error" in payload && typeof payload.error === "object" && payload.error
      && "code" in payload.error && "message" in payload.error
      ? `${String(payload.error.code)}: ${String(payload.error.message)}`
      : `Capability API returned HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload;
}

async function printCapabilityResponse(
  response: Promise<unknown> | unknown,
  options: ParsedCapabilityCliOptions,
): Promise<void> {
  const payload = await response;
  console.log(JSON.stringify(payload, null, options.flags.has("json") ? undefined : 2));
}

function addQuery(query: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined) query.set(key, value);
}

function numberOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`--${name} must be an integer`);
  return parsed;
}

function jsonOption(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`--${name} must be valid JSON`);
  }
}

function printCapabilitiesHelp(): void {
  console.log([
    "DevSpace capabilities",
    "",
    "Commands: list, search, describe, open, call, status, cancel, close",
    "Common options: --url URL --json",
    "OAuth mode: set DEVSPACE_CAPABILITY_BEARER_TOKEN for a capability-resource token.",
  ].join("\n"));
}

async function runAgentsCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "ls":
    case "list":
      await runAgentsList();
      return;
    case "run":
      await runAgentsRun(rest);
      return;
    case "show":
      await runAgentsShow(rest);
      return;
    case "__worker":
      await runAgentsWorker(rest);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printAgentsHelp();
      return;
    default:
      throw new Error(`Unknown agents command: ${subcommand}`);
  }
}

async function runAgentsList(): Promise<void> {
  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const agents = store.list(resolveCurrentWorkspaceScope());

  if (agents.length === 0) {
    console.log("No subagent sessions found for this workspace.");
    return;
  }

  for (const agent of agents) {
    console.log(formatAgentLine(agent));
  }
}

async function runAgentsRun(args: string[]): Promise<void> {
  const parsed = parseLocalAgentRunArgs(args);

  const config = loadConfig();
  const workspaceRoot = resolveCurrentWorkspaceRoot();
  const store = createLocalAgentStore(config);
  const existing = store.get(parsed.target);

  if (existing) {
    if (!isLocalAgentProvider(existing.provider)) {
      throw new Error(`Unknown subagent provider for existing session: ${existing.provider}`);
    }
    assertLocalAgentProviderAvailable(existing.provider);
    const promptFile = writeAgentPromptFile(parsed.prompt);
    store.update(existing.id, {
      status: "starting",
      model: parsed.model ?? existing.model,
      thinking: parsed.thinking ?? existing.thinking,
      latestResponse: undefined,
      error: undefined,
    });
    spawnAgentWorker(existing.id, promptFile);
    console.log(formatAgentLine({
      ...existing,
      status: "running",
      model: parsed.model ?? existing.model,
      thinking: parsed.thinking ?? existing.thinking,
    }));
    return;
  }

  const profiles = await loadLocalAgentProfiles(config, workspaceRoot);
  const target = resolveLocalAgentTarget(parsed.target, profiles, parsed.model, parsed.thinking);
  if (!target) {
    throw new Error(
      `Unknown subagent profile, provider, or id: ${parsed.target}. Available ${formatAvailableLocalAgentTargets(profiles)}`,
    );
  }
  assertLocalAgentProviderAvailable(target.provider);

  const promptFile = writeAgentPromptFile(parsed.prompt);
  const record = store.create({
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot,
    profileName: target.name,
    provider: target.provider,
    model: target.model,
    thinking: target.thinking,
  });

  spawnAgentWorker(record.id, promptFile);
  console.log(formatAgentLine({ ...record, status: "running" }));
}

async function runAgentsShow(args: string[]): Promise<void> {
  const [id] = args;
  if (!id) throw new Error("Usage: devspace agents show <id>");

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  let record = store.get(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  const deadline = Date.now() + 15_000;
  while ((record.status === "starting" || record.status === "running") && Date.now() < deadline) {
    await sleep(500);
    record = store.get(id) ?? record;
  }

  console.log(formatAgentLine(record));
  if (record.latestResponse) {
    console.log(record.latestResponse);
    return;
  }
  if (record.error) {
    console.log(record.error);
    return;
  }
  if (record.status === "starting" || record.status === "running") {
    console.log(`No final response yet. Call \`devspace agents show ${record.id}\` again later.`);
  }
}

async function runAgentsWorker(args: string[]): Promise<void> {
  const [id, promptFileFlag, promptFile] = args;
  if (!id || promptFileFlag !== "--prompt-file" || !promptFile) {
    throw new Error("Usage: devspace agents __worker <id> --prompt-file <path>");
  }

  const config = loadConfig();
  const store = createLocalAgentStore(config);
  const record = store.get(id);
  if (!record) throw new Error(`Unknown subagent id: ${id}`);

  store.update(record.id, { status: "running", error: undefined });
  try {
    const profiles = await loadLocalAgentProfiles(config, record.workspaceRoot);
    const profile = profiles.find((candidate) => candidate.name === record.profileName);
    const prompt = await readFile(promptFile, "utf8");
    const result = profile
      ? await runLocalAgentProfile(profile, record, prompt)
      : await runRawLocalAgentProvider(record, prompt);
    store.update(record.id, {
      providerSessionId: result.providerSessionId ?? undefined,
      status: "idle",
      latestResponse: result.finalResponse,
      error: undefined,
    });
  } catch (error) {
    store.update(record.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runLocalAgentProfile(
  profile: LocalAgentProfile,
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  const body = profile.body.trim();
  const fullPrompt = body ? `${body}\n\nTask:\n${prompt}` : prompt;
  return runLocalAgentProvider(profile.provider, {
    prompt: fullPrompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model ?? profile.model,
    thinking: record.thinking ?? profile.thinking,
  });
}

async function runRawLocalAgentProvider(
  record: LocalAgentRecord,
  prompt: string,
): Promise<LocalAgentRunResult> {
  if (record.profileName !== record.provider || !isLocalAgentProvider(record.provider)) {
    throw new Error(`Subagent profile not found: ${record.profileName}`);
  }

  return runLocalAgentProvider(record.provider, {
    prompt,
    workspace: record.workspaceRoot,
    providerSessionId: record.providerSessionId,
    writeMode: "allowed",
    model: record.model,
    thinking: record.thinking,
  });
}

function spawnAgentWorker(agentId: string, promptFile: string): void {
  const child = spawn(process.execPath, [
    ...process.execArgv,
    fileURLToPath(import.meta.url),
    "agents",
    "__worker",
    agentId,
    "--prompt-file",
    promptFile,
  ], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function writeAgentPromptFile(prompt: string): string {
  const directory = mkdtempSync(join(tmpdir(), "devspace-agent-prompt-"));
  const filePath = join(directory, "prompt.txt");
  writeFileSync(filePath, prompt, { mode: 0o600 });
  return filePath;
}

function resolveCurrentWorkspaceRoot(): string {
  return resolve(process.env.DEVSPACE_WORKSPACE_ROOT || process.cwd());
}

function resolveCurrentWorkspaceScope(): { workspaceId?: string; workspaceRoot: string } {
  return {
    workspaceId: process.env.DEVSPACE_WORKSPACE_ID,
    workspaceRoot: resolveCurrentWorkspaceRoot(),
  };
}

function formatAgentLine(agent: Pick<
  LocalAgentRecord,
  "id" | "status" | "profileName" | "provider" | "model" | "thinking"
>): string {
  const model = agent.model ? ` ${agent.model}` : "";
  const thinking = agent.thinking ? ` thinking=${agent.thinking}` : "";
  return `${agent.id} ${agent.status} ${agent.profileName} ${agent.provider}${model}${thinking}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function printAgentsHelp(): void {
  console.log(
    [
      "DevSpace agents",
      "",
      "Usage:",
      "  devspace agents ls",
      "  devspace agents run <profile-or-provider-or-id> [--model <model>] [--thinking <level>] <prompt>",
      "  devspace agents show <id>",
    ].join("\n"),
  );
}

function printVersion(): void {
  const packageJson = require("../package.json") as { version?: unknown };
  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read DevSpace package version.");
  }

  console.log(packageJson.version);
}

function normalizeOptionalPublicBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "none") return null;

  return normalizePublicBaseUrl(trimmed);
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim();
  const parsed = new URL(trimmed);
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

type TextPromptOptions = Omit<Parameters<typeof prompts.text>[0], "validate"> & {
  defaultValue: string;
  validate?: (value: string | undefined) => string | Error | undefined;
};

async function textPrompt(options: TextPromptOptions): Promise<string> {
  const result = await prompts.text({
    ...options,
    validate: (value) => options.validate?.(value?.trim() ? value : options.defaultValue),
  });
  if (prompts.isCancel(result)) throw new SetupCancelledError();
  const value = String(result).trim();
  return value || options.defaultValue;
}

function validatePort(value: string | undefined): string | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? undefined
    : "Enter a port between 1 and 65535.";
}

function validateRequiredPublicBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "Enter the public URL from your tunnel or reverse proxy.";
  if (trimmed.endsWith("/mcp")) return "Enter the base URL only, without /mcp.";
  return validatePublicBaseUrl(trimmed);
}

function validatePublicBaseUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "Use an http or https URL.";
  } catch {
    return "Enter a valid URL, for example https://your-tunnel-host.example.com.";
  }
}

function assertSupportedNode(): void {
  if (satisfies(process.versions.node, SUPPORTED_NODE_RANGE)) return;

  throw new Error(
    [
      `DevSpace requires Node ${SUPPORTED_NODE_RANGE}.`,
      `Current Node: ${process.version}`,
      "",
      "Install Node 22 LTS or use a version manager such as nvm, fnm, or mise.",
    ].join("\n"),
  );
}

function nodeVersionStatus(): string {
  return satisfies(process.versions.node, SUPPORTED_NODE_RANGE)
    ? `supported ${SUPPORTED_NODE_RANGE}`
    : `unsupported, requires ${SUPPORTED_NODE_RANGE}`;
}

class SetupCancelledError extends Error {}

function checkSqliteNative(): string {
  try {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.close();
    return "ok";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function checkGitAvailable(): string {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

function checkBashShell(): string {
  try {
    const { shell, args } = getShellConfig();
    return `${shell} ${args.join(" ")}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unavailable (${message})`;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
