#!/usr/bin/env node
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStressWorkload, type StressRunOptions, type StressRunReport } from "./runner.js";
import { summarizeTunnelMetrics } from "./tunnel-metrics.js";

type Profile = "smoke" | "local" | "soak";
type Transport = "direct" | "tunnel-local";

interface CliOptions {
  profile: Profile;
  transport: Transport;
  concurrency?: number;
  workspaces?: number;
  operations?: number;
  churn?: number;
  durationMs?: number;
  thinkTimeMs?: number;
  capacityRequests?: number;
  cooldownMs?: number;
  serverConcurrency?: number;
  serverQueue?: number;
  outputRoot: string;
  keepFixture: boolean;
  tunnelClient: string;
}

interface ProcessSample {
  elapsedMs: number;
  rssMb: number;
}

class BoundedOutput {
  private text = "";
  append(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-128 * 1_024);
  }
  get value(): string {
    return this.text;
  }
}

const execFileAsync = promisify(execFile);
const cliOptions = parseArgs(process.argv.slice(2));
const profile = profileDefaults(cliOptions.profile);
const options = { ...profile, ...definedOverrides(cliOptions) };
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = resolve(cliOptions.outputRoot, runId);
const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-stress-"));
const serverPort = await availablePort();
const serverUrl = `http://127.0.0.1:${serverPort}/mcp`;
const eventLog = join(fixtureRoot, "devspace-events.log");
const serverOutput = new BoundedOutput();
const tunnelOutput = new BoundedOutput();
let server: ChildProcessWithoutNullStreams | undefined;
let tunnel: ChildProcessWithoutNullStreams | undefined;
let tunnelHealthUrl: string | undefined;
let metricsBefore = "";
let metricsAfter = "";
const processSamples: ProcessSample[] = [];
let sampleTimer: NodeJS.Timeout | undefined;
const startedAt = Date.now();
let phase = "setup";

