#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SystemSessionStateProbe } from "../src/capabilities/session-state.js";
import { StressMetrics } from "../src/stress/metrics.js";

const execFileAsync = promisify(execFile);
const PROVIDER_ID = "desktop.macos.accessibility";
const STATUS_CAPABILITY = "desktop.macos.status";
const FIXED_TOOLS = [
  "capability_list", "capability_search", "capability_describe", "capability_open",
  "capability_invoke", "capability_status", "capability_cancel", "capability_close",
].sort();
const DESKTOP_CAPABILITIES = [
  "desktop.macos.activate_app", "desktop.macos.click_point", "desktop.macos.list_apps",
  "desktop.macos.press_key", "desktop.macos.screenshot_app", "desktop.macos.snapshot_app",
  "desktop.macos.status", "desktop.macos.type_text",
].sort();

const options = parseOptions(process.argv.slice(2));
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(options.outputRoot, runId);
const metrics = new StressMetrics();
const steps: Array<{ name: string; passed: boolean; details?: Record<string, unknown> }> = [];
const providerPids = new Set<number>();
let session: Awaited<ReturnType<SystemSessionStateProbe["probe"]>> | undefined;
let providerHealth: Record<string, unknown> | undefined;
let permissionStatus: { accessibilityTrusted: boolean; screenCaptureGranted: boolean } | undefined;
let rssStartKiB: number | undefined;
let rssEndKiB: number | undefined;
let recovery: { oldPid: number; newPid: number; oldPidExited: boolean } | undefined;
let client: Client | undefined;
let failure: string | undefined;

try {
  session = await new SystemSessionStateProbe().probe(new AbortController().signal);
  const providerEnvelope = await fetchJson(`/providers/${encodeURIComponent(PROVIDER_ID)}`);
  providerHealth = object(object(providerEnvelope).data).health as Record<string, unknown>;
  assert.ok(["ready", "degraded"].includes(String(providerHealth.state)),
    `desktop Provider is ${String(providerHealth.state)}`);
  steps.push({ name: "provider_online", passed: true, details: { state: providerHealth.state } });

  const catalogEnvelope = await fetchJson(`/capabilities?providerId=${encodeURIComponent(PROVIDER_ID)}&limit=200`);
  const catalogData = object(object(catalogEnvelope).data);
  const ids = array(catalogData.items).map((item) => String(object(item).id)).sort();
  assert.deepEqual(ids, DESKTOP_CAPABILITIES);
  steps.push({ name: "desktop_catalog_exact", passed: true, details: { capabilityCount: ids.length } });

  const mcpUrl = new URL("/capabilities/mcp", options.baseUrl);
  client = new Client({ name: "devspace-desktop-provider-performance", version: "1.0.0" });
  await metrics.measure("mcp.connect", () => client!.connect(new StreamableHTTPClientTransport(mcpUrl)));
  const tools = await metrics.measure("mcp.list_tools", () => client!.listTools());
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), FIXED_TOOLS);
  steps.push({ name: "fixed_mcp_contract", passed: true, details: { toolCount: tools.tools.length } });

  for (let index = 0; index < options.restSamples; index++) {
    const status = await metrics.measure("rest.desktop_status", invokeRestStatus);
    rememberStatus(status);
    if (index === 0) rssStartKiB = await processRssKiB(status.processId);
  }
  steps.push({ name: "rest_status_samples", passed: true, details: { count: options.restSamples } });

  for (let index = 0; index < options.mcpSamples; index++) {
    const status = await metrics.measure("mcp.desktop_status", invokeMcpStatus);
    rememberStatus(status);
  }
  steps.push({ name: "mcp_status_samples", passed: true, details: { count: options.mcpSamples } });

  assert.equal(providerPids.size, 1, `desktop Provider PID changed: ${[...providerPids].join(",")}`);
  const providerPid = [...providerPids][0]!;
  rssEndKiB = await processRssKiB(providerPid);
  steps.push({ name: "provider_pid_stable", passed: true, details: { providerPid } });

  const unavailable = new Set(array(providerHealth.unavailablePermissions ?? []).map(String));
  const expectedUnavailable = new Set<string>();
  if (!permissionStatus!.accessibilityTrusted) expectedUnavailable.add("macos.accessibility");
  if (!permissionStatus!.screenCaptureGranted) expectedUnavailable.add("macos.screen-capture");
  assert.deepEqual([...unavailable].sort(), [...expectedUnavailable].sort());
  assert.equal(providerHealth.state, expectedUnavailable.size === 0 ? "ready" : "degraded");
  steps.push({
    name: "permission_health_consistent",
    passed: true,
    details: { unavailablePermissions: [...expectedUnavailable].sort() },
  });

  const reportMetrics = metrics.report();
  assert.ok(reportMetrics.operations["rest.desktop_status"]!.p95Ms <= options.restP95GateMs);
  assert.ok(reportMetrics.operations["mcp.desktop_status"]!.p95Ms <= options.mcpP95GateMs);
  const rssGrowthKiB = rssStartKiB === undefined || rssEndKiB === undefined ? undefined : rssEndKiB - rssStartKiB;
  assert.ok(rssGrowthKiB === undefined || rssGrowthKiB <= options.rssGrowthGateKiB,
    `desktop Provider RSS grew by ${rssGrowthKiB} KiB`);
  steps.push({
    name: "latency_and_rss_gates",
    passed: true,
    details: {
      restP95Ms: reportMetrics.operations["rest.desktop_status"]!.p95Ms,
      mcpP95Ms: reportMetrics.operations["mcp.desktop_status"]!.p95Ms,
      rssGrowthKiB,
    },
  });

  if (options.reloadProvider) {
    const reload = await metrics.measure("mcp.reload_provider", () => client!.callTool({
      name: "capability_invoke",
      arguments: {
        capabilityId: "devspace.providers.control",
        arguments: { providerId: PROVIDER_ID, action: "reload" },
        mode: "sync",
      },
    }));
    assert.equal(reload.isError, undefined);
    assert.equal(object(object(reload.structuredContent).data).status, "succeeded");
    const recoveredStatus = await metrics.measure("rest.desktop_status_after_reload", invokeRestStatus);
    assert.notEqual(recoveredStatus.processId, providerPid, "desktop Provider kept the old PID after reload");
    assert.deepEqual({
      accessibilityTrusted: recoveredStatus.accessibilityTrusted,
      screenCaptureGranted: recoveredStatus.screenCaptureGranted,
    }, permissionStatus, "desktop permission state changed after reload");
    const oldPidExited = !(await processExists(providerPid));
    assert.equal(oldPidExited, true, `old desktop Provider PID ${providerPid} is still running`);
    recovery = { oldPid: providerPid, newPid: recoveredStatus.processId, oldPidExited };
    steps.push({ name: "provider_reload_recovered", passed: true, details: recovery });
  }
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
}

