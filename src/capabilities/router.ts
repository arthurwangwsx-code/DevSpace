import { randomUUID } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import {
  DEFAULT_CAPABILITY_INVOCATION_RETENTION_MS,
  DEFAULT_CAPABILITY_MAX_TRACKED_INVOCATIONS,
  SqliteCapabilityAuditStore,
  digest,
} from "./audit-store.js";
import { jsonValueSchema } from "./descriptor-schema.js";
import { CapabilityError, normalizeCapabilityError } from "./errors.js";
import { CapabilityLeaseManager } from "./leases.js";
import { CapabilityPolicyEngine } from "./policy.js";
import {
  enforceSessionRequirements,
  SystemSessionStateProbe,
  type SessionStateProbe,
} from "./session-state.js";
import type { ProviderLease } from "./provider.js";
import type { ProviderSupervisor } from "./provider-supervisor.js";
import type { CapabilityBinding, CapabilityRegistry } from "./registry.js";
import type {
  CapabilityDescriptor,
  CapabilityInvocation,
  CapabilityLease,
  CapabilityPrincipal,
  InvocationStatus,
  JsonObject,
  JsonValue,
} from "./types.js";

export interface CapabilityRouterOptions {
  maxConcurrent?: number;
  maxConcurrentPerProvider?: number;
  queueLimit?: number;
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  maxTrackedInvocations?: number;
  invocationRetentionMs?: number;
  onEvent?: (type: string, data: JsonObject) => void;
  sessionStateProbe?: SessionStateProbe;
}

export interface OpenLeaseRequest {
  requestId: string;
  principal: CapabilityPrincipal;
  providerId: string;
  resourceType: string;
  selector: JsonObject;
  ttlMs?: number;
}

export interface InvokeCapabilityRequest {
  requestId: string;
  principal: CapabilityPrincipal;
  capabilityId: string;
  arguments: JsonValue;
  leaseId?: string;
  mode?: "sync" | "async";
  timeoutMs?: number;
  idempotencyKey?: string;
}

interface InternalInvocation {
  public: CapabilityInvocation;
  principal: CapabilityPrincipal;
  requestId: string;
  arguments: JsonValue;
  descriptor: CapabilityDescriptor;
  binding: CapabilityBinding;
  providerLease?: ProviderLease;
  timeoutMs: number;
  controller: AbortController;
  cancelRequested: boolean;
  timedOut: boolean;
  idempotencyKey?: string;
  completion: Promise<CapabilityInvocation>;
  resolve: (value: CapabilityInvocation) => void;
  reject: (error: CapabilityError) => void;
}

