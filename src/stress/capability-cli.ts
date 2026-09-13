#!/usr/bin/env node
import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  runCapabilityStressWorkload,
  type CapabilityStressReport,
} from "./capability-runner.js";

type Profile = "smoke" | "local" | "soak";

interface CliOptions {
  profile: Profile;
  concurrency?: number;
  operations?: number;
  churn?: number;
  durationMs?: number;
  thinkTimeMs?: number;
  capacityRequests?: number;
  cooldownMs?: number;
  outputRoot: string;
  keepFixture: boolean;
}

interface ProcessTreeSample {
  elapsedMs: number;
  rssMb: number;
  processCount: number;
  descendantCount: number;
  fdCount?: number;
  listeningSocketCount?: number;
}

class BoundedOutput {
  private text = "";
  append(chunk: Buffer | string): void {
    this.text = (this.text + chunk.toString()).slice(-256 * 1_024);
  }
  get value(): string {
    return this.text;
  }
}

const execFileAsync = promisify(execFile);
const cli = parseArgs(process.argv.slice(2));
const options = { ...profileDefaults(cli.profile), ...definedOverrides(cli) };
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = resolve(cli.outputRoot, runId);
const fixtureRoot = await mkdtemp(join(tmpdir(), "devspace-capability-stress-"));
const providerDirectory = join(fixtureRoot, "providers");
const providerStateDirectory = join(fixtureRoot, "provider-state");
const serverOutput = new BoundedOutput();
const samples: ProcessTreeSample[] = [];
let server: ChildProcessWithoutNullStreams | undefined;
let sampleTimer: NodeJS.Timeout | undefined;
let phase = "setup";
const wallStartedAt = Date.now();

try {
  await mkdir(artifactDir, { recursive: true });
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  await mkdir(providerStateDirectory, { recursive: true, mode: 0o700 });
  phase = "write_provider_manifest";
  await writeFixtureManifest(providerDirectory, providerStateDirectory);
  const port = await availablePort();
  phase = "start_server";
  server = startDevSpace(port, fixtureRoot, providerDirectory, serverOutput);
  await waitForHealthy(`http://127.0.0.1:${port}/healthz`, server, serverOutput);
  const startedAt = Date.now();
  const initial = await sampleProcessTree(server.pid, startedAt, true);
  if (initial) samples.push(initial);
  sampleTimer = setInterval(() => {
    void sampleProcessTree(server!.pid, startedAt, samples.length % 4 === 0).then((sample) => {
      if (sample) samples.push(sample);
    });
  }, 250);
  sampleTimer.unref();

  const restUrl = `http://127.0.0.1:${port}/api/capabilities/v1`;
  phase = "run_workload";
  const workload = await runCapabilityStressWorkload({
    restUrl,
    mcpUrl: `http://127.0.0.1:${port}/capabilities/mcp`,
    providerId: "stress.fixture.mcp",
    echoCapabilityId: "stress.fixture.echo",
    delayCapabilityId: "stress.fixture.delay",
    largeOutputCapabilityId: "stress.fixture.large_output",
    crashCapabilityId: "stress.fixture.crash_once",
    concurrency: options.concurrency,
    operationsPerClient: options.operations,
    churnSessions: options.churn,
    durationMs: options.durationMs,
    thinkTimeMs: options.thinkTimeMs,
    capacityRequests: cli.capacityRequests ?? options.capacityRequests,
    discoveryP95TargetMs: 100,
    invocationP95TargetMs: 150,
    timeoutMs: 30_000,
    runFaultInjection: true,
    providerRecoveryTimeoutMs: 15_000,
    trackedInvocationLimit: 2_000,
  });
  phase = "cooldown";
  await sleep(cli.cooldownMs ?? (cli.profile === "soak" ? 60_000 : 2_000));
  const finalSample = await sampleProcessTree(server.pid, startedAt, true);
  if (finalSample) samples.push(finalSample);
  if (sampleTimer) clearInterval(sampleTimer);
  sampleTimer = undefined;

  phase = "shutdown_verification";
  const serverPid = server.pid;
  const descendantPids = serverPid
    ? [...descendantIds(await processRows(), serverPid)]
    : [];
  await stopChild(server);
  server = undefined;
  const orphanDescendants = await waitForPidsExit(descendantPids, 5_000);
  phase = "write_report";
  const report = buildReport(workload, cli, samples, serverOutput.value, orphanDescendants);
  await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
  await writeFile(join(artifactDir, "server-output.log"), serverOutput.value);
  console.log(JSON.stringify({
    ok: report.ok,
    profile: cli.profile,
    artifactDir,
    durationMs: workload.durationMs,
    checks: report.checks,
  }));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  const failure = {
    ok: false,
    phase,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    elapsedMs: Date.now() - wallStartedAt,
  };
  await mkdir(artifactDir, { recursive: true }).catch(() => {});
  await Promise.all([
    writeFile(join(artifactDir, "failure.json"), `${JSON.stringify(failure, null, 2)}\n`),
    writeFile(join(artifactDir, "server-output.log"), serverOutput.value),
  ]).catch(() => {});
  console.error(JSON.stringify({ ...failure, artifactDir }));
  process.exitCode = 1;
} finally {
  if (sampleTimer) clearInterval(sampleTimer);
  await stopChild(server);
  if (!cli.keepFixture) await rm(fixtureRoot, { recursive: true, force: true });
  else console.error(`Capability stress fixture retained at ${fixtureRoot}`);
}

