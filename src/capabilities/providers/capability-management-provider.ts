import { CapabilityError } from "../errors.js";
import type { CapabilityProviderAdmin, ProviderAdminAction } from "../provider-admin.js";
import type {
  CapabilityProvider,
  ProviderCapability,
  ProviderContext,
  ProviderInvocation,
  ProviderInvocationContext,
} from "../provider.js";
import type { CapabilityDescriptor, JsonObject, JsonValue, ProviderHealth } from "../types.js";

const PROVIDER_ID = "devspace.providers.admin";
const RUNTIME_REQUIREMENTS = {
  requiresAwake: false,
  requiresLoggedInSession: false,
  requiresUnlocked: false,
  requiresForegroundApp: false,
};

export class CapabilityManagementProvider implements CapabilityProvider {
  readonly id = PROVIDER_ID;
  private ready = false;

  constructor(private readonly admin: CapabilityProviderAdmin) {}

  async start(_context: ProviderContext): Promise<void> {
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
  }

  async health(): Promise<ProviderHealth> {
    return { state: this.ready ? "ready" : "stopped", since: new Date().toISOString() };
  }

  async discover(): Promise<ProviderCapability[]> {
    return [
      capability("devspace.providers.list", "List configured MCP Providers", "list", {
        type: "object", additionalProperties: false,
      }, readOnly()),
      capability("devspace.providers.install", "Install and load an MCP Provider", "install", {
        type: "object",
        properties: { manifest: { type: "object" } },
        required: ["manifest"],
        additionalProperties: false,
      }, mutation(true)),
      capability("devspace.providers.update", "Update and reload an MCP Provider", "update", {
        type: "object",
        properties: {
          providerId: { type: "string", minLength: 1 },
          manifest: { type: "object" },
        },
        required: ["providerId", "manifest"],
        additionalProperties: false,
      }, mutation(true)),
      capability("devspace.providers.control", "Enable, disable, or reload an MCP Provider", "control", {
        type: "object",
        properties: {
          providerId: { type: "string", minLength: 1 },
          action: { type: "string", enum: ["enable", "disable", "reload"] },
        },
        required: ["providerId", "action"],
        additionalProperties: false,
      }, mutation(false)),
      capability("devspace.providers.remove", "Remove and archive an MCP Provider", "remove", {
        type: "object",
        properties: { providerId: { type: "string", minLength: 1 } },
        required: ["providerId"],
        additionalProperties: false,
      }, { ...mutation(false), destructive: true }),
    ];
  }

  async invoke(request: ProviderInvocation, context: ProviderInvocationContext): Promise<JsonValue> {
    const principal = context.principal;
    if (!principal) throw new CapabilityError("policy_denied", "Provider administration requires a principal.");
    const argumentsValue = objectArguments(request.arguments);
    switch (request.binding.operation) {
      case "list":
        return this.admin.list(principal);
      case "install":
        return this.admin.install(principal, argumentsValue.manifest);
      case "update":
        return this.admin.update(
          principal,
          requiredString(argumentsValue.providerId, "providerId"),
          argumentsValue.manifest,
        );
      case "control":
        return this.admin.action(
          principal,
          requiredString(argumentsValue.providerId, "providerId"),
          requiredAction(argumentsValue.action),
        );
      case "remove":
        return this.admin.remove(principal, requiredString(argumentsValue.providerId, "providerId"));
      default:
        throw new CapabilityError("policy_denied", "Unknown Provider administration operation.");
    }
  }
}

function capability(
  id: string,
  title: string,
  operation: string,
  inputSchema: JsonObject,
  effects: CapabilityDescriptor["effects"],
): ProviderCapability {
  return {
    descriptor: {
      id,
      version: "1.0.0",
      providerId: PROVIDER_ID,
      title,
      description: `${title} through the fixed DevSpace capability control plane.`,
      tags: ["devspace", "provider", "admin"],
      inputSchema,
      outputSchema: { type: "object" },
      effects,
      permissions: [],
      availability: RUNTIME_REQUIREMENTS,
      execution: {
        modes: ["sync"],
        defaultTimeoutMs: 30_000,
        maxTimeoutMs: 120_000,
        requiresLease: false,
        resourceTypes: [],
      },
    },
    binding: { operation },
    aliases: ["mcp", "provider", "dynamic"],
  };
}

function readOnly(): CapabilityDescriptor["effects"] {
  return { readOnly: true, destructive: false, idempotent: true, openWorld: false };
}

function mutation(openWorld: boolean): CapabilityDescriptor["effects"] {
  return { readOnly: false, destructive: false, idempotent: false, openWorld };
}

function objectArguments(value: JsonValue): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("invalid_arguments", "Provider administration arguments must be an object.");
  }
  return value;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CapabilityError("invalid_arguments", `${name} must be a non-empty string.`);
  }
  return value;
}

function requiredAction(value: JsonValue | undefined): ProviderAdminAction {
  if (value !== "enable" && value !== "disable" && value !== "reload") {
    throw new CapabilityError("invalid_arguments", "action must be enable, disable, or reload.");
  }
  return value;
}
