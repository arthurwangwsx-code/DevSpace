#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (process.platform !== "darwin") {
  console.log(JSON.stringify({ supported: false, platform: process.platform }));
  process.exit(0);
}

const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
await mkdir(artifactDir, { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
let report: Record<string, unknown>;

try {
  const initialHealth = await health(options.healthUrl);
  assert.equal(initialHealth.ok, true, "production service must be healthy before self-activation");
  const oldPid = numberAt(initialHealth, "release", "pid");
  const sourceCommit = (await git("rev-parse", "--short=12", "HEAD")).trim();

  const submission = await submitActivation();
  assert.equal(submission.exitCode, 0, submission.output);
  const activation = parseActivation(submission.output);
  assert.equal(activation.installed, true);
  assert.equal(activation.activated, true);
  assert.match(String(activation.releaseId), new RegExp(`\\+${sourceCommit}$`));

  const transitionStarted = performance.now();
  let unavailableSamples = 0;
  let recoveredHealth: Record<string, unknown> | undefined;
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const candidate = await health(options.healthUrl, 500);
      if (candidate.ok === true
        && numberAt(candidate, "release", "pid") !== oldPid
        && stringAt(candidate, "release", "sourceCommit") === sourceCommit) {
        recoveredHealth = candidate;
        break;
      }
    } catch {
      unavailableSamples += 1;
    }
    await delay(50);
  }
  assert.ok(recoveredHealth, `service did not recover current source within ${options.timeoutMs}ms`);

  const activationStatus = await waitForActivationStatus(
    String(activation.activationStatusPath),
    String(activation.activationId),
    deadline,
  );
  assert.equal(activationStatus.state, "ready", JSON.stringify(activationStatus));
  assert.equal(object(activationStatus.health).ok, true);

  const postCanary = await productionCanary();
  assert.equal(postCanary.exitCode, 0, postCanary.output);
  const reportedWorkingDirectory = postCanary.output.split("\n").find((line) => line.startsWith("/"));
  assert.equal(resolve(reportedWorkingDirectory ?? ""), options.workspace);

  report = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: round(performance.now() - started),
    sourceCommit,
    endpoint: options.mcpUrl.href,
    oldPid,
    newPid: numberAt(recoveredHealth, "release", "pid"),
    transitionMs: round(performance.now() - transitionStarted),
    unavailableSamples,
    activation,
    activationStatus,
    postCanary,
  };
} catch (error) {
  report = {
    ok: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: round(performance.now() - started),
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  };
}

await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report), { mode: 0o600 });
console.log(JSON.stringify({ ok: report.ok, artifactDir, oldPid: report.oldPid, newPid: report.newPid }));
if (!report.ok) process.exitCode = 1;

async function submitActivation() {
  return withClient(async (client) => {
    const workspaceId = await openWorkspace(client);
    const command = `npm run install:macos-service -- --label ${options.label} --activate`;
    const result = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId, cmd: command, yieldTimeMs: 10_000 },
    }, undefined, { timeout: 20_000 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const structured = object(result.structuredContent);
    return {
      exitCode: Number(structured.exitCode),
      wallTimeMs: Number(structured.wallTimeMs),
      output: String(structured.result ?? ""),
    };
  });
}

