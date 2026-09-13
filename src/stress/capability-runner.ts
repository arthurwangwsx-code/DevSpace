import { McpStressClient, type ToolResult } from "./mcp-client.js";
import { StressMetrics, type LatencySummary } from "./metrics.js";

export interface CapabilityStressOptions {
  restUrl: string;
  mcpUrl: string;
  providerId: string;
  echoCapabilityId: string;
  delayCapabilityId: string;
  largeOutputCapabilityId: string;
  crashCapabilityId: string;
  concurrency: number;
  operationsPerClient: number;
  churnSessions: number;
  durationMs?: number;
  thinkTimeMs?: number;
  timeoutMs?: number;
  discoveryP95TargetMs?: number;
  invocationP95TargetMs?: number;
  capacityRequests?: number;
  runFaultInjection?: boolean;
  providerRecoveryTimeoutMs?: number;
  trackedInvocationLimit?: number;
}

export interface CapabilityStressCheck {
  name: string;
  passed: boolean;
  actual: string | number | boolean;
  expected: string;
}

export interface CapabilityCapacityReport {
  requests: number;
  accepted: number;
  rateLimited: number;
  otherFailures: number;
  terminal: number;
  recoverySucceeded: boolean;
}

export interface CapabilityFaultReport {
  idempotencyStable: boolean;
  cancellationStatus: string;
  policyDenialCode: string;
  timeoutCode: string;
  outputLimitCode: string;
  providerUnavailableObserved: boolean;
  providerRecovered: boolean;
  providerRecoveryMs: number;
  postRecoveryInvocation: boolean;
}

export interface CapabilityStressReport {
  ok: boolean;
  startedAt: string;
  durationMs: number;
  options: CapabilityStressOptions;
  totals: {
    attemptedInvocations: number;
    completedInvocations: number;
    churnSessions: number;
  };
  metrics: ReturnType<StressMetrics["report"]>;
  checks: CapabilityStressCheck[];
  catalogRevisions: number[];
  capacity?: CapabilityCapacityReport;
  faults?: CapabilityFaultReport;
  finalRuntimeStats: Record<string, unknown>;
}

interface VirtualUser {
  index: number;
  mcp: McpStressClient;
}

interface Envelope<T = unknown> {
  data?: T;
  error?: { code?: string; message?: string; retryable?: boolean };
  meta?: { requestId?: string; catalogRevision?: number };
}

export async function runCapabilityStressWorkload(
  options: CapabilityStressOptions,
): Promise<CapabilityStressReport> {
  validateOptions(options);
  const metrics = new StressMetrics();
  const startedAt = new Date();
  const startedMs = performance.now();
  const users: VirtualUser[] = [];
  const catalogRevisions = new Set<number>();
  let attemptedInvocations = 0;
  let completedInvocations = 0;
  const deadline = options.durationMs ? Date.now() + options.durationMs : undefined;

  try {
    await parallelMap(
      Array.from({ length: options.concurrency }, (_, index) => index),
      options.concurrency,
      async (index) => {
        const mcp = new McpStressClient(
          options.mcpUrl,
          metrics,
          options.timeoutMs,
          `devspace-capability-stress-${index}`,
        );
        await mcp.connect();
        const toolCount = await mcp.listTools();
        if (toolCount !== 8) throw new Error(`fixed capability MCP exposed ${toolCount} tools instead of 8`);
        users[index] = { index, mcp };
      },
    );

    const discovery = await restRequest<any>(
      options,
      metrics,
      "rest_catalog_list",
      "GET",
      `/capabilities?providerId=${encodeURIComponent(options.providerId)}&availableOnly=true`,
    );
    rememberRevision(discovery, catalogRevisions);
    const items = Array.isArray(discovery.data?.items) ? discovery.data.items : [];
    if (items.length < 4) throw new Error(`catalog returned ${items.length} fixture capabilities`);

    const search = await restRequest<any>(
      options,
      metrics,
      "rest_catalog_search",
      "POST",
      "/capabilities/search",
      { query: "echo deterministic", filters: { providerIds: [options.providerId] } },
    );
    rememberRevision(search, catalogRevisions);
    if (!Array.isArray(search.data?.items) || search.data.items.length === 0) {
      throw new Error("capability search did not return the echo fixture");
    }
    const described = await restRequest<any>(
      options,
      metrics,
      "rest_capability_describe",
      "GET",
      `/capabilities/${encodeURIComponent(options.echoCapabilityId)}`,
    );
    rememberRevision(described, catalogRevisions);
    if (described.data?.id !== options.echoCapabilityId) throw new Error("capability descriptor mismatch");

    await Promise.all(users.map(async (user) => {
      let operation = 0;
      while (deadline ? Date.now() < deadline : operation < options.operationsPerClient) {
        const value = `user-${user.index}-operation-${operation}`;
        attemptedInvocations++;
        try {
          if (operation % 2 === 0) {
            const response = await restRequest<any>(
              options,
              metrics,
              "rest_invoke",
              "POST",
              "/invocations",
              { capabilityId: options.echoCapabilityId, arguments: { value } },
            );
            rememberRevision(response, catalogRevisions);
            if (response.data?.status !== "succeeded" || response.data?.result?.echoed !== value) {
              throw new Error("REST invocation returned an unexpected result");
            }
          } else {
            const response = await user.mcp.call("capability_invoke", {
              capabilityId: options.echoCapabilityId,
              arguments: { value },
            }, "mcp_invoke");
            const data = mcpData<any>(response);
            if (data?.status !== "succeeded" || data?.result?.echoed !== value) {
              throw new Error("MCP invocation returned an unexpected result");
            }
          }
          completedInvocations++;
        } catch {
          // StressMetrics retains the failure and the acceptance checks fail the run.
        }
        operation++;
        if (options.thinkTimeMs) await sleep(options.thinkTimeMs);
      }
    }));

    await runMcpChurn(options, metrics);
    const capacity = options.runFaultInjection === false
      ? undefined
      : await runCapacityBoundary(options);
    const faults = options.runFaultInjection === false
      ? undefined
      : await runFaultScenarios(options);

    const status = await users[0]!.mcp.call("capability_status", {}, "mcp_runtime_status");
    const finalRuntimeStats = mcpData<any>(status)?.router ?? {};
    const metricReport = metrics.report();
    const checks = buildChecks(
      options,
      metricReport.operations,
      metricReport.failures,
      attemptedInvocations,
      completedInvocations,
      catalogRevisions,
      capacity,
      faults,
      finalRuntimeStats,
    );
    return {
      ok: checks.every((check) => check.passed),
      startedAt: startedAt.toISOString(),
      durationMs: rounded(performance.now() - startedMs),
      options: { ...options },
      totals: { attemptedInvocations, completedInvocations, churnSessions: options.churnSessions },
      metrics: metricReport,
      checks,
      catalogRevisions: [...catalogRevisions].sort((left, right) => left - right),
      capacity,
      faults,
      finalRuntimeStats,
    };
  } finally {
    await Promise.allSettled(users.filter(Boolean).map(({ mcp }) => mcp.close()));
  }
}

