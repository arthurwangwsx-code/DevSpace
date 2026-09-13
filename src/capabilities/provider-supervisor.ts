import { CapabilityError, normalizeCapabilityError } from "./errors.js";
import type {
  CapabilityProvider,
  ProviderContext,
  ProviderLease,
  ProviderOpenRequest,
  ProviderRegistration,
} from "./provider.js";
import type { CapabilityRegistry } from "./registry.js";
import type { JsonObject, ProviderHealth, ProviderState } from "./types.js";

export interface ProviderSupervisorOptions {
  startupTimeoutMs?: number;
  discoveryTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  maxAttempts?: number;
  random?: () => number;
  scheduler?: ProviderSupervisorScheduler;
  log?: ProviderContext["log"];
}

export interface ProviderSupervisorScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ManagedProvider extends ProviderRegistration {
  health: ProviderHealth;
  attempt: number;
  controller?: AbortController;
  operation?: Promise<void>;
  retryTimer?: unknown;
  generation: number;
}

const defaultScheduler: ProviderSupervisorScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

export class ProviderSupervisor {
  private readonly providers = new Map<string, ManagedProvider>();
  private readonly options: Required<Omit<ProviderSupervisorOptions, "log">> & {
    log: ProviderContext["log"];
  };
  private closed = false;

  constructor(
    private readonly registry: CapabilityRegistry,
    options: ProviderSupervisorOptions = {},
  ) {
    this.options = {
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      discoveryTimeoutMs: options.discoveryTimeoutMs ?? 30_000,
      backoffBaseMs: options.backoffBaseMs ?? 1_000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      maxAttempts: options.maxAttempts ?? 5,
      random: options.random ?? Math.random,
      scheduler: options.scheduler ?? defaultScheduler,
      log: options.log ?? (() => {}),
    };
  }

  register(registration: ProviderRegistration): void {
    if (this.closed) throw new Error("Provider supervisor is closed.");
    if (this.providers.has(registration.provider.id)) {
      throw new CapabilityError("conflict", `Provider already registered: ${registration.provider.id}`);
    }
    const health = healthFor(registration.enabled ? "stopped" : "disabled");
    this.providers.set(registration.provider.id, {
      ...registration,
      health,
      attempt: 0,
      generation: 0,
    });
    this.registry.setProviderHealth(registration.provider.id, health);
  }

