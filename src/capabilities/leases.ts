import { randomUUID } from "node:crypto";
import { CapabilityError } from "./errors.js";
import type { ProviderLease } from "./provider.js";
import type { CapabilityLease, CapabilityPrincipal, JsonObject } from "./types.js";

export interface CapabilityLeaseRecord {
  lease: CapabilityLease;
  providerLease: ProviderLease;
}

export class CapabilityLeaseManager {
  private readonly leases = new Map<string, CapabilityLeaseRecord>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly defaultTtlMs = 15 * 60_000,
    private readonly maxTtlMs = 60 * 60_000,
  ) {}

  create(input: {
    principal: CapabilityPrincipal;
    providerId: string;
    resourceType: string;
    providerLease: ProviderLease;
    ttlMs?: number;
  }): CapabilityLease {
    const ttlMs = input.ttlMs ?? this.defaultTtlMs;
    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > this.maxTtlMs) {
      throw new CapabilityError(
        "invalid_arguments",
        `Lease ttlMs must be an integer from 1000 to ${this.maxTtlMs}.`,
      );
    }
    const createdAtMs = this.now();
    const lease: CapabilityLease = {
      id: `lease_${randomUUID()}`,
      principalId: input.principal.id,
      providerId: input.providerId,
      resourceType: input.resourceType,
      display: cloneObject(input.providerLease.display),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
    };
    this.leases.set(lease.id, { lease, providerLease: input.providerLease });
    return publicLease(lease);
  }

  get(
    leaseId: string,
    principal: CapabilityPrincipal,
    expected?: { providerId?: string; resourceTypes?: string[] },
  ): CapabilityLeaseRecord {
    const record = this.leases.get(leaseId);
    if (!record || Date.parse(record.lease.expiresAt) <= this.now()) {
      if (record) this.leases.delete(leaseId);
      throw new CapabilityError("lease_expired", "The capability lease is missing or expired.");
    }
    if (record.lease.principalId !== principal.id) {
      throw new CapabilityError("policy_denied", "The capability lease belongs to another principal.");
    }
    if (expected?.providerId && record.lease.providerId !== expected.providerId) {
      throw new CapabilityError("conflict", "The capability lease belongs to another provider.");
    }
    if (expected?.resourceTypes && !expected.resourceTypes.includes(record.lease.resourceType)) {
      throw new CapabilityError("conflict", "The capability lease has an incompatible resource type.");
    }
    return {
      lease: publicLease(record.lease),
      providerLease: {
        handle: cloneObject(record.providerLease.handle),
        display: cloneObject(record.providerLease.display),
      },
    };
  }

  close(leaseId: string, principal: CapabilityPrincipal): CapabilityLeaseRecord {
    const record = this.get(leaseId, principal);
    this.leases.delete(leaseId);
    return record;
  }

  takeAll(): CapabilityLeaseRecord[] {
    const records = [...this.leases.values()];
    this.leases.clear();
    return records;
  }

  get size(): number {
    return this.leases.size;
  }
}

function publicLease(lease: CapabilityLease): CapabilityLease {
  return { ...lease, display: cloneObject(lease.display) };
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value);
}