async function runMcpChurn(options: CapabilityStressOptions, metrics: StressMetrics): Promise<void> {
  await parallelMap(
    Array.from({ length: options.churnSessions }, (_, index) => index),
    Math.min(options.concurrency, 32),
    async (index) => {
      const client = new McpStressClient(
        options.mcpUrl,
        metrics,
        options.timeoutMs,
        `devspace-capability-churn-${index}`,
      );
      try {
        await client.connect();
        if (await client.listTools() !== 8) throw new Error("capability MCP tool count changed during churn");
      } finally {
        await client.close();
      }
    },
  );
}

async function runCapacityBoundary(options: CapabilityStressOptions): Promise<CapabilityCapacityReport> {
  const requests = options.capacityRequests ?? 32;
  const settled = await Promise.all(Array.from({ length: requests }, (_, index) => rawRest<any>(
    options,
    "POST",
    "/invocations",
    {
      capabilityId: options.delayCapabilityId,
      arguments: { value: `capacity-${index}`, delayMs: 150 },
      mode: "async",
    },
  )));
  const accepted = settled.filter((result) => result.status === 202 || result.status === 200);
  const rateLimited = settled.filter((result) => result.envelope.error?.code === "rate_limited").length;
  const otherFailures = settled.length - accepted.length - rateLimited;
  let terminal = 0;
  for (const response of accepted) {
    const invocationId = (response.envelope.data as any)?.id;
    if (typeof invocationId !== "string") continue;
    const invocation = await waitForInvocation(options, invocationId, 10_000);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(invocation.status)) terminal++;
  }
  const recovery = await rawRest<any>(options, "POST", "/invocations", {
    capabilityId: options.echoCapabilityId,
    arguments: { value: "capacity-recovery" },
  });
  return {
    requests,
    accepted: accepted.length,
    rateLimited,
    otherFailures,
    terminal,
    recoverySucceeded: recovery.status === 200
      && (recovery.envelope.data as any)?.result?.echoed === "capacity-recovery",
  };
}

