#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { waitForHttpServerListening } from "../src/server-shutdown.js";

const execFileAsync = promisify(execFile);
const command = findExecutable(process.env.DEVSPACE_REAL_MCP_COMMAND || "chrome-devtools-mcp");
const version = (await execFileAsync(command, ["--version"], { timeout: 10_000 })).stdout.trim();
const outputRoot = resolve(process.env.DEVSPACE_REAL_MCP_OUTPUT || ".build/real-mcp-mount");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(outputRoot, runId);
await mkdir(artifactDir, { recursive: true });
const fixtureRoot = mkdtempSync(join(os.tmpdir(), "devspace-real-mcp-mount-"));
const providerDirectory = join(fixtureRoot, "providers");
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
  DEVSPACE_STATE_DIR: join(fixtureRoot, "state"),
  DEVSPACE_ALLOWED_ROOTS: fixtureRoot,
  DEVSPACE_OAUTH_OWNER_TOKEN: "real-mcp-mount-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_CAPABILITY_CONFIG_DIR: providerDirectory,
  DEVSPACE_LOG_LEVEL: "silent",
});
const running = createServer(config);
const server = running.app.listen(0, "127.0.0.1");
let client: Client | undefined;
let capabilityCount = 0;
let baselineChildCount = 0;
let childCountAfterInstall = 0;
let childCountAfterRemove = -1;
let catalogRevisionAfterInstall = 0;
let catalogRevisionAfterRemove = 0;
let failure: string | undefined;

try {
  await waitForHttpServerListening(server);
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}/api/capabilities/v1`;
  client = new Client({ name: "real-mcp-mount", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/capabilities/mcp`)));
  assert.equal((await client.listTools()).tools.length, 8);
  const baselineChildren = new Set(descendants(process.pid));
  baselineChildCount = baselineChildren.size;

  const manifest = {
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: "test.real.chrome-devtools", title: "Real Chrome DevTools MCP" },
    spec: {
      enabled: true,
      transport: {
        type: "stdio",
        command,
        args: [
          "--browserUrl=http://127.0.0.1:9",
          "--no-performance-crux",
          "--no-usage-statistics",
        ],
      },
      discoverAllTools: true,
      discoveredToolVersion: "1.0.0",
    },
  };
  const installed = await invokeManagement(client, "devspace.providers.install", { manifest });
  assert.equal(installed.status, "succeeded");
  capabilityCount = numberField(installed.result, "capabilityCount");
  catalogRevisionAfterInstall = numberField(installed.result, "catalogRevision");
  assert.ok(capabilityCount >= 20, `expected a substantial real tool catalog, received ${capabilityCount}`);
  const providerChildren = new Set(descendants(process.pid).filter((pid) => !baselineChildren.has(pid)));
  childCountAfterInstall = providerChildren.size;
  assert.ok(childCountAfterInstall >= 1, "real MCP child process was not observed");

  const catalog = await getJson(`${base}/capabilities?providerId=test.real.chrome-devtools&limit=200`);
  assert.equal(catalog.response.status, 200);
  assert.equal(catalog.body.data.items.length, capabilityCount);
  assert.ok(catalog.body.data.items.some((entry: { id?: string }) => entry.id === "test.real.chrome-devtools.list_pages"));
  const searched = await client.callTool({
    name: "capability_search",
    arguments: { query: "Chrome page snapshot", providerIds: ["test.real.chrome-devtools"], limit: 10 },
  });
  assert.match(JSON.stringify(searched.structuredContent), /take_snapshot/);

  const disabled = await postJson(`${base}/admin/providers/test.real.chrome-devtools/actions`, { action: "disable" });
  assert.equal(disabled.response.status, 200);
  assert.equal(disabled.body.data.enabled, false);
  const enabled = await invokeManagement(client, "devspace.providers.control", {
    providerId: "test.real.chrome-devtools",
    action: "enable",
  });
  assert.equal(enabled.status, "succeeded");
  collectProviderChildren(providerChildren, baselineChildren);
  const reloaded = await invokeManagement(client, "devspace.providers.control", {
    providerId: "test.real.chrome-devtools",
    action: "reload",
  });
  assert.equal(reloaded.status, "succeeded");
  collectProviderChildren(providerChildren, baselineChildren);
  assert.equal(numberField(reloaded.result, "capabilityCount"), capabilityCount);
  assert.equal((await client.listTools()).tools.length, 8);

  const removed = await invokeManagement(client, "devspace.providers.remove", {
    providerId: "test.real.chrome-devtools",
  });
  assert.equal(removed.status, "succeeded");
  catalogRevisionAfterRemove = numberField(removed.result, "catalogRevision");
  assert.ok(catalogRevisionAfterRemove > catalogRevisionAfterInstall);
  await waitForPidsExit([...providerChildren], 5_000);
  childCountAfterRemove = [...providerChildren].filter(pidIsAlive).length;
  assert.equal(childCountAfterRemove, 0);
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  await running.close();
  rmSync(fixtureRoot, { recursive: true, force: true });
}