async function productionCanary() {
  return withClient(async (client) => {
    const tools = await client.listTools();
    assert.ok(tools.tools.some(({ name }) => name === "exec_command"), "production MCP must expose exec_command");
    const workspaceId = await openWorkspace(client);
    const result = await client.callTool({
      name: "exec_command",
      arguments: { workspaceId, cmd: "pwd", yieldTimeMs: 1_000 },
    }, undefined, { timeout: 15_000 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const structured = object(result.structuredContent);
    return { exitCode: Number(structured.exitCode), output: String(structured.result ?? "") };
  });
}

async function openWorkspace(client: Client): Promise<string> {
  const result = await client.callTool({
    name: "open_workspace",
    arguments: { path: options.workspace },
  }, undefined, { timeout: 15_000 });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return String(object(result.structuredContent).workspaceId);
}

async function withClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "devspace-service-self-activation", version: "1" });
  const transport = new StreamableHTTPClientTransport(options.mcpUrl);
  try {
    await client.connect(transport);
    return await operation(client);
  } finally {
    await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

async function waitForActivationStatus(path: string, activationId: string, deadline: number) {
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    try {
      last = object(JSON.parse(await readFile(resolve(path), "utf8")));
      if (last.activationId === activationId && (last.state === "ready" || last.state === "failed")) return last;
    } catch {}
    await delay(50);
  }
  throw new Error(`activation status did not finish: ${JSON.stringify(last)}`);
}

async function health(url: URL, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  assert.equal(response.ok, true, `health returned HTTP ${response.status}`);
  return object(await response.json());
}

function parseActivation(output: string): Record<string, unknown> {
  for (const line of output.trim().split("\n").reverse()) {
    if (!line.startsWith("{") || !line.includes('"activationId"')) continue;
    return object(JSON.parse(line));
  }
  throw new Error(`activation result missing from command output: ${output.slice(-2_000)}`);
}

async function git(...args: string[]): Promise<string> {
  return new Promise((resolveOutput, reject) => execFile("git", args, { cwd: options.workspace }, (error, stdout) => {
    if (error) reject(error);
    else resolveOutput(stdout);
  }));
}

function parseOptions(args: string[]) {
  let workspace = resolve(process.cwd());
  let mcpUrl = new URL("http://127.0.0.1:7676/mcp");
  let healthUrl = new URL("http://127.0.0.1:7676/healthz");
  let label = `com.devspace.${process.getuid?.() ?? 0}.7676`;
  let outputRoot = resolve(".build/macos-service-self-activation");
  let timeoutMs = 45_000;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--workspace") workspace = resolve(value);
    else if (key === "--mcp-url") mcpUrl = loopbackUrl(value, "/mcp");
    else if (key === "--health-url") healthUrl = loopbackUrl(value, "/healthz");
    else if (key === "--label") label = value;
    else if (key === "--output") outputRoot = resolve(value);
    else if (key === "--timeout-ms") timeoutMs = Number(value);
    else throw new Error(`unknown option: ${key}`);
  }
  assert.match(label, /^[A-Za-z0-9._-]+$/, "label contains unsupported characters");
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 5_000 && timeoutMs <= 300_000, "timeout-ms is out of range");
  return { workspace, mcpUrl, healthUrl, label, outputRoot, timeoutMs };
}

function loopbackUrl(value: string, expectedPath: string): URL {
  const url = new URL(value);
  assert.equal(url.protocol, "http:", "service transition test only accepts loopback HTTP");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "service transition test only accepts loopback hosts");
  assert.equal(url.pathname, expectedPath);
  return url;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
  return value as Record<string, unknown>;
}

function numberAt(value: Record<string, unknown>, parent: string, key: string): number {
  const result = object(value[parent])[key];
  assert.equal(typeof result, "number", `${parent}.${key} must be a number`);
  return result;
}

function stringAt(value: Record<string, unknown>, parent: string, key: string): string {
  const result = object(value[parent])[key];
  assert.equal(typeof result, "string", `${parent}.${key} must be a string`);
  return result;
}

function renderMarkdown(value: Record<string, unknown>): string {
  return `# macOS service self-activation\n\n- Result: ${value.ok ? "PASS" : "FAIL"}\n- Started: ${value.startedAt}\n- Finished: ${value.finishedAt}\n- Duration ms: ${value.durationMs}\n- Old PID: ${value.oldPid ?? "n/a"}\n- New PID: ${value.newPid ?? "n/a"}\n- Error: ${value.error ?? "none"}\n`;
}

function round(value: number): number { return Math.round(value * 100) / 100; }
