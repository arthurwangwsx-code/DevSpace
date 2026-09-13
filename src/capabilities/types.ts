export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type CapabilityExecutionMode = "sync" | "async";
export type ProviderState =
  | "disabled"
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "needs_user_action"
  | "backoff"
  | "failed"
  | "stopping";

export type CapabilityAvailabilityState =
  | "ready"
  | "unavailable"
  | "permission_required"
  | "temporarily_unavailable"
  | "incompatible";

export interface CapabilityEffects {
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

export interface CapabilityPermissionRequirement {
  id: string;
  required: boolean;
  description: string;
}

export interface CapabilityRuntimeRequirements {
  requiresAwake: boolean;
  requiresLoggedInSession: boolean;
  requiresUnlocked: boolean;
  requiresForegroundApp: boolean;
}

export interface CapabilityExecution {
  modes: CapabilityExecutionMode[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  requiresLease: boolean;
  resourceTypes: string[];
}

export interface CapabilityDescriptor {
  id: string;
  version: string;
  providerId: string;
  title: string;
  description: string;
  tags: string[];
  inputSchema: JsonObject;
  outputSchema?: JsonObject;
  effects: CapabilityEffects;
  permissions: CapabilityPermissionRequirement[];
  availability: CapabilityRuntimeRequirements;
  execution: CapabilityExecution;
  metadata?: JsonObject;
}

export interface CapabilitySummary {
  id: string;
  version: string;
  providerId: string;
  title: string;
  description: string;
  tags: string[];
  effects: CapabilityEffects;
  availability: {
    state: CapabilityAvailabilityState;
    reasonCode?: string;
  };
}

export interface ProviderHealth {
  state: ProviderState;
  since: string;
  reasonCode?: string;
  retryAt?: string;
  userAction?: string;
  unavailablePermissions?: string[];
}

export interface CapabilityPrincipal {
  id: string;
  kind: "oauth" | "trusted_local" | "test";
  resource: string;
  scopes: string[];
}

export interface CapabilityLease {
  id: string;
  principalId: string;
  providerId: string;
  resourceType: string;
  display: JsonObject;
  createdAt: string;
  expiresAt: string;
}

export type InvocationStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface CapabilityInvocation {
  id: string;
  principalId: string;
  capabilityId: string;
  providerId: string;
  leaseId?: string;
  status: InvocationStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: JsonValue;
  errorCode?: string;
}

export interface CapabilityListQuery {
  providerId?: string;
  tag?: string;
  availableOnly?: boolean;
  cursor?: string;
  limit?: number;
}

export interface CapabilitySearchQuery {
  query: string;
  providerIds?: string[];
  tags?: string[];
  availableOnly?: boolean;
  limit?: number;
}