try {
  await mkdir(artifactDir, { recursive: true });
  phase = "create_fixtures";
  const workspacePaths = await createFixtures(
    fixtureRoot,
    options.workspaces,
    options.concurrency,
  );
  phase = "start_server";
  server = startDevSpace(
    serverPort,
    fixtureRoot,
    workspacePaths,
    eventLog,
    serverOutput,
    cliOptions.serverConcurrency ?? 32,
    cliOptions.serverQueue ?? 64,
  );
  await waitForHealthy(`http://127.0.0.1:${serverPort}/healthz`, server, serverOutput);
  const initialSample = await sampleRss(server.pid, startedAt);
  if (initialSample) processSamples.push(initialSample);
  sampleTimer = setInterval(() => {
    void sampleRss(server!.pid, startedAt).then((sample) => {
      if (sample) processSamples.push(sample);
    });
  }, 250);
  sampleTimer.unref();

  let targetUrl = serverUrl;
  if (cliOptions.transport === "tunnel-local") {
    phase = "start_local_tunnel";
    const proxy = await startTunnelProxy(
      cliOptions.tunnelClient,
      serverUrl,
      fixtureRoot,
      tunnelOutput,
    );
    tunnel = proxy.process;
    targetUrl = proxy.mcpUrl;
    tunnelHealthUrl = proxy.healthUrl;
    metricsBefore = await fetchText(new URL("/metrics", tunnelHealthUrl).toString());
  }

  const workloadOptions: StressRunOptions = {
    url: targetUrl,
    workspacePaths,
    concurrency: options.concurrency,
    operationsPerClient: options.operations,
    churnSessions: options.churn,
    durationMs: options.durationMs,
    readP95TargetMs: 50,
    writeP95TargetMs: 50,
    runLongTasks: true,
    runCapacityBoundary: true,
    capacityRequests: cliOptions.capacityRequests ?? 128,
    thinkTimeMs: options.thinkTimeMs,
    runRecoveryScenarios: true,
  };
  phase = "run_workload";
  const workload = await runStressWorkload(workloadOptions);
  phase = "cooldown";
  await sleep(cliOptions.cooldownMs ?? (cliOptions.profile === "soak" ? 60_000 : 2_000));
  if (tunnelHealthUrl) {
    metricsAfter = await fetchText(new URL("/metrics", tunnelHealthUrl).toString());
  }
  const finalSample = await sampleRss(server.pid, startedAt);
  if (finalSample) processSamples.push(finalSample);
  phase = "write_report";
  const report = await buildReport(
    workload,
    cliOptions,
    processSamples,
    eventLog,
    serverOutput.value,
    tunnelOutput.value,
    metricsBefore,
    metricsAfter,
  );
  await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
  await writeFile(join(artifactDir, "server-output.log"), serverOutput.value);
  if (tunnelOutput.value) await writeFile(join(artifactDir, "tunnel-output.log"), tunnelOutput.value);
  if (metricsBefore) await writeFile(join(artifactDir, "tunnel-metrics-before.txt"), metricsBefore);
  if (metricsAfter) await writeFile(join(artifactDir, "tunnel-metrics-after.txt"), metricsAfter);

  console.log(JSON.stringify({
    ok: report.ok,
    profile: cliOptions.profile,
    transport: cliOptions.transport,
    artifactDir,
    durationMs: workload.durationMs,
    checks: workload.checks,
  }));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const failure = {
    ok: false,
    phase,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    elapsedMs: Date.now() - startedAt,
  };
  await mkdir(artifactDir, { recursive: true }).catch(() => {});
  await Promise.all([
    writeFile(join(artifactDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`),
    writeFile(join(artifactDir, "server-output.log"), serverOutput.value),
    writeFile(join(artifactDir, "tunnel-output.log"), tunnelOutput.value),
  ]).catch(() => {});
  console.error(JSON.stringify({ ...failure, artifactDir }));
  process.exitCode = 1;
} finally {
  if (sampleTimer) clearInterval(sampleTimer);
  await stopChild(tunnel);
  await stopChild(server);
  if (!cliOptions.keepFixture) await rm(fixtureRoot, { recursive: true, force: true });
  else console.error(`Stress fixture retained at ${fixtureRoot}`);
}

async function buildReport(
  workload: StressRunReport,
  options: CliOptions,
  samples: ProcessSample[],
  eventLogPath: string,
  serverLog: string,
  tunnelLog: string,
  tunnelMetricsBefore: string,
  tunnelMetricsAfter: string,
) {
  const resourceSnapshots = await loadResourceSnapshots(eventLogPath);
  const fatalPatterns = /heap out of memory|FATAL ERROR|uncaught|panic:/i;
  const noFatal = !fatalPatterns.test(serverLog) && !fatalPatterns.test(tunnelLog);
  const memory = summarizeMemory(samples, resourceSnapshots);
  const checks = [
    ...workload.checks,
    { name: "no_fatal_runtime_error", passed: noFatal, actual: noFatal, expected: "true" },
    {
      name: "rss_below_1_gib",
      passed: memory.maxRssMb < 1_024,
      actual: memory.maxRssMb,
      expected: "< 1024 MiB",
    },
    {
      name: "no_memory_pressure",
      passed: memory.pressureLevels.every((level) => level === "normal"),
      actual: memory.pressureLevels.join(",") || "no snapshot",
      expected: "normal",
    },
  ];
  if (workload.durationMs >= 10 * 60_000) {
    checks.push(
      {
        name: "steady_rss_growth",
        passed: memory.steadyRssGrowthMb < 64,
        actual: memory.steadyRssGrowthMb,
        expected: "< 64 MiB after warm-up",
      },
      {
        name: "steady_rss_slope",
        passed: memory.steadyRssSlopeMbPerHour < 32,
        actual: memory.steadyRssSlopeMbPerHour,
        expected: "< 32 MiB/hour after warm-up",
      },
      {
        name: "steady_heap_slope",
        passed: memory.steadyHeapSlopeMbPerHour < 16,
        actual: memory.steadyHeapSlopeMbPerHour,
        expected: "< 16 MiB/hour after warm-up",
      },
    );
  }
  return {
    ok: checks.every((check) => check.passed),
    run: {
      profile: options.profile,
      transport: options.transport,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      serverConcurrency: options.serverConcurrency ?? 32,
      serverQueue: options.serverQueue ?? 64,
    },
    workload: { ...workload, checks },
    memory,
    tunnelMetrics: tunnelMetricsAfter
      ? summarizeTunnelMetrics(tunnelMetricsBefore, tunnelMetricsAfter)
      : undefined,
  };
}

function summarizeMemory(samples: ProcessSample[], snapshots: Array<Record<string, unknown>>) {
  const rssValues = samples.map((sample) => sample.rssMb);
  const steadySamples = samples.slice(Math.floor(samples.length * 0.2));
  const steadyInitial = steadySamples[0]?.rssMb ?? 0;
  const steadyFinal = steadySamples.at(-1)?.rssMb ?? 0;
  const pressureLevels = Array.from(new Set(snapshots.flatMap((snapshot) =>
    typeof snapshot.heapPressure === "string" ? [snapshot.heapPressure] : [])));
  const heapSamples = snapshots.flatMap((snapshot, index) =>
    typeof snapshot.heapUsedMb === "number"
      ? [{ elapsedMs: resourceElapsedMs(snapshot, snapshots[0], index), rssMb: snapshot.heapUsedMb }]
      : []);
  const steadyHeapSamples = heapSamples.slice(Math.floor(heapSamples.length * 0.2));
  return {
    samples: samples.length,
    initialRssMb: rounded(rssValues[0] ?? 0),
    finalRssMb: rounded(rssValues.at(-1) ?? 0),
    maxRssMb: rounded(rssValues.length ? Math.max(...rssValues) : 0),
    rssSlopeMbPerHour: rounded(linearSlopePerHour(samples)),
    steadyRssGrowthMb: rounded(steadyFinal - steadyInitial),
    steadyRssSlopeMbPerHour: rounded(linearSlopePerHour(steadySamples)),
    initialHeapUsedMb: rounded(heapSamples[0]?.rssMb ?? 0),
    finalHeapUsedMb: rounded(heapSamples.at(-1)?.rssMb ?? 0),
    maxHeapUsedMb: rounded(heapSamples.length ? Math.max(...heapSamples.map((sample) => sample.rssMb)) : 0),
    steadyHeapSlopeMbPerHour: rounded(linearSlopePerHour(steadyHeapSamples)),
    pressureLevels,
    maxObservedSessions: maxNestedNumber(snapshots, "sessions", "total"),
    maxObservedActiveRequests: maxNestedNumber(snapshots, "requests", "active"),
    maxObservedQueuedRequests: maxNestedNumber(snapshots, "requests", "queued"),
    maxObservedProcesses: maxNestedNumber(snapshots, "processes", "active"),
    maxObservedWorkspaces: maxNestedNumber(snapshots, "workspaces", "loaded"),
    resourceSnapshots: snapshots,
  };
}

function resourceElapsedMs(
  snapshot: Record<string, unknown>,
  first: Record<string, unknown> | undefined,
  fallbackIndex: number,
): number {
  const timestamp = typeof snapshot.ts === "string" ? Date.parse(snapshot.ts) : NaN;
  const firstTimestamp = typeof first?.ts === "string" ? Date.parse(first.ts) : NaN;
  return Number.isFinite(timestamp) && Number.isFinite(firstTimestamp)
    ? timestamp - firstTimestamp
    : fallbackIndex * 60_000;
}

function maxNestedNumber(
  snapshots: Array<Record<string, unknown>>,
  group: string,
  key: string,
): number {
  return snapshots.reduce((maximum, snapshot) => {
    const nested = snapshot[group];
    const value = nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)[key]
      : undefined;
    return typeof value === "number" ? Math.max(maximum, value) : maximum;
  }, 0);
}

export function linearSlopePerHour(samples: ProcessSample[]): number {
  if (samples.length < 2) return 0;
  const xMean = samples.reduce((sum, sample) => sum + sample.elapsedMs, 0) / samples.length;
  const yMean = samples.reduce((sum, sample) => sum + sample.rssMb, 0) / samples.length;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const x = sample.elapsedMs - xMean;
    numerator += x * (sample.rssMb - yMean);
    denominator += x * x;
  }
  return denominator === 0 ? 0 : numerator / denominator * 3_600_000;
}

async function createFixtures(
  root: string,
  workspaceCount: number,
  concurrency: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (let workspaceIndex = 0; workspaceIndex < workspaceCount; workspaceIndex++) {
    const workspace = join(root, `workspace-${workspaceIndex}`);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "# Stress fixture\nOperate only inside this fixture.\n");
    await writeFile(join(workspace, "small.txt"), "small deterministic payload\n".repeat(20));
    await writeFile(join(workspace, "large.txt"), `${"large deterministic payload\n".repeat(50_000)}end\n`);
    for (let userIndex = 0; userIndex < concurrency; userIndex++) {
      await writeFile(join(workspace, `mutable-${userIndex}.txt`), "value-0\n");
    }
    paths.push(workspace);
  }
  return paths;
}

function startDevSpace(
  port: number,
  fixtureRoot: string,
  workspacePaths: string[],
  eventLog: string,
  output: BoundedOutput,
  maxConcurrentRequests: number,
  maxQueuedRequests: number,
): ChildProcessWithoutNullStreams {
  const cliPath = fileURLToPath(new URL("../cli.js", import.meta.url));
  const child = spawn(process.execPath, [cliPath, "serve"], {
    env: {
      ...processEnvWithoutNodeOptions(),
      HOST: "127.0.0.1",
      PORT: String(port),
      DEVSPACE_CONFIG_DIR: join(fixtureRoot, "config"),
      DEVSPACE_STATE_DIR: join(fixtureRoot, "state"),
      DEVSPACE_WORKTREE_ROOT: join(fixtureRoot, "worktrees"),
      DEVSPACE_ALLOWED_ROOTS: workspacePaths.join(","),
      DEVSPACE_OAUTH_OWNER_TOKEN: "stress-owner-token-not-a-secret",
      DEVSPACE_AUTH_MODE: "trusted-local",
      DEVSPACE_TOOL_MODE: "codex",
      DEVSPACE_WIDGETS: "off",
      DEVSPACE_SKILLS: "0",
      DEVSPACE_SUBAGENTS: "0",
      DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: String(maxConcurrentRequests),
      DEVSPACE_MCP_MAX_QUEUED_REQUESTS: String(maxQueuedRequests),
      DEVSPACE_PROCESS_MAX_CONCURRENT: "4",
      DEVSPACE_PROCESS_MAX_CONCURRENT_PER_WORKSPACE: "1",
      DEVSPACE_PROCESS_MAX_SESSIONS: "32",
      DEVSPACE_MCP_SESSION_CLEANUP_INTERVAL_SECONDS: "1",
      DEVSPACE_LOG_FORMAT: "json",
      DEVSPACE_LOG_REQUESTS: "0",
      DEVSPACE_LOG_TOOL_CALLS: "0",
      DEVSPACE_ASYNC_LOG_FILE: eventLog,
      NODE_OPTIONS: "--max-old-space-size=4096",
    },
  });
  child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk));
  return child;
}

async function startTunnelProxy(
  binary: string,
  serverUrl: string,
  fixtureRoot: string,
  output: BoundedOutput,
): Promise<{ process: ChildProcessWithoutNullStreams; mcpUrl: string; healthUrl: string }> {
  const urlFile = join(fixtureRoot, "tunnel-proxy.json");
  const healthFile = join(fixtureRoot, "tunnel-health.url");
  const child = spawn(binary, [
    "dev", "proxy",
    "--mcp-server-url", serverUrl,
    "--url-file", urlFile,
    "--health-url-file", healthFile,
    "--print-json",
  ]);
  child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk));
  const connection = await waitForJsonFile(urlFile, child, output);
  const mcpUrl = connection.mcp_url;
  const healthUrl = connection.health_url;
  if (typeof mcpUrl !== "string" || typeof healthUrl !== "string") {
    await stopChild(child);
    throw new Error(`tunnel proxy returned invalid connection data: ${JSON.stringify(connection)}`);
  }
  await waitForHealthy(healthUrl, child, output);
  return { process: child, mcpUrl, healthUrl };
}

async function waitForJsonFile(
  path: string,
  process: ChildProcessWithoutNullStreams,
  output: BoundedOutput,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`tunnel proxy exited early: ${output.value}`);
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for tunnel proxy: ${output.value}`);
}

async function waitForHealthy(
  url: string,
  process: ChildProcessWithoutNullStreams,
  output: BoundedOutput,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`managed process exited early: ${output.value}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}: ${output.value}`);
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

async function sampleRss(pid: number | undefined, startedAt: number): Promise<ProcessSample | undefined> {
  if (!pid) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
    const rssKb = Number(stdout.trim());
    if (!Number.isFinite(rssKb)) return undefined;
    return { elapsedMs: Date.now() - startedAt, rssMb: rssKb / 1_024 };
  } catch {
    return undefined;
  }
}

async function loadResourceSnapshots(path: string): Promise<Array<Record<string, unknown>>> {
  try {
    const content = await readFile(path, "utf8");
    return content.split("\n").flatMap((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        return event.event === "resource_snapshot" ? [event] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a local port");
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  return address.port;
}

async function stopChild(process: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!process || process.exitCode !== null) return;
  process.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => process.once("exit", () => resolvePromise())),
    sleep(5_000),
  ]);
  if (process.exitCode === null) process.kill("SIGKILL");
}

function profileDefaults(profile: Profile) {
  if (profile === "smoke") return { concurrency: 8, workspaces: 4, operations: 20, churn: 32 };
  if (profile === "local") return { concurrency: 32, workspaces: 8, operations: 100, churn: 512 };
  return {
    concurrency: 16,
    workspaces: 8,
    operations: 1,
    churn: 5_000,
    durationMs: 24 * 60 * 60 * 1_000,
    thinkTimeMs: 100,
  };
}

function definedOverrides(options: CliOptions) {
  return Object.fromEntries(Object.entries({
    concurrency: options.concurrency,
    workspaces: options.workspaces,
    operations: options.operations,
    churn: options.churn,
    durationMs: options.durationMs,
    thinkTimeMs: options.thinkTimeMs,
  }).filter(([, value]) => value !== undefined)) as Partial<ReturnType<typeof profileDefaults>>;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    profile: "smoke",
    transport: "direct",
    outputRoot: "artifacts/stress",
    keepFixture: false,
    tunnelClient: process.env.TUNNEL_CLIENT_BIN ?? join(homedir(), ".local/bin/tunnel-client"),
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--keep-fixture") {
      options.keepFixture = true;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a value`);
    switch (argument) {
      case "--profile": options.profile = enumValue(value, ["smoke", "local", "soak"], argument); break;
      case "--transport": options.transport = enumValue(value, ["direct", "tunnel-local"], argument); break;
      case "--concurrency": options.concurrency = positiveInteger(value, argument); break;
      case "--workspaces": options.workspaces = positiveInteger(value, argument); break;
      case "--operations": options.operations = positiveInteger(value, argument); break;
      case "--churn": options.churn = nonNegativeInteger(value, argument); break;
      case "--duration": options.durationMs = parseDuration(value); break;
      case "--think-time": options.thinkTimeMs = nonNegativeInteger(value, argument); break;
      case "--capacity-requests": options.capacityRequests = positiveInteger(value, argument); break;
      case "--cooldown": options.cooldownMs = parseDuration(value); break;
      case "--server-concurrency": options.serverConcurrency = positiveInteger(value, argument); break;
      case "--server-queue": options.serverQueue = nonNegativeInteger(value, argument); break;
      case "--output": options.outputRoot = value; break;
      case "--tunnel-client": options.tunnelClient = value; break;
      default: throw new Error(`unknown stress option: ${argument}`);
    }
  }
  return options;
}

function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) throw new Error("duration must use ms, s, m, or h suffix");
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  return Number(match[1]) * multiplier;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function enumValue<T extends string>(value: string, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) throw new Error(`${name} must be one of ${values.join(", ")}`);
  return value as T;
}

function processEnvWithoutNodeOptions(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}

function renderMarkdown(report: Awaited<ReturnType<typeof buildReport>>): string {
  const operationRows = Object.entries(report.workload.metrics.operations)
    .map(([name, value]) => `| ${name} | ${value.count} | ${value.errors} | ${value.meanMs} | ${value.p95Ms} | ${value.p99Ms} |`)
    .join("\n");
  const checkRows = report.workload.checks
    .map((check) => `| ${check.passed ? "PASS" : "FAIL"} | ${check.name} | ${check.actual} | ${check.expected} |`)
    .join("\n");
  const tunnel = report.tunnelMetrics
    ? `\n## Tunnel\n\n- Commands enqueued: ${report.tunnelMetrics.commandsEnqueued}\n- Tool calls: ${report.tunnelMetrics.toolCalls}\n- Mean end-to-end tool latency: ${report.tunnelMetrics.toolCallMeanEndToEndMs} ms\n- Mean upstream HTTP latency: ${report.tunnelMetrics.httpClientMeanMs} ms\n- Final queue: ${report.tunnelMetrics.finalQueueLength}/${report.tunnelMetrics.queueCapacity}\n- Workers: ${report.tunnelMetrics.workerOccupancy}/${report.tunnelMetrics.workerCapacity}\n- Go heap: ${report.tunnelMetrics.finalHeapAllocMb} MiB (${report.tunnelMetrics.heapAllocGrowthMb} MiB growth)\n- Goroutines: ${report.tunnelMetrics.finalGoroutines} (${report.tunnelMetrics.goroutineGrowth} growth)\n`
    : "";
  return `# DevSpace stress report\n\n- Result: ${report.ok ? "PASS" : "FAIL"}\n- Profile: ${report.run.profile}\n- Transport: ${report.run.transport}\n- Duration: ${report.workload.durationMs} ms\n- Concurrency: ${report.workload.options.concurrency}\n- Workspaces: ${report.workload.options.workspaceCount}\n- Max RSS: ${report.memory.maxRssMb} MiB\n- RSS slope: ${report.memory.rssSlopeMbPerHour} MiB/hour\n\n## Checks\n\n| Result | Check | Actual | Expected |\n| --- | --- | ---: | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Count | Errors | Mean ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${operationRows}\n${tunnel}`;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
