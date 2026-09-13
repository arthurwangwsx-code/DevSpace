import { z } from "zod";
import type { CapabilityDescriptor, JsonValue } from "./types.js";

const CAPABILITY_ID_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+){2,}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
const PERMISSION_ID_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

export const capabilityDescriptorSchema: z.ZodType<CapabilityDescriptor> = z
  .object({
    id: z.string().regex(CAPABILITY_ID_PATTERN),
    version: z.string().regex(SEMVER_PATTERN),
    providerId: z.string().regex(PROVIDER_ID_PATTERN),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    tags: z.array(z.string().regex(/^[a-z0-9_-]+$/)).max(64),
    inputSchema: jsonObjectSchema,
    outputSchema: jsonObjectSchema.optional(),
    effects: z.object({
      readOnly: z.boolean(),
      destructive: z.boolean(),
      idempotent: z.boolean(),
      openWorld: z.boolean(),
    }).strict(),
    permissions: z.array(z.object({
      id: z.string().regex(PERMISSION_ID_PATTERN),
      required: z.boolean(),
      description: z.string().trim().min(1).max(1_000),
    }).strict()).max(64),
    availability: z.object({
      requiresAwake: z.boolean(),
      requiresLoggedInSession: z.boolean(),
      requiresUnlocked: z.boolean(),
      requiresForegroundApp: z.boolean(),
    }).strict(),
    execution: z.object({
      modes: z.array(z.enum(["sync", "async"])).min(1).max(2),
      defaultTimeoutMs: z.number().int().positive().max(120_000),
      maxTimeoutMs: z.number().int().positive().max(600_000),
      requiresLease: z.boolean(),
      resourceTypes: z.array(z.string().regex(RESOURCE_TYPE_PATTERN)).max(32),
    }).strict(),
    metadata: jsonObjectSchema.optional(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (descriptor.execution.defaultTimeoutMs > descriptor.execution.maxTimeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["execution", "defaultTimeoutMs"],
        message: "defaultTimeoutMs must not exceed maxTimeoutMs",
      });
    }
    if (new Set(descriptor.execution.modes).size !== descriptor.execution.modes.length) {
      context.addIssue({
        code: "custom",
        path: ["execution", "modes"],
        message: "execution modes must be unique",
      });
    }
    if (descriptor.execution.requiresLease && descriptor.execution.resourceTypes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["execution", "resourceTypes"],
        message: "lease-bound capabilities must declare at least one resource type",
      });
    }
    if (!descriptor.execution.requiresLease && descriptor.execution.resourceTypes.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["execution", "resourceTypes"],
        message: "capabilities without leases must not declare resource types",
      });
    }
    if (descriptor.effects.readOnly && descriptor.effects.destructive) {
      context.addIssue({
        code: "custom",
        path: ["effects"],
        message: "a read-only capability cannot be destructive",
      });
    }
  });

export function parseCapabilityDescriptor(value: unknown): CapabilityDescriptor {
  return capabilityDescriptorSchema.parse(value);
}

export function capabilityDescriptorJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(capabilityDescriptorSchema, {
    target: "draft-2020-12",
    unrepresentable: "any",
  }) as Record<string, unknown>;
}
