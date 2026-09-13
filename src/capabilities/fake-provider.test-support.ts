import { CapabilityError } from "./errors.js";
import type {
  CapabilityProvider,
  ProviderCapability,
  ProviderContext,
  ProviderInvocation,
  ProviderInvocationContext,
  ProviderLease,
  ProviderOpenRequest,
} from "./provider.js";
import type { CapabilityDescriptor, JsonValue, ProviderHealth } from "./types.js";

export class FakeCapabilityProvider implements CapabilityProvider {
  readonly id: string;
  readonly capabilities: ProviderCapability[];
  startCount = 0;
  stopCount = 0;
  invokeCount = 0;
  closeCount = 0;
  failStartTimes = 0;
  permissionRequired = false;
  startBarrier?: Promise<void>;
  invokeBarrier?: Promise<void>;
  invokeResult?: JsonValue;
  private context?: ProviderContext;
  private ready = false;

  constructor(id = "test.fake.provider", descriptors: CapabilityDescriptor[] = [fakeDescriptor(id)]) {
    this.id = id;
    this.capabilities = descriptors.map((descriptor) => ({
      descriptor,
      binding: { fake: true },
      aliases: [descriptor.id.split(".").at(-1)!],
    }));
  }

  async start(context: ProviderContext): Promise<void> {
    this.startCount += 1;
    this.context = context;
    if (this.permissionRequired) {
      throw new CapabilityError("permission_required", "Fake permission required.", {
        details: { action: "Approve the fake provider." },
      });
    }
    if (this.startCount <= this.failStartTimes) throw new Error("fake start failure");
    if (this.startBarrier) await this.startBarrier;
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.ready = false;
  }

  async health(): Promise<ProviderHealth> {
    return {
      state: this.ready ? "ready" : "stopped",
      since: new Date().toISOString(),
    };
  }

  async discover(): Promise<ProviderCapability[]> {
    return this.capabilities;
  }

  async open(
    request: ProviderOpenRequest,
    context: ProviderInvocationContext,
  ): Promise<ProviderLease> {
    if (context.signal.aborted) throw new CapabilityError("cancelled", "Fake open cancelled.");
    return {
      handle: { ...request.selector, resourceType: request.resourceType },
      display: { label: String(request.selector.label ?? "fake resource") },
    };
  }

  async invoke(
    request: ProviderInvocation,
    context: ProviderInvocationContext,
  ): Promise<JsonValue> {
    this.invokeCount += 1;
    if (context.signal.aborted) throw new CapabilityError("cancelled", "Fake call cancelled.");
    if (this.invokeBarrier) await this.invokeBarrier;
    if (context.signal.aborted) throw new CapabilityError("cancelled", "Fake call cancelled.");
    return this.invokeResult ?? { capabilityId: request.capabilityId, arguments: request.arguments };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  crash(error: unknown = new Error("fake crash")): void {
    this.ready = false;
    this.context?.reportFailure(error);
  }
}

export function fakeDescriptor(providerId = "test.fake.provider"): CapabilityDescriptor {
  return {
    id: "test.fake.echo",
    version: "1.0.0",
    providerId,
    title: "Echo",
    description: "Echo JSON arguments for deterministic tests.",
    tags: ["test", "echo"],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    permissions: [],
    availability: {
      requiresAwake: false,
      requiresLoggedInSession: false,
      requiresUnlocked: false,
      requiresForegroundApp: false,
    },
    execution: {
      modes: ["sync", "async"],
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 5_000,
      requiresLease: false,
      resourceTypes: [],
    },
  };
}
