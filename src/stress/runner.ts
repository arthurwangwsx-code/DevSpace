import { McpStressClient, optionalString, requiredBoolean, requiredNumber } from "./mcp-client.js";
import { StressMetrics, type LatencySummary } from "./metrics.js";

export interface StressRunOptions {
  url: string;
  workspacePaths: string[];
  concurrency: number;
  operationsPerClient: number;
  churnSessions: number;
  durationMs?: number;
  timeoutMs?: number;
  readP95TargetMs?: number;
  writeP95TargetMs?: number;
  runLongTasks?: boolean;
  runCapacityBoundary?: boolean;
  capacityRequests?: number;
  thinkTimeMs?: number;
  runRecoveryScenarios?: boolean;
}

export interface StressCheck {
  name: string;
  passed: boolean;
  actual: number | boolean | string;
  expected: string;
}

export interface StressRunReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  options: Omit<StressRunOptions, "workspacePaths"> & { workspaceCount: number };
  totals: { attemptedBusinessOperations: number; churnSessions: number };
  metrics: ReturnType<StressMetrics["report"]>;
  checks: StressCheck[];
  longTasks: Array<{ workspace: string; firstResponseMs: number; totalMs: number; chunksSeen: number }>;
  capacityBoundary?: CapacityBoundaryReport;
  recovery?: RecoveryScenarioReport;
}

export interface CapacityBoundaryReport {
  requests: number;
  successes: number;
  overloads: number;
  otherFailures: number;
  recoverySucceeded: boolean;
  durationMs: number;
  metrics: ReturnType<StressMetrics["report"]>;
}

export interface RecoveryScenarioReport {
  largeFilePaged: boolean;
  largeFilePagesRead: number;
  workspaceReleased: boolean;
  workspaceRecoverable: boolean;
  workspaceRestored: boolean;
}

interface VirtualUser {
  client: McpStressClient;
  workspaceId: string;
  workspacePath: string;
  mutableValue: string;
}

