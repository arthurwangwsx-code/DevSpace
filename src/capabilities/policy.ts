import { CapabilityError } from "./errors.js";
import type {
  CapabilityDescriptor,
  CapabilityLease,
  CapabilityPrincipal,
  JsonObject,
  JsonValue,
} from "./types.js";

export type CapabilityEffectGrant = "readOnly" | "mutation" | "destructive" | "openWorld";

export interface CapabilityGrant {
  id: string;
  principalId: string;
  capabilityPattern: string;
  providerPattern: string;
  resourceType?: string;
  allowedEffects: CapabilityEffectGrant[];
  targetConstraints?: {
    origins?: string[];
    bundleIds?: string[];
  };
  expiresAt?: string;
  revokedAt?: string;
}

export class CapabilityPolicyEngine {
  private readonly grants = new Map<string, CapabilityGrant>();

  addGrant(grant: CapabilityGrant): void {
    validatePattern(grant.capabilityPattern);
    validatePattern(grant.providerPattern);
    this.grants.set(grant.id, structuredClone(grant));
  }

  revokeGrant(grantId: string, revokedAt = new Date().toISOString()): void {
    const grant = this.grants.get(grantId);
    if (grant) grant.revokedAt = revokedAt;
  }

  canDiscover(principal: CapabilityPrincipal, _descriptor: CapabilityDescriptor): boolean {
    return principal.scopes.includes("capabilities:discover")
      || principal.scopes.includes("capabilities:invoke")
      || principal.scopes.includes("capabilities:admin");
  }

  authorizeOpen(input: {
    principal: CapabilityPrincipal;
    providerId: string;
    resourceType: string;
  }): void {
    this.requireInvokeScope(input.principal);
    const grant = this.activeGrants(input.principal).find((candidate) =>
      globMatches(candidate.providerPattern, input.providerId)
      && (candidate.resourceType === undefined || candidate.resourceType === input.resourceType));
    if (!grant) {
      throw new CapabilityError("policy_denied", "No active grant permits this resource lease.");
    }
  }

  authorizeInvocation(input: {
    principal: CapabilityPrincipal;
    descriptor: CapabilityDescriptor;
    arguments: JsonValue;
    lease?: CapabilityLease;
  }): void {
    this.requireInvokeScope(input.principal);
    if (containsSecureFieldIntent(input.arguments)) {
      throw new CapabilityError("policy_denied", "Secure fields cannot be read or filled.");
    }
    const requiredEffects = effectsFor(input.descriptor);
    const grant = this.activeGrants(input.principal).find((candidate) => {
      if (!globMatches(candidate.capabilityPattern, input.descriptor.id)) return false;
      if (!globMatches(candidate.providerPattern, input.descriptor.providerId)) return false;
      if (candidate.resourceType && candidate.resourceType !== input.lease?.resourceType) return false;
      if (!requiredEffects.every((effect) => candidate.allowedEffects.includes(effect))) return false;
      return targetMatches(candidate, input.lease?.display);
    });
    if (!grant) {
      throw new CapabilityError("policy_denied", "No active grant permits this capability call.", {
        details: { capabilityId: input.descriptor.id },
      });
    }
  }

  private activeGrants(principal: CapabilityPrincipal): CapabilityGrant[] {
    const now = Date.now();
    return [...this.grants.values()].filter((grant) =>
      !grant.revokedAt
      && (grant.principalId === principal.id || grant.principalId === "*")
      && (!grant.expiresAt || Date.parse(grant.expiresAt) > now));
  }

  private requireInvokeScope(principal: CapabilityPrincipal): void {
    if (!principal.scopes.includes("capabilities:invoke")
      && !principal.scopes.includes("capabilities:admin")) {
      throw new CapabilityError("policy_denied", "The principal lacks capabilities:invoke.");
    }
  }
}

function effectsFor(descriptor: CapabilityDescriptor): CapabilityEffectGrant[] {
  const effects: CapabilityEffectGrant[] = [descriptor.effects.readOnly ? "readOnly" : "mutation"];
  if (descriptor.effects.destructive) effects.push("destructive");
  if (descriptor.effects.openWorld) effects.push("openWorld");
  return effects;
}

function targetMatches(grant: CapabilityGrant, display: JsonObject | undefined): boolean {
  if (!grant.targetConstraints) return true;
  if (!display) return false;
  const origin = typeof display.origin === "string" ? display.origin : undefined;
  const bundleId = typeof display.bundleId === "string" ? display.bundleId : undefined;
  if (grant.targetConstraints.origins
    && (!origin || !grant.targetConstraints.origins.includes(origin))) return false;
  if (grant.targetConstraints.bundleIds
    && (!bundleId || !grant.targetConstraints.bundleIds.includes(bundleId))) return false;
  return true;
}

function containsSecureFieldIntent(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSecureFieldIntent);
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(password|passwd|secret|credential)$/i.test(key)) return true;
    if (/^(fieldType|inputType|role)$/i.test(key)
      && typeof child === "string"
      && /password|secure/i.test(child)) return true;
    if (containsSecureFieldIntent(child)) return true;
  }
  return false;
}

function validatePattern(pattern: string): void {
  if (!/^[a-z0-9_.*-]+$/.test(pattern)) {
    throw new CapabilityError("invalid_arguments", `Invalid policy pattern: ${pattern}`);
  }
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