export class CapabilityInvocationRouter {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: false });
  private readonly validators = new Map<string, ValidateFunction>();
  private readonly invocations = new Map<string, InternalInvocation>();
  private readonly idempotency = new Map<string, { invocationId: string; digest: string }>();
  private readonly queue: InternalInvocation[] = [];
  private readonly activeByProvider = new Map<string, number>();
  private active = 0;
  private closed = false;
  private readonly options: Required<Omit<CapabilityRouterOptions, "onEvent" | "sessionStateProbe">>;
  private readonly onEvent: NonNullable<CapabilityRouterOptions["onEvent"]>;
  private readonly sessionStateProbe: SessionStateProbe;

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly supervisor: ProviderSupervisor,
    readonly policy: CapabilityPolicyEngine,
    readonly leases: CapabilityLeaseManager,
    private readonly audit: SqliteCapabilityAuditStore,
    options: CapabilityRouterOptions = {},
  ) {
    this.options = {
      maxConcurrent: options.maxConcurrent ?? 8,
      maxConcurrentPerProvider: options.maxConcurrentPerProvider ?? 2,
      queueLimit: options.queueLimit ?? 64,
      maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      maxTimeoutMs: options.maxTimeoutMs ?? 120_000,
      maxTrackedInvocations: options.maxTrackedInvocations
        ?? DEFAULT_CAPABILITY_MAX_TRACKED_INVOCATIONS,
      invocationRetentionMs: options.invocationRetentionMs
        ?? DEFAULT_CAPABILITY_INVOCATION_RETENTION_MS,
    };
    this.onEvent = options.onEvent ?? (() => {});
    this.sessionStateProbe = options.sessionStateProbe ?? new SystemSessionStateProbe();
    if (this.options.maxConcurrent < 1 || this.options.maxConcurrentPerProvider < 1
      || this.options.maxConcurrentPerProvider > this.options.maxConcurrent
      || this.options.queueLimit < 0 || this.options.maxOutputBytes < 1
      || this.options.maxTrackedInvocations < 1 || this.options.invocationRetentionMs < 1_000) {
      throw new Error("Invalid capability router resource limits.");
    }
  }

  get stats(): {
    active: number;
    queued: number;
    trackedInvocations: number;
    activeLeases: number;
    activeByProvider: Record<string, number>;
  } {
    return {
      active: this.active,
      queued: this.queue.length,
      trackedInvocations: this.invocations.size,
      activeLeases: this.leases.size,
      activeByProvider: Object.fromEntries(
        [...this.activeByProvider.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
  }

  async openLease(request: OpenLeaseRequest): Promise<CapabilityLease> {
    this.assertOpen();
    try {
      this.policy.authorizeOpen(request);
    } catch (error) {
      this.recordPolicyDenial(request.requestId, request.principal, undefined, request.providerId, error);
      throw error;
    }
    const requirements = this.registry.runtimeRequirementsForResource(
      request.providerId,
      request.resourceType,
    );
    if (requirements) {
      await enforceSessionRequirements(
        requirements,
        this.sessionStateProbe,
        new AbortController().signal,
      );
    }
    const health = this.supervisor.getHealth(request.providerId);
    requireReadyHealth(health?.state, health?.userAction);
    const providerLease = await this.supervisor.openResource(
      request.providerId,
      { resourceType: request.resourceType, selector: request.selector },
      new AbortController().signal,
    );
    try {
      this.policy.authorizeOpenTarget({
        principal: request.principal,
        providerId: request.providerId,
        resourceType: request.resourceType,
        display: providerLease.display,
      });
    } catch (error) {
      await this.supervisor.closeResource(
        request.providerId,
        providerLease,
        new AbortController().signal,
      ).catch(() => {});
      this.recordPolicyDenial(request.requestId, request.principal, undefined, request.providerId, error);
      throw error;
    }
    const lease = this.leases.create({
      principal: request.principal,
      providerId: request.providerId,
      resourceType: request.resourceType,
      providerLease,
      ttlMs: request.ttlMs,
    });
    this.audit.recordEvent({
      requestId: request.requestId,
      principalId: request.principal.id,
      eventType: "capability.lease.opened",
      providerId: request.providerId,
      decision: "allowed",
      summary: { leaseId: lease.id, resourceType: lease.resourceType, display: lease.display },
    });
    this.onEvent("lease.opened", { leaseId: lease.id, providerId: lease.providerId });
    return lease;
  }

  async closeLease(input: {
    requestId: string;
    principal: CapabilityPrincipal;
    leaseId: string;
  }): Promise<void> {
    const record = this.leases.close(input.leaseId, input.principal);
    await this.supervisor.closeResource(
      record.lease.providerId,
      record.providerLease,
      new AbortController().signal,
    ).catch(() => {});
    this.audit.recordEvent({
      requestId: input.requestId,
      principalId: input.principal.id,
      eventType: "capability.lease.closed",
      providerId: record.lease.providerId,
      decision: "allowed",
      summary: { leaseId: record.lease.id, resourceType: record.lease.resourceType },
    });
    this.onEvent("lease.closed", { leaseId: record.lease.id, providerId: record.lease.providerId });
  }

  async invoke(request: InvokeCapabilityRequest): Promise<CapabilityInvocation> {
    this.assertOpen();
    const descriptor = this.registry.getDescriptor(request.capabilityId);
    if (!descriptor) {
      throw new CapabilityError("capability_not_found", `Unknown capability: ${request.capabilityId}`);
    }
    const mode = request.mode ?? "sync";
    if (!descriptor.execution.modes.includes(mode)) {
      throw new CapabilityError("invalid_arguments", `Capability does not support ${mode} mode.`);
    }
    this.validate(`${descriptor.id}@${descriptor.version}:input`, descriptor.inputSchema, request.arguments);
    await enforceSessionRequirements(
      descriptor.availability,
      this.sessionStateProbe,
      new AbortController().signal,
    );
    const health = this.supervisor.getHealth(descriptor.providerId);
    requireReadyHealth(health?.state, health?.userAction);
    const leaseRecord = descriptor.execution.requiresLease
      ? this.requireLease(request, descriptor)
      : undefined;
    try {
      this.policy.authorizeInvocation({
        principal: request.principal,
        descriptor,
        arguments: request.arguments,
        lease: leaseRecord?.lease,
      });
    } catch (error) {
      this.recordPolicyDenial(
        request.requestId,
        request.principal,
        descriptor.id,
        descriptor.providerId,
        error,
      );
      throw error;
    }

    const timeoutMs = this.resolveTimeout(descriptor, request.timeoutMs);
    const argumentsDigest = digest(request.arguments);
    if (request.idempotencyKey) {
      const key = `${request.principal.id}:${request.idempotencyKey}`;
      const previous = this.idempotency.get(key);
      if (previous) {
        if (previous.digest !== `${descriptor.id}:${argumentsDigest}`) {
          throw new CapabilityError("conflict", "The idempotency key was reused with different input.");
        }
        if (this.invocations.has(previous.invocationId)) {
          return this.getInvocation(previous.invocationId, request.principal);
        }
        this.idempotency.delete(key);
      }
    }
    this.pruneTrackedInvocations(1);
    if (this.invocations.size >= this.options.maxTrackedInvocations) {
      throw new CapabilityError("rate_limited", "The capability invocation history is at capacity.");
    }
    if (!this.canStart(descriptor.providerId) && this.queue.length >= this.options.queueLimit) {
      throw new CapabilityError("rate_limited", "The capability invocation queue is full.");
    }

    const internal = createInternalInvocation({
      request,
      descriptor,
      binding: this.registry.getBinding(descriptor.id),
      providerLease: leaseRecord?.providerLease,
      timeoutMs,
    });
    internal.completion.catch(() => {});
    this.invocations.set(internal.public.id, internal);
    if (request.idempotencyKey) {
      internal.idempotencyKey = `${request.principal.id}:${request.idempotencyKey}`;
      this.idempotency.set(internal.idempotencyKey, {
        invocationId: internal.public.id,
        digest: `${descriptor.id}:${argumentsDigest}`,
      });
    }
    this.audit.saveInvocation(internal.public, internal.arguments);
    this.audit.recordEvent({
      requestId: request.requestId,
      principalId: request.principal.id,
      eventType: "capability.invocation.queued",
      capabilityId: descriptor.id,
      providerId: descriptor.providerId,
      decision: "allowed",
      summary: { invocationId: internal.public.id, leaseId: request.leaseId },
    });
    this.onEvent("invocation.queued", {
      invocationId: internal.public.id,
      capabilityId: descriptor.id,
      providerId: descriptor.providerId,
      status: internal.public.status,
    });
    if (this.canStart(descriptor.providerId)) this.startInvocation(internal);
    else this.queue.push(internal);
    return mode === "async" ? publicInvocation(internal.public) : internal.completion;
  }

  getInvocation(invocationId: string, principal: CapabilityPrincipal): CapabilityInvocation {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new CapabilityError("capability_not_found", "Unknown invocation.");
    if (invocation.public.principalId !== principal.id) {
      throw new CapabilityError("policy_denied", "The invocation belongs to another principal.");
    }
    return publicInvocation(invocation.public);
  }

  cancelInvocation(input: {
    requestId: string;
    invocationId: string;
    principal: CapabilityPrincipal;
  }): CapabilityInvocation {
    const internal = this.invocations.get(input.invocationId);
    if (!internal) throw new CapabilityError("capability_not_found", "Unknown invocation.");
    if (internal.public.principalId !== input.principal.id) {
      throw new CapabilityError("policy_denied", "The invocation belongs to another principal.");
    }
    if (isTerminal(internal.public.status)) return publicInvocation(internal.public);
    internal.cancelRequested = true;
    const queueIndex = this.queue.indexOf(internal);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      this.finishFailure(internal, new CapabilityError("cancelled", "Invocation cancelled."), "cancelled");
    } else {
      internal.controller.abort("cancelled");
    }
    this.audit.recordEvent({
      requestId: input.requestId,
      principalId: input.principal.id,
      eventType: "capability.invocation.cancelled",
      capabilityId: internal.public.capabilityId,
      providerId: internal.public.providerId,
      decision: "allowed",
      summary: { invocationId: internal.public.id },
    });
    this.onEvent("invocation.cancel_requested", {
      invocationId: internal.public.id,
      status: internal.public.status,
    });
    return publicInvocation(internal.public);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const invocation of this.invocations.values()) {
      if (!isTerminal(invocation.public.status)) {
        invocation.cancelRequested = true;
        if (invocation.public.status === "queued") {
          this.finishFailure(
            invocation,
            new CapabilityError("cancelled", "Invocation cancelled during shutdown."),
            "cancelled",
          );
        } else {
          invocation.controller.abort("server_shutdown");
        }
      }
    }
    this.queue.splice(0);
    await Promise.all(this.leases.takeAll().map((record) =>
      this.supervisor.closeResource(
        record.lease.providerId,
        record.providerLease,
        new AbortController().signal,
      ).catch(() => {})));
  }

  private requireLease(request: InvokeCapabilityRequest, descriptor: CapabilityDescriptor) {
    if (!request.leaseId) {
      throw new CapabilityError("lease_required", "This capability requires a resource lease.");
    }
    return this.leases.get(request.leaseId, request.principal, {
      providerId: descriptor.providerId,
      resourceTypes: descriptor.execution.resourceTypes,
    });
  }

  private startInvocation(internal: InternalInvocation): void {
    this.active += 1;
    this.activeByProvider.set(
      internal.public.providerId,
      (this.activeByProvider.get(internal.public.providerId) ?? 0) + 1,
    );
    internal.public.status = "running";
    internal.public.startedAt = new Date().toISOString();
    this.audit.saveInvocation(internal.public, internal.arguments);
    this.onEvent("invocation.running", {
      invocationId: internal.public.id,
      capabilityId: internal.public.capabilityId,
      providerId: internal.public.providerId,
      status: "running",
    });
    void this.runInvocation(internal);
  }

  private async runInvocation(internal: InternalInvocation): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          internal.timedOut = true;
          internal.controller.abort("timeout");
          reject(new CapabilityError("timeout", "Capability invocation timed out."));
        }, internal.timeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        internal.controller.signal.addEventListener("abort", () => {
          reject(new CapabilityError(
            internal.timedOut ? "timeout" : "cancelled",
            internal.timedOut ? "Capability invocation timed out." : "Invocation cancelled.",
          ));
        }, { once: true });
      });
      const result = await Promise.race([
        internal.binding.invoke(internal.arguments, {
          signal: internal.controller.signal,
          lease: internal.providerLease,
          principal: internal.principal,
        }),
        timeout,
        aborted,
      ]);
      const parsed = jsonValueSchema.safeParse(result);
      if (!parsed.success) throw new CapabilityError("internal_error", "Provider returned non-JSON output.");
      const outputBytes = Buffer.byteLength(JSON.stringify(parsed.data), "utf8");
      if (outputBytes > this.options.maxOutputBytes) {
        throw new CapabilityError("output_too_large", "Capability output exceeded the configured limit.");
      }
      if (internal.descriptor.outputSchema) {
        this.validate(
          `${internal.descriptor.id}@${internal.descriptor.version}:output`,
          internal.descriptor.outputSchema,
          parsed.data,
          "Provider returned output that does not match its schema.",
          "internal_error",
        );
      }
      internal.public.status = "succeeded";
      internal.public.result = parsed.data;
      internal.public.finishedAt = new Date().toISOString();
      this.audit.saveInvocation(internal.public, internal.arguments);
      this.audit.recordEvent({
        requestId: internal.requestId,
        principalId: internal.public.principalId,
        eventType: "capability.invocation.succeeded",
        capabilityId: internal.public.capabilityId,
        providerId: internal.public.providerId,
        decision: "allowed",
        summary: { invocationId: internal.public.id, outputBytes },
      });
      this.onEvent("invocation.succeeded", {
        invocationId: internal.public.id,
        capabilityId: internal.public.capabilityId,
        providerId: internal.public.providerId,
        status: "succeeded",
      });
      internal.resolve(publicInvocation(internal.public));
    } catch (error) {
      const normalized = internal.timedOut
        ? new CapabilityError("timeout", "Capability invocation timed out.")
        : internal.cancelRequested
          ? new CapabilityError("cancelled", "Invocation cancelled.")
          : normalizeCapabilityError(error);
      const status: InvocationStatus = normalized.code === "timeout"
        ? "timed_out"
        : normalized.code === "cancelled" ? "cancelled" : "failed";
      this.finishFailure(internal, normalized, status);
    } finally {
      if (timer) clearTimeout(timer);
      this.active -= 1;
      const providerActive = (this.activeByProvider.get(internal.public.providerId) ?? 1) - 1;
      if (providerActive > 0) this.activeByProvider.set(internal.public.providerId, providerActive);
      else this.activeByProvider.delete(internal.public.providerId);
      this.drainQueue();
    }
  }

  private finishFailure(
    internal: InternalInvocation,
    error: CapabilityError,
    status: InvocationStatus,
  ): void {
    if (isTerminal(internal.public.status)) return;
    internal.public.status = status;
    internal.public.errorCode = error.code;
    internal.public.finishedAt = new Date().toISOString();
    this.audit.saveInvocation(internal.public, internal.arguments);
    this.audit.recordEvent({
      requestId: internal.requestId,
      principalId: internal.public.principalId,
      eventType: status === "cancelled"
        ? "capability.invocation.cancelled"
        : "capability.invocation.failed",
      capabilityId: internal.public.capabilityId,
      providerId: internal.public.providerId,
      decision: "allowed",
      summary: { invocationId: internal.public.id, errorCode: error.code },
    });
    this.onEvent(`invocation.${status}`, {
      invocationId: internal.public.id,
      capabilityId: internal.public.capabilityId,
      providerId: internal.public.providerId,
      status,
      errorCode: error.code,
    });
    internal.reject(new CapabilityError(error.code, error.message, {
      retryable: error.retryable,
      details: { ...(error.details ?? {}), invocationId: internal.public.id },
      cause: error,
    }));
  }

  private drainQueue(): void {
    for (let index = 0; index < this.queue.length;) {
      const invocation = this.queue[index]!;
      if (!this.canStart(invocation.public.providerId)) {
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      this.startInvocation(invocation);
    }
  }

  private canStart(providerId: string): boolean {
    return this.active < this.options.maxConcurrent
      && (this.activeByProvider.get(providerId) ?? 0) < this.options.maxConcurrentPerProvider;
  }

  private resolveTimeout(descriptor: CapabilityDescriptor, requested: number | undefined): number {
    const timeout = requested ?? descriptor.execution.defaultTimeoutMs ?? this.options.defaultTimeoutMs;
    const maximum = Math.min(descriptor.execution.maxTimeoutMs, this.options.maxTimeoutMs);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > maximum) {
      throw new CapabilityError("invalid_arguments", `timeoutMs must be an integer from 1 to ${maximum}.`);
    }
    return timeout;
  }

  private validate(
    cacheKey: string,
    schema: JsonObject,
    value: JsonValue,
    message = "Capability arguments do not match the input schema.",
    errorCode: "invalid_arguments" | "internal_error" = "invalid_arguments",
  ): void {
    let validate = this.validators.get(cacheKey);
    if (!validate) {
      try {
        const compiled = this.ajv.compile(schema);
        this.validators.set(cacheKey, compiled);
        validate = compiled;
      } catch (error) {
        throw new CapabilityError("internal_error", "Capability has an invalid JSON Schema.", {
          cause: error,
        });
      }
    }
    if (!validate(value)) {
      throw new CapabilityError(errorCode, message, {
        details: { errors: (validate.errors ?? []).slice(0, 10) as unknown as JsonValue },
      });
    }
  }

  private recordPolicyDenial(
    requestId: string,
    principal: CapabilityPrincipal,
    capabilityId: string | undefined,
    providerId: string,
    error: unknown,
  ): void {
    const normalized = normalizeCapabilityError(error);
    this.audit.recordEvent({
      requestId,
      principalId: principal.id,
      eventType: "capability.policy.denied",
      capabilityId,
      providerId,
      decision: "denied",
      summary: { errorCode: normalized.code },
    });
  }

  private assertOpen(): void {
    if (this.closed) throw new CapabilityError("provider_unavailable", "Capability runtime is closed.");
  }

  private pruneTrackedInvocations(reserve = 0): void {
    const cutoff = Date.now() - this.options.invocationRetentionMs;
    for (const [id, invocation] of this.invocations) {
      const finishedAt = invocation.public.finishedAt
        ? Date.parse(invocation.public.finishedAt)
        : Number.POSITIVE_INFINITY;
      if (isTerminal(invocation.public.status) && finishedAt <= cutoff) {
        this.evictInvocation(id, invocation);
      }
    }
    if (this.invocations.size + reserve <= this.options.maxTrackedInvocations) return;
    for (const [id, invocation] of this.invocations) {
      if (!isTerminal(invocation.public.status)) continue;
      this.evictInvocation(id, invocation);
      if (this.invocations.size + reserve <= this.options.maxTrackedInvocations) return;
    }
  }

  private evictInvocation(id: string, invocation: InternalInvocation): void {
    this.invocations.delete(id);
    if (invocation.idempotencyKey) this.idempotency.delete(invocation.idempotencyKey);
  }
}