function buildReport(
  workload: CapabilityStressReport,
  cliOptions: CliOptions,
  processSamples: ProcessTreeSample[],
  serverLog: string,
  orphanDescendants: number,
) {
  const memory = summarizeMemory(processSamples);
  const noFatal = !/heap out of memory|FATAL ERROR|uncaught|panic:/i.test(serverLog);
  const checks = [
    ...workload.checks,
    { name: "no_fatal_runtime_error", passed: noFatal, actual: noFatal, expected: "true" },
    {
      name: "process_tree_rss_below_1_gib",
      passed: memory.maxRssMb < 1_024,
      actual: memory.maxRssMb,
      expected: "< 1024 MiB",
    },
    {
      name: "provider_child_observed",
      passed: memory.maxDescendantCount >= 1,
      actual: memory.maxDescendantCount,
      expected: ">= 1",
    },
    {
      name: "no_orphan_provider_after_shutdown",
      passed: orphanDescendants === 0,
      actual: orphanDescendants,
      expected: "0",
    },
  ];
  if (workload.durationMs >= 10 * 60_000) checks.push(
    {
      name: "steady_process_tree_rss_growth",
      passed: memory.steadyRssGrowthMb < 64,
      actual: memory.steadyRssGrowthMb,
      expected: "< 64 MiB after warm-up",
    },
    {
      name: "steady_process_tree_rss_slope",
      passed: memory.steadyRssSlopeMbPerHour < 32,
      actual: memory.steadyRssSlopeMbPerHour,
      expected: "< 32 MiB/hour after warm-up",
    },
  );
  if (workload.durationMs >= 10 * 60_000 && memory.fdSamples > 0) checks.push({
    name: "steady_file_descriptor_growth",
    passed: memory.fdGrowth < 64,
    actual: memory.fdGrowth,
    expected: "< 64 descriptors",
  });
  return {
    ok: checks.every((check) => check.passed),
    run: {
      profile: cliOptions.profile,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      isolatedFixture: true,
    },
    workload,
    memory,
    checks,
  };
}