async function runFaultScenarios(options: CapabilityStressOptions): Promise<CapabilityFaultReport> {
  const idempotencyKey = `stress-${Date.now()}-${Math.random()}`;
  const idempotencyBody = {
    capabilityId: options.echoCapabilityId,
    arguments: { value: "idempotency" },
    idempotencyKey,
  };
  const first = await expectSuccess<any>(await rawRest(options, "POST", "/invocations", idempotencyBody));
  const second = await expectSuccess<any>(await rawRest(options, "POST", "/invocations", idempotencyBody));

  const asynchronous = await rawRest<any>(options, "POST", "/invocations", {
    capabilityId: options.delayCapabilityId,
    arguments: { value: "cancel-me", delayMs: 2_000 },
    mode: "async",
  });
  const asynchronousId = (await expectSuccess<any>(asynchronous)).id as string;
  await sleep(25);
  await rawRest(options, "POST", `/invocations/${encodeURIComponent(asynchronousId)}/cancel`);
  const cancelled = await waitForInvocation(options, asynchronousId, 5_000);

  const policyDenial = await rawRest(options, "POST", "/invocations", {
    capabilityId: options.echoCapabilityId,
    arguments: { value: "safe", password: "must-never-be-forwarded" },
  });
  const timedOut = await rawRest(options, "POST", "/invocations", {
    capabilityId: options.delayCapabilityId,
    arguments: { value: "timeout", delayMs: 250 },
    timeoutMs: 20,
  });
  const tooLarge = await rawRest(options, "POST", "/invocations", {
    capabilityId: options.largeOutputCapabilityId,
    arguments: { bytes: 128 * 1_024 },
  });

  const recoveryStarted = performance.now();
  const crash = await rawRest(options, "POST", "/invocations", {
    capabilityId: options.crashCapabilityId,
    arguments: { token: idempotencyKey },
  });
  await expectSuccess(crash);
  let providerUnavailableObserved = false;
  let providerRecovered = false;
  const deadline = Date.now() + (options.providerRecoveryTimeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const state = await providerState(options);
    if (state !== "ready" && state !== "degraded") providerUnavailableObserved = true;
    if (providerUnavailableObserved && (state === "ready" || state === "degraded")) {
      providerRecovered = true;
      break;
    }
    await sleep(50);
  }
  const providerRecoveryMs = rounded(performance.now() - recoveryStarted);
  const postRecovery = providerRecovered
    ? await rawRest<any>(options, "POST", "/invocations", {
      capabilityId: options.echoCapabilityId,
      arguments: { value: "post-recovery" },
    })
    : undefined;

  return {
    idempotencyStable: first.id === second.id,
    cancellationStatus: cancelled.status,
    policyDenialCode: policyDenial.envelope.error?.code ?? "missing",
    timeoutCode: timedOut.envelope.error?.code ?? "missing",
    outputLimitCode: tooLarge.envelope.error?.code ?? "missing",
    providerUnavailableObserved,
    providerRecovered,
    providerRecoveryMs,
    postRecoveryInvocation: postRecovery?.status === 200
      && (postRecovery.envelope.data as any)?.result?.echoed === "post-recovery",
  };
}

function buildChecks(
  options: CapabilityStressOptions,
  operations: Record<string, LatencySummary>,
  failures: Record<string, number>,
  attempted: number,
  completed: number,
  revisions: Set<number>,
  capacity: CapabilityCapacityReport | undefined,
  faults: CapabilityFaultReport | undefined,
  runtime: Record<string, unknown>,
): CapabilityStressCheck[] {
  const discoveryP95 = Math.max(
    operations.rest_catalog_list?.p95Ms ?? 0,
    operations.rest_catalog_search?.p95Ms ?? 0,
    operations.rest_capability_describe?.p95Ms ?? 0,
  );
  const invocationP95 = Math.max(
    operations.rest_invoke?.p95Ms ?? 0,
    operations.mcp_invoke?.p95Ms ?? 0,
  );
  const totalFailures = Object.values(failures).reduce((sum, value) => sum + value, 0);
  const checks: CapabilityStressCheck[] = [
    check("fixed_mcp_surface", true, "8 tools throughout initialization and churn"),
    check("discovery_p95", discoveryP95 < (options.discoveryP95TargetMs ?? 100), `< ${options.discoveryP95TargetMs ?? 100} ms`, discoveryP95),
    check("invocation_p95", invocationP95 < (options.invocationP95TargetMs ?? 150), `< ${options.invocationP95TargetMs ?? 150} ms`, invocationP95),
    check("business_invocations", attempted > 0 && attempted === completed, "all attempted calls succeed", `${completed}/${attempted}`),
    check("unexpected_failures", totalFailures === 0, "0", totalFailures),
    check("catalog_revision_consistent", revisions.size === 1, "one stable revision during normal load", [...revisions].join(",")),
    check("runtime_drained", runtime.active === 0 && runtime.queued === 0, "active=0 and queued=0", `${runtime.active ?? "missing"}/${runtime.queued ?? "missing"}`),
  ];
  if (options.trackedInvocationLimit !== undefined) checks.push(check(
    "runtime_history_bounded",
    typeof runtime.trackedInvocations === "number"
      && runtime.trackedInvocations <= options.trackedInvocationLimit,
    `<= ${options.trackedInvocationLimit}`,
    typeof runtime.trackedInvocations === "number" ? runtime.trackedInvocations : "missing",
  ));
  if (capacity) checks.push(
    check(
      "capacity_boundary",
      capacity.accepted > 0 && capacity.otherFailures === 0
        && (capacity.rateLimited > 0 || capacity.accepted === capacity.requests),
      "accepted or explicit rate_limited only",
      `${capacity.accepted} accepted, ${capacity.rateLimited} rate_limited, ${capacity.otherFailures} other`,
    ),
    check("capacity_terminal", capacity.terminal === capacity.accepted, "all accepted invocations terminal", `${capacity.terminal}/${capacity.accepted}`),
    check("capacity_recovery", capacity.recoverySucceeded, "true"),
  );
  if (faults) checks.push(
    check("idempotency", faults.idempotencyStable, "same invocation id"),
    check("async_cancellation", faults.cancellationStatus === "cancelled", "cancelled", faults.cancellationStatus),
    check("secure_intent_denied", faults.policyDenialCode === "policy_denied", "policy_denied", faults.policyDenialCode),
    check("timeout_normalized", faults.timeoutCode === "timeout", "timeout", faults.timeoutCode),
    check("output_limit", faults.outputLimitCode === "output_too_large", "output_too_large", faults.outputLimitCode),
    check("provider_failure_observed", faults.providerUnavailableObserved, "true"),
    check("provider_recovered", faults.providerRecovered, "true"),
    check("post_recovery_invocation", faults.postRecoveryInvocation, "true"),
  );
  return checks;
}