export async function runStressWorkload(options: StressRunOptions): Promise<StressRunReport> {
  validateOptions(options);
  const metrics = new StressMetrics();
  const startedAt = new Date();
  const startedMs = performance.now();
  const users: VirtualUser[] = [];
  let attemptedBusinessOperations = 0;
  const deadline = options.durationMs ? Date.now() + options.durationMs : undefined;

  try {
    await parallelMap(
      Array.from({ length: options.concurrency }, (_, index) => index),
      options.concurrency,
      async (index) => {
        const client = new McpStressClient(
          options.url,
          metrics,
          options.timeoutMs,
          `devspace-stress-${index}`,
        );
        await client.connect();
        const toolCount = await client.listTools();
        if (toolCount < 6) throw new Error(`expected at least 6 tools, received ${toolCount}`);
        const workspacePath = options.workspacePaths[index % options.workspacePaths.length]!;
        const workspaceId = await client.openWorkspace(workspacePath);
        users[index] = { client, workspaceId, workspacePath, mutableValue: "value-0" };
      },
    );

    const businessWorkload = Promise.all(users.map(async (user, userIndex) => {
      let operationIndex = 0;
      while (
        deadline ? Date.now() < deadline : operationIndex < options.operationsPerClient
      ) {
        attemptedBusinessOperations++;
        try {
          if (operationIndex % 2 === 0) {
            await user.client.call("read", {
              workspaceId: user.workspaceId,
              path: "small.txt",
              limit: 20,
            }, "read");
          } else {
            const nextValue = `value-${userIndex}-${operationIndex}`;
            await user.client.call("apply_patch", {
              workspaceId: user.workspaceId,
              patch: [
                "*** Begin Patch",
                `*** Update File: mutable-${userIndex}.txt`,
                "@@",
                `-${user.mutableValue}`,
                `+${nextValue}`,
                "*** End Patch",
              ].join("\n"),
            }, "write");
            user.mutableValue = nextValue;
          }
        } catch {
          // Failure is retained by StressMetrics; continue to expose repeatability and leak behavior.
        }
        operationIndex++;
        if (options.thinkTimeMs) await sleep(options.thinkTimeMs);
      }
    }));
    const churnDuringTimedRun = deadline && options.churnSessions > 0
      ? runSessionChurn(options, metrics)
      : undefined;
    await Promise.all([businessWorkload, churnDuringTimedRun]);

    const longTasks = options.runLongTasks === false
      ? []
      : await runLongTasks(uniqueWorkspaceUsers(users), metrics);

    const capacityBoundary = options.runCapacityBoundary === false
      ? undefined
      : await runCapacityBoundary(users, options.capacityRequests ?? 64);

    const recovery = options.runRecoveryScenarios === false
      ? undefined
      : await runRecoveryScenarios(users[0]!, metrics);

    if (!deadline) await runSessionChurn(options, metrics);

    const metricReport = metrics.report();
    const checks = buildChecks(
      metricReport.operations,
      metricReport.failures,
      longTasks,
      options.readP95TargetMs ?? 50,
      options.writeP95TargetMs ?? 50,
      capacityBoundary,
      recovery,
    );
    return {
      ok: checks.every((check) => check.passed),
      startedAt: startedAt.toISOString(),
      durationMs: rounded(performance.now() - startedMs),
      options: {
        url: options.url,
        workspaceCount: options.workspacePaths.length,
        concurrency: options.concurrency,
        operationsPerClient: options.operationsPerClient,
        churnSessions: options.churnSessions,
        durationMs: options.durationMs,
        timeoutMs: options.timeoutMs,
        readP95TargetMs: options.readP95TargetMs,
        writeP95TargetMs: options.writeP95TargetMs,
        runLongTasks: options.runLongTasks,
        runCapacityBoundary: options.runCapacityBoundary,
        capacityRequests: options.capacityRequests,
        thinkTimeMs: options.thinkTimeMs,
        runRecoveryScenarios: options.runRecoveryScenarios,
      },
      totals: { attemptedBusinessOperations, churnSessions: options.churnSessions },
      metrics: metricReport,
      checks,
      longTasks,
      capacityBoundary,
      recovery,
    };
  } finally {
    await Promise.all(users.filter(Boolean).map((user) => user.client.close()));
  }
}

async function runRecoveryScenarios(
  user: VirtualUser,
  metrics: StressMetrics,
): Promise<RecoveryScenarioReport> {
  const first = await user.client.call("read", {
    workspaceId: user.workspaceId,
    path: "large.txt",
  }, "large_read", metrics);
  let result = optionalString(first, "result");
  let pages = 1;
  let match = result.match(/continue with byteOffset=(\d+)/);
  while (match && pages < 16) {
    const next = await user.client.call("read", {
      workspaceId: user.workspaceId,
      path: "large.txt",
      byteOffset: Number(match[1]),
    }, "large_read", metrics);
    result = optionalString(next, "result");
    pages++;
    match = result.match(/continue with byteOffset=(\d+)/);
  }
  const release = await user.client.call("release_workspace", {
    workspaceId: user.workspaceId,
  }, "release_workspace", metrics);
  const workspaceReleased = requiredBoolean(release, "released");
  const workspaceRecoverable = requiredBoolean(release, "recoverable");
  const restored = await user.client.call("read", {
    workspaceId: user.workspaceId,
    path: "small.txt",
    limit: 2,
  }, "workspace_restore_read", metrics);
  return {
    largeFilePaged: pages > 1 && !match,
    largeFilePagesRead: pages,
    workspaceReleased,
    workspaceRecoverable,
    workspaceRestored: optionalString(restored, "result").includes("small deterministic payload")
      || optionalString(restored, "result").includes("small"),
  };
}

