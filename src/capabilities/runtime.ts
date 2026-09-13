import { SqliteCapabilityAuditStore } from "./audit-store.js";
import { SqliteCapabilityCatalogStore } from "./catalog-store.js";
import { CapabilityLeaseManager } from "./leases.js";
import { CapabilityPolicyEngine } from "./policy.js";
import type { ProviderRegistration } from "./provider.js";
import { ProviderSupervisor, type ProviderSupervisorOptions } from "./provider-supervisor.js";
import { CapabilityRegistry } from "./registry.js";
import { CapabilityInvocationRouter, type CapabilityRouterOptions } from "./router.js";
import { CapabilityEventHub } from "./events.js";

export interface CapabilityRuntimeOptions {
  stateDir: string;
  supervisor?: ProviderSupervisorOptions;
  router?: CapabilityRouterOptions;
  providers?: ProviderRegistration[];
}

export class CapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly supervisor: ProviderSupervisor;
  readonly policy: CapabilityPolicyEngine;
  readonly leases: CapabilityLeaseManager;
  readonly router: CapabilityInvocationRouter;
  readonly events = new CapabilityEventHub();
  private readonly store: SqliteCapabilityCatalogStore;
  private readonly audit: SqliteCapabilityAuditStore;
  private started = false;
  private closed = false;

  constructor(options: CapabilityRuntimeOptions) {
    this.store = new SqliteCapabilityCatalogStore(options.stateDir);
    this.audit = new SqliteCapabilityAuditStore(options.stateDir);
    this.registry = new CapabilityRegistry(this.store);
    this.supervisor = new ProviderSupervisor(this.registry, {
      ...options.supervisor,
      onStateChange: (providerId, health) => {
        options.supervisor?.onStateChange?.(providerId, health);
        this.events.publish("provider.state_changed", {
          providerId,
          state: health.state,
          ...(health.reasonCode ? { reasonCode: health.reasonCode } : {}),
          catalogRevision: this.registry.revision,
        });
      },
    });
    this.policy = new CapabilityPolicyEngine();
    this.leases = new CapabilityLeaseManager();
    this.router = new CapabilityInvocationRouter(
      this.registry,
      this.supervisor,
      this.policy,
      this.leases,
      this.audit,
      {
        ...options.router,
        onEvent: (type, data) => {
          options.router?.onEvent?.(type, data);
          this.events.publish(type, { ...data, catalogRevision: this.registry.revision });
        },
      },
    );
    for (const registration of options.providers ?? []) this.registerProvider(registration);
  }

  registerProvider(registration: ProviderRegistration): void {
    if (this.started) throw new Error("Providers must be registered before the runtime starts.");
    this.supervisor.register(registration);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Capability runtime is closed.");
    if (this.started) return;
    this.started = true;
    await this.supervisor.startAll();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.router.close();
    await this.supervisor.close();
    this.audit.close();
    this.store.close();
  }
}