const report = {
  ok: failure === undefined,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  endpoint: { origin: options.baseUrl.origin, capabilityPath: options.baseUrl.pathname },
  session: session ? { awake: session.awake, loggedIn: session.loggedIn, locked: session.locked } : undefined,
  samples: { rest: options.restSamples, mcp: options.mcpSamples, reloadProvider: options.reloadProvider },
  provider: { id: PROVIDER_ID, health: providerHealth, pids: [...providerPids], rssStartKiB, rssEndKiB, recovery },
  permissions: permissionStatus,
  metrics: metrics.report(),
  gates: {
    restP95Ms: options.restP95GateMs,
    mcpP95Ms: options.mcpP95GateMs,
    rssGrowthKiB: options.rssGrowthGateKiB,
  },
  steps,
  ...(failure ? { failure } : {}),
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ok: report.ok, artifactDir, steps: steps.length, failure }));

async function invokeRestStatus(): Promise<DesktopStatus> {
  const envelope = object(await fetchJson("/invocations", {
    method: "POST",
    body: JSON.stringify({ capabilityId: STATUS_CAPABILITY, arguments: {}, mode: "sync" }),
  }));
  const invocation = object(envelope.data);
  assert.equal(invocation.status, "succeeded");
  return desktopStatus(invocation.result);
}

async function invokeMcpStatus(): Promise<DesktopStatus> {
  const result = await client!.callTool({
    name: "capability_invoke",
    arguments: { capabilityId: STATUS_CAPABILITY, arguments: {}, mode: "sync" },
  });
  assert.equal(result.isError, undefined);
  const invocation = object(object(result.structuredContent).data);
  assert.equal(invocation.status, "succeeded");
  return desktopStatus(invocation.result);
}