async function runLongTasks(
  users: VirtualUser[],
  metrics: StressMetrics,
): Promise<StressRunReport["longTasks"]> {
  return Promise.all(users.slice(0, 4).map(async (user) => {
    const startedAt = performance.now();
    const first = await user.client.call("exec_command", {
      workspaceId: user.workspaceId,
      cmd: "for value in 1 2 3 4 5; do printf 'chunk-%s\\n' \"$value\"; sleep 0.05; done",
      yieldTimeMs: 0,
      maxOutputTokens: 1_000,
    }, "long_task_start");
    const firstResponseMs = performance.now() - startedAt;
    let output = optionalString(first, "result");
    let running = requiredBoolean(first, "running");
    const sessionId = requiredNumber(first, "sessionId");
    let polls = 0;
    while (running && polls < 20) {
      const result = await user.client.call("write_stdin", {
        workspaceId: user.workspaceId,
        sessionId,
        yieldTimeMs: 1_000,
        maxOutputTokens: 1_000,
      }, "long_task_poll");
      output += optionalString(result, "result");
      running = requiredBoolean(result, "running");
      polls++;
    }
    if (running) throw new Error("long task did not finish after 20 polls");
    const chunksSeen = new Set(output.match(/chunk-[1-5]/g) ?? []).size;
    if (chunksSeen !== 5) throw new Error(`long task stream returned ${chunksSeen}/5 chunks`);
    return {
      workspace: user.workspacePath,
      firstResponseMs: rounded(firstResponseMs),
      totalMs: rounded(performance.now() - startedAt),
      chunksSeen,
    };
  }));
}

async function runCapacityBoundary(
  users: VirtualUser[],
  requestCount: number,
): Promise<CapacityBoundaryReport> {
  const metrics = new StressMetrics();
  const processUsers = uniqueWorkspaceUsers(users).slice(0, 4);
  const sessions = await Promise.all(processUsers.map(async (user) => {
    const result = await user.client.call("exec_command", {
      workspaceId: user.workspaceId,
      cmd: "sleep 10",
      yieldTimeMs: 0,
      maxOutputTokens: 100,
    }, "capacity_process_start", metrics);
    return { user, sessionId: requiredNumber(result, "sessionId") };
  }));
  const startedAt = performance.now();
  try {
    const settled = await Promise.allSettled(
      Array.from({ length: requestCount }, async (_, index) => {
        const target = sessions[index % sessions.length]!;
        return target.user.client.call("write_stdin", {
          workspaceId: target.user.workspaceId,
          sessionId: target.sessionId,
          yieldTimeMs: 750,
          maxOutputTokens: 100,
        }, "capacity_poll", metrics);
      }),
    );
    const report = metrics.report();
    const overloads = report.failures.overloaded ?? 0;
    const totalFailures = Object.values(report.failures).reduce((sum, value) => sum + value, 0);
    let recoverySucceeded = false;
    try {
      await users[0]!.client.call("read", {
        workspaceId: users[0]!.workspaceId,
        path: "small.txt",
        limit: 2,
      }, "capacity_recovery", metrics);
      recoverySucceeded = true;
    } catch {}
    return {
      requests: requestCount,
      successes: settled.filter((result) => result.status === "fulfilled").length,
      overloads,
      otherFailures: totalFailures - overloads,
      recoverySucceeded,
      durationMs: rounded(performance.now() - startedAt),
      metrics: metrics.report(),
    };
  } finally {
    await Promise.allSettled(sessions.map(({ user, sessionId }) => user.client.call("write_stdin", {
      workspaceId: user.workspaceId,
      sessionId,
      chars: "\u0003",
      yieldTimeMs: 1_000,
      maxOutputTokens: 100,
    }, "capacity_process_cleanup", metrics)));
  }
}

async function runSessionChurn(options: StressRunOptions, metrics: StressMetrics): Promise<void> {
  await parallelMap(
    Array.from({ length: options.churnSessions }, (_, index) => index),
    Math.min(options.concurrency, 32),
    async (index) => {
      const client = new McpStressClient(
        options.url,
        metrics,
        options.timeoutMs,
        `devspace-churn-${index}`,
      );
      try {
        await client.connect();
        await client.listTools();
      } finally {
        await client.close();
      }
    },
  );
}