function check(
  name: string,
  passed: boolean,
  expected: string,
  actual: string | number | boolean = passed,
): CapabilityStressCheck {
  return { name, passed, actual, expected };
}

async function restRequest<T>(
  options: CapabilityStressOptions,
  metrics: StressMetrics,
  metricName: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Envelope<T>> {
  return metrics.measure(metricName, async () => {
    const response = await rawRest<T>(options, method, path, body);
    if (response.status < 200 || response.status >= 300 || response.envelope.error) {
      throw new Error(`${method} ${path} failed with ${response.status}/${response.envelope.error?.code ?? "unknown"}`);
    }
    return response.envelope;
  });
}

async function rawRest<T>(
  options: CapabilityStressOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; envelope: Envelope<T> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("request timeout"), options.timeoutMs ?? 30_000);
  try {
    const response = await fetch(`${options.restUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const envelope = await response.json() as Envelope<T>;
    return { status: response.status, envelope };
  } finally {
    clearTimeout(timer);
  }
}

async function expectSuccess<T>(response: { status: number; envelope: Envelope<T> }): Promise<T> {
  if (response.status < 200 || response.status >= 300 || response.envelope.error || response.envelope.data === undefined) {
    throw new Error(`expected success, received ${response.status}/${response.envelope.error?.code ?? "missing data"}`);
  }
  return response.envelope.data;
}

async function waitForInvocation(
  options: CapabilityStressOptions,
  invocationId: string,
  timeoutMs: number,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await rawRest<any>(
      options,
      "GET",
      `/invocations/${encodeURIComponent(invocationId)}`,
    );
    const invocation = await expectSuccess(response);
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(invocation.status)) return invocation;
    await sleep(20);
  }
  throw new Error(`invocation ${invocationId} did not become terminal`);
}

async function providerState(options: CapabilityStressOptions): Promise<string> {
  const response = await expectSuccess<any>(await rawRest(
    options,
    "GET",
    `/providers/${encodeURIComponent(options.providerId)}`,
  ));
  return String(response.health?.state ?? "missing");
}

function mcpData<T>(result: ToolResult): T {
  const data = result.structuredContent?.data;
  if (data === undefined) throw new Error("capability MCP result has no data");
  return data as T;
}

function rememberRevision(envelope: Envelope, revisions: Set<number>): void {
  if (typeof envelope.meta?.catalogRevision === "number") revisions.add(envelope.meta.catalogRevision);
}

async function parallelMap<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) await operation(values[next++]!);
  }));
}

function validateOptions(options: CapabilityStressOptions): void {
  for (const [name, value] of [
    ["concurrency", options.concurrency],
    ["operationsPerClient", options.operationsPerClient],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (!Number.isInteger(options.churnSessions) || options.churnSessions < 0) {
    throw new Error("churnSessions must be a non-negative integer");
  }
  if (options.capacityRequests !== undefined
    && (!Number.isInteger(options.capacityRequests) || options.capacityRequests < 1)) {
    throw new Error("capacityRequests must be a positive integer");
  }
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