function rememberStatus(status: DesktopStatus): void {
  providerPids.add(status.processId);
  const current = {
    accessibilityTrusted: status.accessibilityTrusted,
    screenCaptureGranted: status.screenCaptureGranted,
  };
  if (permissionStatus) assert.deepEqual(current, permissionStatus, "desktop permission state changed during run");
  else permissionStatus = current;
}

async function fetchJson(path: string, init: RequestInit = {}): Promise<unknown> {
  const url = new URL(path.replace(/^\//, ""), ensureTrailingSlash(options.baseUrl));
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const token = process.env.DEVSPACE_CAPABILITY_BEARER_TOKEN;
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Capability API returned non-JSON: ${text.slice(0, 300)}`); }
}

async function processRssKiB(pid: number): Promise<number | undefined> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024,
    });
    const value = Number(stdout.trim());
    return Number.isFinite(value) ? value : undefined;
  } catch { return undefined; }
}

async function processExists(pid: number): Promise<boolean> {
  try {
    await execFileAsync("/bin/ps", ["-p", String(pid)], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 64 * 1024,
    });
    return true;
  } catch { return false; }
}

interface DesktopStatus {
  processId: number;
  accessibilityTrusted: boolean;
  screenCaptureGranted: boolean;
}

function desktopStatus(value: unknown): DesktopStatus {
  const status = object(value);
  assert.equal(typeof status.processId, "number");
  assert.equal(typeof status.accessibilityTrusted, "boolean");
  assert.equal(typeof status.screenCaptureGranted, "boolean");
  return status as unknown as DesktopStatus;
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object response");
  return value as Record<string, any>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array response");
  return value;
}

function ensureTrailingSlash(url: URL): URL {
  const copy = new URL(url);
  if (!copy.pathname.endsWith("/")) copy.pathname += "/";
  return copy;
}

function parseOptions(args: string[]) {
  let baseUrl = new URL("http://127.0.0.1:7676/api/capabilities/v1/");
  let outputRoot = resolve(".build/desktop-provider-performance");
  let restSamples = 50;
  let mcpSamples = 25;
  let restP95GateMs = 250;
  let mcpP95GateMs = 500;
  let rssGrowthGateKiB = 64 * 1024;
  let reloadProvider = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === "--reload-provider") {
      reloadProvider = true;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--url") baseUrl = new URL(value);
    else if (key === "--output") outputRoot = resolve(value);
    else if (key === "--rest-samples") restSamples = positiveInteger(value, key, 1_000);
    else if (key === "--mcp-samples") mcpSamples = positiveInteger(value, key, 1_000);
    else if (key === "--rest-p95-ms") restP95GateMs = positiveInteger(value, key, 60_000);
    else if (key === "--mcp-p95-ms") mcpP95GateMs = positiveInteger(value, key, 60_000);
    else if (key === "--rss-growth-kib") rssGrowthGateKiB = positiveInteger(value, key, 1024 * 1024);
    else throw new Error(`unknown option: ${key}`);
  }
  return {
    baseUrl,
    outputRoot,
    restSamples,
    mcpSamples,
    restP95GateMs,
    mcpP95GateMs,
    rssGrowthGateKiB,
    reloadProvider,
  };
}

function positiveInteger(value: string, name: string, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return parsed;
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) =>
    `| ${step.passed ? "PASS" : "FAIL"} | ${step.name} | ${JSON.stringify(step.details ?? {})} |`).join("\n");
  const operations = Object.entries(reportValue.metrics.operations).map(([name, value]) =>
    `| ${name} | ${value.count} | ${value.p50Ms} | ${value.p95Ms} | ${value.p99Ms} | ${value.maxMs} |`).join("\n");
  return `# Desktop Provider performance canary\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Endpoint: ${reportValue.endpoint.origin}${reportValue.endpoint.capabilityPath}\n- Session locked: ${String(reportValue.session?.locked)}\n- Provider state: ${String(reportValue.provider.health?.state)}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Gate | Details |\n| --- | --- | --- |\n${rows}\n\n| Operation | Count | p50 ms | p95 ms | p99 ms | max ms |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${operations}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