  list(): Array<{ id: string; kind: string; enabled: boolean; health: ProviderHealth }> {
    return [...this.providers.values()]
      .map((managed) => ({
        id: managed.provider.id,
        kind: managed.kind,
        enabled: managed.enabled,
        health: { ...managed.health },
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  getHealth(providerId: string): ProviderHealth | undefined {
    const health = this.providers.get(providerId)?.health;
    return health ? { ...health } : undefined;
  }

  async openResource(
    providerId: string,
    request: ProviderOpenRequest,
    signal: AbortSignal,
  ): Promise<ProviderLease> {
    const managed = this.requireReady(providerId);
    if (!managed.provider.open) {
      return { handle: request.selector, display: request.selector };
    }
    return withTimeout(
      managed.provider.open(request, { signal }),
      this.options.discoveryTimeoutMs,
      "Provider resource selection timed out.",
      signal,
    );
  }

  async closeResource(
    providerId: string,
    lease: ProviderLease,
    signal: AbortSignal,
  ): Promise<void> {
    const managed = this.get(providerId);
    if (!managed.provider.close) return;
    await withTimeout(
      managed.provider.close(lease, { signal }),
      this.options.discoveryTimeoutMs,
      "Provider resource release timed out.",
      signal,
    );
  }

  async startAll(): Promise<void> {
    await Promise.all([...this.providers.values()].map((managed) => this.start(managed.provider.id)));
  }

  start(providerId: string): Promise<void> {
    const managed = this.get(providerId);
    if (this.closed) return Promise.reject(new Error("Provider supervisor is closed."));
    if (!managed.enabled) {
      this.transition(managed, healthFor("disabled"));
      return Promise.resolve();
    }
    if (managed.operation) return managed.operation;
    if (managed.health.state === "ready" || managed.health.state === "degraded") {
      return Promise.resolve();
    }

    const operation = this.startAttempt(managed).finally(() => {
      if (managed.operation === operation) managed.operation = undefined;
    });
    managed.operation = operation;
    return operation;
  }

  async restart(providerId: string): Promise<void> {
    const managed = this.get(providerId);
    managed.attempt = 0;
    await this.stop(providerId, "restart");
    if (managed.enabled) await this.start(providerId);
  }

  async stop(providerId: string, reason = "stop"): Promise<void> {
    const managed = this.get(providerId);
    managed.generation += 1;
    this.clearRetry(managed);
    managed.controller?.abort(reason);
    if (managed.operation) await managed.operation.catch(() => {});
    if (managed.health.state === "stopped" || managed.health.state === "disabled") return;

    this.transition(managed, healthFor("stopping"));
    await managed.provider.stop(reason).catch((error: unknown) => {
      this.options.log("warn", "capability.provider.stop_failed", {
        providerId,
        error: normalizeCapabilityError(error).code,
      });
    });
    this.transition(managed, healthFor(managed.enabled ? "stopped" : "disabled"));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.providers.keys()].map((id) => this.stop(id, "server_shutdown")));
  }

  private async startAttempt(managed: ManagedProvider): Promise<void> {
    const generation = ++managed.generation;
    this.clearRetry(managed);
    const controller = new AbortController();
    managed.controller = controller;
    this.transition(managed, healthFor("starting"));
    const context: ProviderContext = {
      signal: controller.signal,
      reportFailure: (error) => {
        if (managed.generation !== generation || this.closed) return;
        void this.handleRuntimeFailure(managed, error);
      },
      log: this.options.log,
    };

    try {
      await withTimeout(
        managed.provider.start(context),
        this.options.startupTimeoutMs,
        "Provider startup timed out.",
        controller.signal,
      );
      if (managed.generation !== generation || controller.signal.aborted) return;

      const reportedHealth = await withTimeout(
        managed.provider.health(controller.signal),
        this.options.startupTimeoutMs,
        "Provider health check timed out.",
        controller.signal,
      );
      if (reportedHealth.state !== "ready" && reportedHealth.state !== "degraded") {
        this.transition(managed, reportedHealth);
        return;
      }

      const discovered = await withTimeout(
        managed.provider.discover(controller.signal),
        this.options.discoveryTimeoutMs,
        "Provider discovery timed out.",
        controller.signal,
      );
      if (managed.generation !== generation || controller.signal.aborted) return;
      const health = { ...reportedHealth, since: new Date().toISOString() };
      this.registry.replaceProviderCatalog({
        providerId: managed.provider.id,
        kind: managed.kind,
        enabled: managed.enabled,
        health,
        manifestDigest: managed.manifestDigest,
        capabilities: discovered.map((capability) => ({
          descriptor: capability.descriptor,
          aliases: capability.aliases,
          binding: {
            invoke: (argumentsValue, context) => managed.provider.invoke({
              capabilityId: capability.descriptor.id,
              descriptor: capability.descriptor,
              binding: capability.binding,
              arguments: argumentsValue,
              lease: context.lease,
            }, { signal: context.signal }),
          },
        })),
      });
      managed.attempt = 0;
      this.transition(managed, health);
    } catch (error) {
      if (managed.generation !== generation || controller.signal.aborted) return;
      await managed.provider.stop("start_failure").catch((stopError: unknown) => {
        this.options.log("warn", "capability.provider.stop_failed", {
          providerId: managed.provider.id,
          error: normalizeCapabilityError(stopError).code,
        });
      });
      this.handleStartFailure(managed, error);
    }
  }

  private async handleRuntimeFailure(managed: ManagedProvider, error: unknown): Promise<void> {
    if (managed.health.state === "stopping" || managed.health.state === "disabled") return;
    managed.generation += 1;
    managed.controller?.abort("provider_failure");
    await managed.provider.stop("provider_failure").catch(() => {});
    this.handleStartFailure(managed, error);
  }

  private handleStartFailure(managed: ManagedProvider, error: unknown): void {
    const normalized = normalizeCapabilityError(error);
    if (normalized.code === "permission_required") {
      this.transition(managed, {
        state: "needs_user_action",
        since: new Date().toISOString(),
        reasonCode: normalized.code,
        userAction: typeof normalized.details?.action === "string"
          ? normalized.details.action
          : normalized.message,
      });
      return;
    }

    managed.attempt += 1;
    if (managed.attempt >= this.options.maxAttempts) {
      this.transition(managed, {
        state: "failed",
        since: new Date().toISOString(),
        reasonCode: normalized.code,
      });
      return;
    }
    const delayMs = Math.min(
      this.options.backoffBaseMs * 2 ** (managed.attempt - 1),
      this.options.backoffMaxMs,
    ) + Math.floor(this.options.random() * 250);
    const retryAt = new Date(Date.now() + delayMs).toISOString();
    this.transition(managed, {
      state: "backoff",
      since: new Date().toISOString(),
      reasonCode: normalized.code,
      retryAt,
    });
    managed.retryTimer = this.options.scheduler.setTimeout(() => {
      managed.retryTimer = undefined;
      void this.start(managed.provider.id);
    }, delayMs);
  }

  private transition(managed: ManagedProvider, health: ProviderHealth): void {
    managed.health = health;
    this.registry.setProviderHealth(managed.provider.id, health);
    this.options.log(
      health.state === "failed" ? "error" : health.state === "backoff" ? "warn" : "info",
      "capability.provider.state_changed",
      {
        providerId: managed.provider.id,
        state: health.state,
        ...(health.reasonCode ? { reasonCode: health.reasonCode } : {}),
      },
    );
  }

  private clearRetry(managed: ManagedProvider): void {
    if (managed.retryTimer === undefined) return;
    this.options.scheduler.clearTimeout(managed.retryTimer);
    managed.retryTimer = undefined;
  }

  private get(providerId: string): ManagedProvider {
    const managed = this.providers.get(providerId);
    if (!managed) throw new CapabilityError("provider_unavailable", `Unknown provider: ${providerId}`);
    return managed;
  }

  private requireReady(providerId: string): ManagedProvider {
    const managed = this.get(providerId);
    if (managed.health.state === "needs_user_action") {
      throw new CapabilityError("permission_required", "The provider requires user approval.", {
        details: managed.health.userAction ? { action: managed.health.userAction } : undefined,
      });
    }
    if (managed.health.state !== "ready" && managed.health.state !== "degraded") {
      throw new CapabilityError("provider_unavailable", `Provider is ${managed.health.state}.`);
    }
    return managed;
  }
}

function healthFor(state: ProviderState): ProviderHealth {
  return { state, since: new Date().toISOString() };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  parentSignal: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CapabilityError("timeout", message)), timeoutMs);
    timer.unref();
  });
  const aborted = new Promise<never>((_, reject) => {
    if (parentSignal.aborted) reject(new CapabilityError("cancelled", "Provider operation cancelled."));
    else {
      abortListener = () => {
        reject(new CapabilityError("cancelled", "Provider operation cancelled."));
      };
      parentSignal.addEventListener("abort", abortListener, { once: true });
    }
  });
  try {
    return await Promise.race([promise, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) parentSignal.removeEventListener("abort", abortListener);
  }
}
