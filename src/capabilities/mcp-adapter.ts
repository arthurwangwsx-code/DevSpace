import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { CapabilityError, capabilityErrorEnvelope, normalizeCapabilityError } from "./errors.js";
import type { CapabilityRuntime } from "./runtime.js";
import type { CapabilityPrincipal, JsonObject, JsonValue } from "./types.js";

export const CAPABILITY_MCP_TOOL_NAMES = [
  "capability_list",
  "capability_search",
  "capability_describe",
  "capability_open",
  "capability_invoke",
  "capability_status",
  "capability_cancel",
  "capability_close",
] as const;

export function createCapabilityMcpServer(
  runtime: CapabilityRuntime,
  principal: CapabilityPrincipal,
): McpServer {
  const server = new McpServer({ name: "devspace-capabilities", version: "1.0.0" });
  server.registerTool("capability_list", {
    title: "List capabilities",
    description: "List dynamically registered capabilities using stable filters and pagination.",
    inputSchema: z.object({
      providerId: z.string().optional(),
      tag: z.string().optional(),
      availableOnly: z.boolean().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  }, async (input) => result(() => runtime.registry.list(input, canDiscover(runtime, principal))));
  server.registerTool("capability_search", {
    title: "Search capabilities",
    description: "Search registered capability names, descriptions, tags, and aliases.",
    inputSchema: z.object({
      query: z.string().min(1),
      providerIds: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      availableOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  }, async (input) => result(() => runtime.registry.search(input, canDiscover(runtime, principal))));
  server.registerTool("capability_describe", {
    title: "Describe capability",
    description: "Return the complete descriptor, schemas, permission requirements, and effects.",
    inputSchema: z.object({ capabilityId: z.string().min(1) }),
  }, async ({ capabilityId }) => result(() => {
    const descriptor = runtime.registry.getDescriptor(capabilityId);
    if (!descriptor || !runtime.policy.canDiscover(principal, descriptor)) {
      throw new CapabilityError("capability_not_found", `Unknown capability: ${capabilityId}`);
    }
    return descriptor;
  }));
  server.registerTool("capability_open", {
    title: "Open capability target",
    description: "Create a principal-bound lease for a page, window, device, or other provider resource.",
    inputSchema: z.object({
      providerId: z.string().min(1),
      resourceType: z.string().min(1),
      selector: z.record(z.string(), z.json()).default({}),
      ttlSeconds: z.number().int().min(1).max(3600).optional(),
    }),
  }, async (input) => result(() => runtime.router.openLease({
    requestId: requestId(),
    principal,
    providerId: input.providerId,
    resourceType: input.resourceType,
    selector: input.selector as JsonObject,
    ...(input.ttlSeconds === undefined ? {} : { ttlMs: input.ttlSeconds * 1_000 }),
  })));
  server.registerTool("capability_invoke", {
    title: "Invoke capability",
    description: "Invoke a registered capability through the shared policy, lease, queue, and audit router.",
    inputSchema: z.object({
      capabilityId: z.string().min(1),
      arguments: z.json().default({}),
      leaseId: z.string().optional(),
      mode: z.enum(["sync", "async"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
      idempotencyKey: z.string().optional(),
    }),
  }, async (input) => result(() => runtime.router.invoke({
    requestId: requestId(),
    principal,
    capabilityId: input.capabilityId,
    arguments: input.arguments as JsonValue,
    leaseId: input.leaseId,
    mode: input.mode,
    timeoutMs: input.timeoutMs,
    idempotencyKey: input.idempotencyKey,
  })));
  server.registerTool("capability_status", {
    title: "Get capability status",
    description: "Get an invocation, one provider, or a runtime status snapshot.",
    inputSchema: z.object({
      invocationId: z.string().optional(),
      providerId: z.string().optional(),
    }),
  }, async ({ invocationId, providerId }) => result(() => {
    if (invocationId) return runtime.router.getInvocation(invocationId, principal);
    const providers = runtime.supervisor.list();
    if (providerId) {
      const provider = providers.find(({ id }) => id === providerId);
      if (!provider) throw new CapabilityError("provider_unavailable", `Unknown provider: ${providerId}`);
      return provider;
    }
    return { catalogRevision: runtime.registry.revision, providers };
  }));
  server.registerTool("capability_cancel", {
    title: "Cancel capability invocation",
    description: "Request cancellation of a queued or running invocation.",
    inputSchema: z.object({ invocationId: z.string().min(1) }),
  }, async ({ invocationId }) => result(() => runtime.router.cancelInvocation({
    requestId: requestId(),
    invocationId,
    principal,
  })));
  server.registerTool("capability_close", {
    title: "Close capability target",
    description: "Release a principal-bound capability lease.",
    inputSchema: z.object({ leaseId: z.string().min(1) }),
  }, async ({ leaseId }) => result(async () => {
    await runtime.router.closeLease({ requestId: requestId(), principal, leaseId });
    return { closed: true, leaseId };
  }));
  return server;
}

function canDiscover(runtime: CapabilityRuntime, principal: CapabilityPrincipal) {
  return (descriptor: Parameters<typeof runtime.policy.canDiscover>[1]) =>
    runtime.policy.canDiscover(principal, descriptor);
}

async function result(operation: () => unknown | Promise<unknown>) {
  const requestIdValue = requestId();
  try {
    const data = await operation();
    const structuredContent = {
      data,
      meta: { requestId: requestIdValue },
    } as Record<string, unknown>;
    return {
      content: [{ type: "text" as const, text: summarize(data) }],
      structuredContent,
    };
  } catch (error) {
    const normalized = normalizeCapabilityError(error);
    const structuredContent = capabilityErrorEnvelope(normalized, requestIdValue);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${normalized.code}: ${normalized.message}` }],
      structuredContent,
    };
  }
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value);
  return text.length <= 1_000 ? text : `${text.slice(0, 997)}...`;
}

function requestId(): string {
  return `cap_${randomUUID()}`;
}