const report = {
  ok: failure === undefined,
  providerPackage: basename(command),
  providerVersion: version,
  fixedOuterToolCount: 8,
  capabilityCount,
  baselineChildCount,
  childCountAfterInstall,
  childCountAfterRemove,
  catalogRevisionAfterInstall,
  catalogRevisionAfterRemove,
  ...(failure ? { failure } : {}),
};
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ...report, artifactDir }));

async function invokeManagement(clientValue: Client, capabilityId: string, argumentsValue: unknown) {
  const response = await clientValue.callTool({
    name: "capability_invoke",
    arguments: { capabilityId, arguments: argumentsValue },
  });
  assert.equal(response.isError, undefined, JSON.stringify(response.structuredContent));
  const envelope = response.structuredContent as { data?: unknown };
  assert.ok(envelope.data && typeof envelope.data === "object");
  return envelope.data as { status?: string; result?: unknown };
}

async function getJson(url: string) {
  const response = await fetch(url);
  return { response, body: await response.json() as any };
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}

function numberField(value: unknown, field: string): number {
  assert.ok(value && typeof value === "object" && field in value);
  const result = (value as Record<string, unknown>)[field];
  assert.equal(typeof result, "number");
  return result as number;
}

function findExecutable(value: string): string {
  if (isAbsolute(value)) { accessSync(value, constants.X_OK); return value; }
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, value);
    try { accessSync(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`${value} is not installed; run npm install -g chrome-devtools-mcp@latest`);
}

function descendants(parentPid: number): number[] {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim().split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (!match || basename(match[3]!) === "ps") return [];
      return [{ pid: Number(match[1]), ppid: Number(match[2]) }];
    });
  const result = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const { pid, ppid } of rows) {
      if ((ppid === parentPid || result.has(ppid)) && !result.has(pid)) {
        result.add(pid); changed = true;
      }
    }
  }
  return [...result];
}

function collectProviderChildren(target: Set<number>, baseline: Set<number>): void {
  for (const pid of descendants(process.pid)) {
    if (!baseline.has(pid)) target.add(pid);
  }
}

async function waitForPidsExit(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !pidIsAlive(pid))) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`real MCP Provider processes remained after ${timeoutMs} ms`);
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function renderMarkdown(value: typeof report): string {
  return `# Real MCP mount acceptance\n\n- Result: ${value.ok ? "PASS" : "FAIL"}\n- Provider: ${value.providerPackage} ${value.providerVersion}\n- Fixed outer tools: ${value.fixedOuterToolCount}\n- Discovered capabilities: ${value.capabilityCount}\n- Baseline child processes: ${value.baselineChildCount}\n- Provider processes after install/remove: ${value.childCountAfterInstall}/${value.childCountAfterRemove}\n- Catalog revisions install/remove: ${value.catalogRevisionAfterInstall}/${value.catalogRevisionAfterRemove}\n${value.failure ? `- Failure: ${value.failure}\n` : ""}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
