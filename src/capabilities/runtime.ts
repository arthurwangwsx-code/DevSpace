import { SqliteCapabilityCatalogStore } from "./catalog-store.js";
import type { ProviderRegistration } from "./provider.js";
import { ProviderSupervisor, type ProviderSupervisorOptions } from "./provider-supervisor.js";
import { CapabilityRegistry } from "./registry.js";

export interface CapabilityRuntimeOptions {
  stateDir: string;
  supervisor?: ProviderSupervisorOptions;
}

export class CapabilityRuntime {
  readonly registry: CapabilityRegistry;
  readonly supervisor: ProviderSupervisor;
  private readonly store: SqliteCapabilityCatalogStore;
  private started = false;
  private closed = false;

  constructor(options: CapabilityRuntimeOptions) {
    this.store = new SqliteCapabilityCatalogStore(options.stateDir);
    this.registry = new CapabilityRegistry(this.store);
    this.supervisor = new ProviderSupervisor(this.registry, options.supervisor);
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
    await this.supervisor.close();
    this.store.close();
  }
}