function uniqueWorkspaceUsers(users: VirtualUser[]): VirtualUser[] {
  const seen = new Set<string>();
  return users.filter((user) => {
    if (seen.has(user.workspacePath)) return false;
    seen.add(user.workspacePath);
    return true;
  });
}

function buildChecks(
  operations: Record<string, LatencySummary>,
  failures: Record<string, number>,
  longTasks: StressRunReport["longTasks"],
  readTarget: number,
  writeTarget: number,
  capacityBoundary: CapacityBoundaryReport | undefined,
  recovery: RecoveryScenarioReport | undefined,
): StressCheck[] {
  const totalFailures = Object.values(failures).reduce((sum, value) => sum + value, 0);
  const checks: StressCheck[] = [
    {
      name: "read_p95",
      passed: (operations.read?.count ?? 0) > 0 && (operations.read?.p95Ms ?? Infinity) < readTarget,
      actual: operations.read?.p95Ms ?? "missing",
      expected: `< ${readTarget} ms`,
    },
    {
      name: "write_p95",
      passed: (operations.write?.count ?? 0) > 0 && (operations.write?.p95Ms ?? Infinity) < writeTarget,
      actual: operations.write?.p95Ms ?? "missing",
      expected: `< ${writeTarget} ms`,
    },
    {
      name: "unexpected_failures",
      passed: totalFailures === 0,
      actual: totalFailures,
      expected: "0",
    },
    {
      name: "long_task_streaming",
      passed: longTasks.every((task) => task.chunksSeen === 5),
      actual: longTasks.length === 0 ? "disabled" : longTasks.map((task) => task.chunksSeen).join(","),
      expected: "5 chunks per task",
    },
  ];
  if (capacityBoundary) {
    checks.push(
      {
        name: "capacity_boundary_handles_load",
        passed: capacityBoundary.successes > 0
          && (capacityBoundary.overloads > 0 || capacityBoundary.successes === capacityBoundary.requests)
          && capacityBoundary.otherFailures === 0,
        actual: `${capacityBoundary.successes} success, ${capacityBoundary.overloads} overload, ${capacityBoundary.otherFailures} other`,
        expected: "all accepted or explicit overload responses, with no other failures",
      },
      {
        name: "capacity_boundary_recovers",
        passed: capacityBoundary.recoverySucceeded,
        actual: capacityBoundary.recoverySucceeded,
        expected: "true",
      },
    );
  }
  if (recovery) {
    checks.push(
      {
        name: "large_file_streaming",
        passed: recovery.largeFilePaged,
        actual: `${recovery.largeFilePagesRead} pages`,
        expected: "more than one bounded page and a complete cursor walk",
      },
      {
        name: "workspace_release_restore",
        passed: recovery.workspaceReleased
          && recovery.workspaceRecoverable
          && recovery.workspaceRestored,
        actual: `${recovery.workspaceReleased}/${recovery.workspaceRecoverable}/${recovery.workspaceRestored}`,
        expected: "released/recoverable/restored all true",
      },
    );
  }
  return checks;
}

async function parallelMap<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      await operation(values[index]!);
    }
  }));
}

function validateOptions(options: StressRunOptions): void {
  if (!options.workspacePaths.length) throw new Error("at least one workspace is required");
  for (const [name, value] of [
    ["concurrency", options.concurrency],
    ["operationsPerClient", options.operationsPerClient],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isInteger(options.churnSessions) || options.churnSessions < 0) {
    throw new Error("churnSessions must be a non-negative integer");
  }
  if (options.capacityRequests !== undefined && (!Number.isInteger(options.capacityRequests) || options.capacityRequests < 1)) {
    throw new Error("capacityRequests must be a positive integer");
  }
  if (options.thinkTimeMs !== undefined && (!Number.isFinite(options.thinkTimeMs) || options.thinkTimeMs < 0)) {
    throw new Error("thinkTimeMs must be non-negative");
  }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
