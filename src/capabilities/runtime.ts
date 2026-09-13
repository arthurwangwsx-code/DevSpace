import { randomUUID } from "node:crypto";
import { SqliteCapabilityAuditStore } from "./audit-store.js";
import { SqliteCapabilityCatalogStore } from "./catalog-store.js";
import { CapabilityLeaseManager } from "./leases.js";
import { CapabilityPolicyEngine } from "./policy.js";
import type { ProviderRegistration } from "./provider.js";
import { ProviderSupervisor, type ProviderSupervisorOptions } from "./provider-supervisor.js";
import { CapabilityRegistry } from "./registry.js";
import { CapabilityInvocationRouter, type CapabilityRouterOptions } from "./router.js";
import { CapabilityEventHub } from "./events.js";
import { SqliteCapabilityGrantStore, type StoredCapabilityGrant } from "./grant-store.js";
import type { CapabilityGrant } from "./policy.js";
import type { CapabilityPrincipal } from "./types.js";
import { CapabilityError } from "./errors.js";

export interface CapabilityRuntimeOptions {
  stateDir: string;
  enforcePolicy?: boolean;
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
  private readonly grants: SqliteCapabilityGrantStore;
  private started = false;
  private closed = false;
  private readonly enforcePolicy: boolean;

  constructor(options: CapabilityRuntimeOptions) {
    this.enforcePolicy = options.enforcePolicy ?? true;
    this.store = new SqliteCapabilityCatalogStore(options.stateDir);
    this.audit = new SqliteCapabilityAuditStore(options.stateDir, {
      maxInvocations: options.router?.maxTrackedInvocations,
      invocationRetentionMs: options.router?.invocationRetentionMs,
    });
    this.grants = new SqliteCapabilityGrantStore(options.stateDir);
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
    this.policy = new CapabilityPolicyEngine(this.enforcePolicy);
    for (const grant of this.grants.loadAll()) this.policy.addGrant(grant);
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

  async installProvider(principal: CapabilityPrincipal, registration: ProviderRegistration): Promise<void> {
    requireAdmin(principal, this.enforcePolicy);
    if (this.closed) throw new CapabilityError("provider_unavailable", "Capability runtime is closed.");
    if (this.started) await this.supervisor.add(registration);
    else this.supervisor.register(registration);
    this.recordProviderAdminEvent(principal, "capability.provider.installed", registration.provider.id, {
      enabled: registration.enabled,
      kind: registration.kind,
    });
  }

  async reloadProvider(principal: CapabilityPrincipal, registration: ProviderRegistration): Promise<void> {
    requireAdmin(principal, this.enforcePolicy);
    if (!this.started) throw new CapabilityError("provider_unavailable", "Capability runtime is not started.");
    await this.supervisor.replace(registration);
    this.recordProviderAdminEvent(principal, "capability.provider.reloaded", registration.provider.id, {
      enabled: registration.enabled,
      kind: registration.kind,
    });
  }

  async setProviderEnabled(
    principal: CapabilityPrincipal,
    providerId: string,
    enabled: boolean,
  ): Promise<void> {
    requireAdmin(principal, this.enforcePolicy);
    await this.supervisor.setEnabled(providerId, enabled);
    this.recordProviderAdminEvent(principal, enabled
      ? "capability.provider.enabled"
      : "capability.provider.disabled", providerId, { enabled });
  }

  async removeProvider(principal: CapabilityPrincipal, providerId: string): Promise<void> {
    requireAdmin(principal, this.enforcePolicy);
    await this.supervisor.unregister(providerId);
    this.leases.removeProvider(providerId);
    this.recordProviderAdminEvent(principal, "capability.provider.removed", providerId, {});
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
    this.grants.close();
    this.store.close();
  }

  listGrants(principal: CapabilityPrincipal): StoredCapabilityGrant[] {
    requireAdmin(principal, this.enforcePolicy);
    const stored = new Map(this.grants.loadAll().map((grant) => [grant.id, grant]));
    return this.policy.listGrants().map((grant) => ({
      ...grant,
      createdBy: stored.get(grant.id)?.createdBy ?? "unknown",
      createdAt: stored.get(grant.id)?.createdAt ?? "unknown",
    }));
  }

  createGrant(
    principal: CapabilityPrincipal,
    input: Omit<CapabilityGrant, "id" | "revokedAt"> & { id?: string },
  ): StoredCapabilityGrant {
    requireAdmin(principal, this.enforcePolicy);
    if (input.expiresAt
      && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) {
      throw new CapabilityError("invalid_arguments", "Grant expiresAt must be a future ISO timestamp.");
    }
    const grantId = input.id ?? `grant_${randomUUID()}`;
    if (this.policy.listGrants().some((grant) => grant.id === grantId)) {
      throw new CapabilityError("conflict", "Grant id already exists.");
    }
    const grant: StoredCapabilityGrant = {
      ...input,
      id: grantId,
      createdBy: principal.id,
      createdAt: new Date().toISOString(),
    };
    this.policy.addGrant(grant);
    try {
      this.grants.create(grant);
    } catch (error) {
      this.policy.removeGrant(grant.id);
      throw new CapabilityError("conflict", "Grant id already exists or could not be persisted.", { cause: error });
    }
    this.audit.recordEvent({
      requestId: `grant:${grant.id}`,
      principalId: principal.id,
      eventType: "capability.grant.created",
      providerId: grant.providerPattern,
      decision: "allowed",
      summary: { grantId: grant.id, grantee: grant.principalId, capabilityPattern: grant.capabilityPattern },
    });
    this.events.publish("grant.created", { grantId: grant.id, principalId: grant.principalId });
    return structuredClone(grant);
  }

  revokeGrant(principal: CapabilityPrincipal, grantId: string): void {
    requireAdmin(principal, this.enforcePolicy);
    const revokedAt = new Date().toISOString();
    if (!this.grants.revoke(grantId, revokedAt)) {
      throw new CapabilityError("capability_not_found", "Unknown or already revoked grant.");
    }
    this.policy.revokeGrant(grantId, revokedAt);
    this.audit.recordEvent({
      requestId: `grant:${grantId}`,
      principalId: principal.id,
      eventType: "capability.grant.revoked",
      decision: "allowed",
      summary: { grantId },
    });
    this.events.publish("grant.revoked", { grantId });
  }

  private recordProviderAdminEvent(
    principal: CapabilityPrincipal,
    eventType: string,
    providerId: string,
    summary: Record<string, string | boolean>,
  ): void {
    this.audit.recordEvent({
      requestId: `provider:${randomUUID()}`,
      principalId: principal.id,
      eventType,
      providerId,
      decision: "allowed",
      summary,
    });
    this.events.publish(eventType, { providerId, ...summary, catalogRevision: this.registry.revision });
  }
}

function requireAdmin(principal: CapabilityPrincipal, enforcePolicy = true): void {
  if (enforcePolicy && !principal.scopes.includes("capabilities:admin")) {
    throw new CapabilityError("policy_denied", "The principal lacks capabilities:admin.");
  }
}