function createInternalInvocation(input: {
  request: InvokeCapabilityRequest;
  descriptor: CapabilityDescriptor;
  binding: CapabilityBinding;
  providerLease?: ProviderLease;
  timeoutMs: number;
}): InternalInvocation {
  let resolve!: (value: CapabilityInvocation) => void;
  let reject!: (error: CapabilityError) => void;
  const completion = new Promise<CapabilityInvocation>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    principal: input.request.principal,
    public: {
      id: `inv_${randomUUID()}`,
      principalId: input.request.principal.id,
      capabilityId: input.descriptor.id,
      providerId: input.descriptor.providerId,
      ...(input.request.leaseId ? { leaseId: input.request.leaseId } : {}),
      status: "queued",
      queuedAt: new Date().toISOString(),
    },
    requestId: input.request.requestId,
    arguments: structuredClone(input.request.arguments),
    descriptor: input.descriptor,
    binding: input.binding,
    providerLease: input.providerLease,
    timeoutMs: input.timeoutMs,
    controller: new AbortController(),
    cancelRequested: false,
    timedOut: false,
    idempotencyKey: undefined,
    completion,
    resolve,
    reject,
  };
}

function requireReadyHealth(state: string | undefined, userAction: string | undefined): void {
  if (state === "ready" || state === "degraded") return;
  if (state === "needs_user_action") {
    throw new CapabilityError("permission_required", "The provider requires user approval.", {
      details: userAction ? { action: userAction } : undefined,
    });
  }
  throw new CapabilityError("provider_unavailable", "The capability provider is unavailable.");
}

function publicInvocation(invocation: CapabilityInvocation): CapabilityInvocation {
  return structuredClone(invocation);
}

function isTerminal(status: InvocationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}
