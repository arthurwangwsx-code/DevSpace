import type {
  CapabilityDescriptor,
  JsonObject,
  JsonValue,
  ProviderHealth,
} from "./types.js";

export interface ProviderCapability {
  descriptor: CapabilityDescriptor;
  binding: JsonObject;
  aliases?: string[];
}

export interface ProviderInvocation {
  capabilityId: string;
  descriptor: CapabilityDescriptor;
  binding: JsonObject;
  arguments: JsonValue;
  lease?: ProviderLease;
}

export interface ProviderInvocationContext {
  signal: AbortSignal;
}

export interface ProviderOpenRequest {
  resourceType: string;
  selector: JsonObject;
}

export interface ProviderLease {
  handle: JsonObject;
  display: JsonObject;
}

export interface ProviderContext {
  signal: AbortSignal;
  reportFailure(error: unknown): void;
  reportCatalogChanged(): void;
  log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    fields?: JsonObject,
  ): void;
}

export interface CapabilityProvider {
  readonly id: string;
  start(context: ProviderContext): Promise<void>;
  stop(reason: string): Promise<void>;
  health(signal: AbortSignal): Promise<ProviderHealth>;
  discover(signal: AbortSignal): Promise<ProviderCapability[]>;
  open?(request: ProviderOpenRequest, context: ProviderInvocationContext): Promise<ProviderLease>;
  invoke(request: ProviderInvocation, context: ProviderInvocationContext): Promise<JsonValue>;
  cancel?(providerInvocationId: string): Promise<void>;
  close?(lease: ProviderLease, context: ProviderInvocationContext): Promise<void>;
}

export interface ProviderRegistration {
  provider: CapabilityProvider;
  kind: string;
  enabled: boolean;
  manifestDigest?: string;
}