async function writeFixtureManifest(directory: string, stateDirectory: string): Promise<void> {
  const fixtureEntrypoint = fileURLToPath(new URL("./capability-fixture-mcp.js", import.meta.url));
  const common = {
    version: "1.0.0",
    tags: ["stress", "fixture"],
    aliases: [],
    availability: {
      requiresAwake: false,
      requiresLoggedInSession: false,
      requiresUnlocked: false,
      requiresForegroundApp: false,
    },
    permissions: [],
    requiresLease: false,
    resourceTypes: [],
    defaultTimeoutMs: 5_000,
    maxTimeoutMs: 10_000,
  };
  const manifest = {
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: "stress.fixture.mcp", title: "Capability stress fixture" },
    spec: {
      enabled: true,
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [fixtureEntrypoint, "--state-dir", stateDirectory],
        envFrom: {},
      },
      tools: [
        {
          ...common,
          tool: "echo",
          capabilityId: "stress.fixture.echo",
          effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        },
        {
          ...common,
          tool: "delay",
          capabilityId: "stress.fixture.delay",
          effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        },
        {
          ...common,
          tool: "large_output",
          capabilityId: "stress.fixture.large_output",
          effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
        },
        {
          ...common,
          tool: "crash_once",
          capabilityId: "stress.fixture.crash_once",
          effects: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
        },
      ],
    },
  };
  await writeFile(join(directory, "stress.fixture.mcp.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function startDevSpace(
  port: number,
  fixtureRoot: string,
  providerDirectory: string,
  output: BoundedOutput,
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
      DEVSPACE_ALLOWED_ROOTS: fixtureRoot,
      DEVSPACE_OAUTH_OWNER_TOKEN: "capability-stress-owner-token-not-a-secret",
      DEVSPACE_AUTH_MODE: "trusted-local",
      DEVSPACE_TOOL_MODE: "minimal",
      DEVSPACE_WIDGETS: "off",
      DEVSPACE_SKILLS: "0",
      DEVSPACE_SUBAGENTS: "0",
      DEVSPACE_LOG_LEVEL: "info",
      DEVSPACE_LOG_FORMAT: "json",
      DEVSPACE_CAPABILITIES: "1",
      DEVSPACE_CAPABILITY_CONFIG_DIR: providerDirectory,
      DEVSPACE_CAPABILITY_MAX_CONCURRENT: "4",
      DEVSPACE_CAPABILITY_MAX_CONCURRENT_PER_PROVIDER: "2",
      DEVSPACE_CAPABILITY_QUEUE_LIMIT: "64",
      DEVSPACE_CAPABILITY_MAX_OUTPUT_BYTES: String(32 * 1_024),
      DEVSPACE_CAPABILITY_MAX_TRACKED_INVOCATIONS: "2000",
      DEVSPACE_CAPABILITY_DEFAULT_TIMEOUT_MS: "5000",
      DEVSPACE_CAPABILITY_MAX_TIMEOUT_MS: "10000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.append(chunk));
  child.stderr.on("data", (chunk) => output.append(chunk));
  return child;
}

function summarizeMemory(samples: ProcessTreeSample[]) {
  const steady = samples.slice(Math.floor(samples.length * 0.2));
  const initial = steady[0]?.rssMb ?? 0;
  const final = steady.at(-1)?.rssMb ?? 0;
  const fdSamples = samples.filter((sample) => sample.fdCount !== undefined);
  return {
    samples: samples.length,
    initialRssMb: rounded(samples[0]?.rssMb ?? 0),
    finalRssMb: rounded(samples.at(-1)?.rssMb ?? 0),
    maxRssMb: rounded(samples.length ? Math.max(...samples.map(({ rssMb }) => rssMb)) : 0),
    steadyRssGrowthMb: rounded(final - initial),
    steadyRssSlopeMbPerHour: rounded(linearSlopePerHour(steady)),
    maxProcessCount: samples.length ? Math.max(...samples.map(({ processCount }) => processCount)) : 0,
    maxDescendantCount: samples.length ? Math.max(...samples.map(({ descendantCount }) => descendantCount)) : 0,
    fdSamples: fdSamples.length,
    initialFdCount: fdSamples[0]?.fdCount ?? 0,
    finalFdCount: fdSamples.at(-1)?.fdCount ?? 0,
    maxFdCount: fdSamples.length ? Math.max(...fdSamples.map(({ fdCount }) => fdCount!)) : 0,
    fdGrowth: (fdSamples.at(-1)?.fdCount ?? 0) - (fdSamples[0]?.fdCount ?? 0),
    maxListeningSocketCount: samples.length
      ? Math.max(...samples.map(({ listeningSocketCount }) => listeningSocketCount ?? 0))
      : 0,
  };
}

function linearSlopePerHour(samples: ProcessTreeSample[]): number {
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

async function sampleProcessTree(
  rootPid: number | undefined,
  startedAt: number,
  inspectDescriptors = false,
): Promise<ProcessTreeSample | undefined> {
  if (!rootPid) return undefined;
  const rows = await processRows();
  if (!rows.some(({ pid }) => pid === rootPid)) return undefined;
  const ids = descendantIds(rows, rootPid);
  ids.add(rootPid);
  const rssKb = rows.filter(({ pid }) => ids.has(pid)).reduce((sum, row) => sum + row.rssKb, 0);
  const descriptors = inspectDescriptors ? await fileDescriptorStats([...ids]) : {};
  return {
    elapsedMs: Date.now() - startedAt,
    rssMb: rssKb / 1_024,
    processCount: ids.size,
    descendantCount: Math.max(0, ids.size - 1),
    ...descriptors,
  };
}

async function fileDescriptorStats(
  processIds: number[],
): Promise<{ fdCount?: number; listeningSocketCount?: number }> {
  if (processIds.length === 0) return {};
  try {
    const { stdout } = await execFileAsync("lsof", [
      "-nP",
      "-a",
      "-p",
      processIds.join(","),
    ], { maxBuffer: 8 * 1024 * 1024 });
    const lines = stdout.split("\n").filter(Boolean).slice(1);
    return {
      fdCount: lines.length,
      listeningSocketCount: lines.filter((line) => /\(LISTEN\)/.test(line)).length,
    };
  } catch {
    return {};
  }
}

async function waitForPidsExit(processIds: number[], timeoutMs: number): Promise<number> {
  if (processIds.length === 0) return 0;
  const deadline = Date.now() + timeoutMs;
  let count = processIds.length;
  while (Date.now() < deadline) {
    const live = new Set((await processRows()).map(({ pid }) => pid));
    count = processIds.filter((pid) => live.has(pid)).length;
    if (count === 0) return 0;
    await sleep(100);
  }
  return count;
}

async function processRows(): Promise<Array<{ pid: number; ppid: number; rssKb: number }>> {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss="]);
    return stdout.split("\n").flatMap((line) => {
      const [pid, ppid, rssKb] = line.trim().split(/\s+/).map(Number);
      return Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(rssKb)
        ? [{ pid: pid!, ppid: ppid!, rssKb: rssKb! }]
        : [];
    });
  } catch {
    return [];
  }
}

function descendantIds(
  rows: Array<{ pid: number; ppid: number }>,
  rootPid: number,
): Set<number> {
  const ids = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if ((row.ppid === rootPid || ids.has(row.ppid)) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  return ids;
}

async function waitForHealthy(
  url: string,
  child: ChildProcessWithoutNullStreams,
  output: BoundedOutput,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DevSpace exited early: ${output.value}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${url}: ${output.value}`);
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

async function stopChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise())),
    sleep(5_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function profileDefaults(profile: Profile) {
  if (profile === "smoke") return {
    concurrency: 4, operations: 20, churn: 16, capacityRequests: 80,
  };
  if (profile === "local") return {
    concurrency: 16, operations: 100, churn: 256, capacityRequests: 128,
  };
  return {
    concurrency: 8,
    operations: 1,
    churn: 5_000,
    capacityRequests: 128,
    durationMs: 24 * 60 * 60_000,
    thinkTimeMs: 100,
  };
}

function definedOverrides(options: CliOptions) {
  return Object.fromEntries(Object.entries({
    concurrency: options.concurrency,
    operations: options.operations,
    churn: options.churn,
    durationMs: options.durationMs,
    thinkTimeMs: options.thinkTimeMs,
    capacityRequests: options.capacityRequests,
  }).filter(([, value]) => value !== undefined)) as Partial<ReturnType<typeof profileDefaults>>;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    profile: "smoke",
    outputRoot: "artifacts/capability-stress",
    keepFixture: false,
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
      case "--concurrency": options.concurrency = positiveInteger(value, argument); break;
      case "--operations": options.operations = positiveInteger(value, argument); break;
      case "--churn": options.churn = nonNegativeInteger(value, argument); break;
      case "--duration": options.durationMs = parseDuration(value); break;
      case "--think-time": options.thinkTimeMs = nonNegativeInteger(value, argument); break;
      case "--capacity-requests": options.capacityRequests = positiveInteger(value, argument); break;
      case "--cooldown": options.cooldownMs = parseDuration(value); break;
      case "--output": options.outputRoot = value; break;
      default: throw new Error(`unknown capability stress option: ${argument}`);
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
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  return environment;
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const checkRows = report.checks.map((entry) =>
    `| ${entry.passed ? "PASS" : "FAIL"} | ${entry.name} | ${entry.actual} | ${entry.expected} |`).join("\n");
  const operationRows = Object.entries(report.workload.metrics.operations).map(([name, value]) =>
    `| ${name} | ${value.count} | ${value.errors} | ${value.meanMs} | ${value.p95Ms} | ${value.p99Ms} |`).join("\n");
  return `# DevSpace capability stress report\n\n- Result: ${report.ok ? "PASS" : "FAIL"}\n- Profile: ${report.run.profile}\n- Duration: ${report.workload.durationMs} ms\n- Concurrency: ${report.workload.options.concurrency}\n- Business invocations: ${report.workload.totals.completedInvocations}/${report.workload.totals.attemptedInvocations}\n- Max process-tree RSS: ${report.memory.maxRssMb} MiB\n- Max descendant processes: ${report.memory.maxDescendantCount}\n- Max file descriptors: ${report.memory.fdSamples ? report.memory.maxFdCount : "unavailable"}\n- Max listening sockets: ${report.memory.fdSamples ? report.memory.maxListeningSocketCount : "unavailable"}\n\n## Checks\n\n| Result | Check | Actual | Expected |\n| --- | --- | --- | --- |\n${checkRows}\n\n## Latency\n\n| Operation | Count | Errors | Mean ms | p95 ms | p99 ms |\n| --- | ---: | ---: | ---: | ---: | ---: |\n${operationRows}\n`;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
