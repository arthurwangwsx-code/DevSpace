import assert from "node:assert/strict";
import {
  capabilityDescriptorJsonSchema,
  parseCapabilityDescriptor,
} from "./descriptor-schema.js";

const validDescriptor = {
  id: "browser.chrome.take_snapshot",
  version: "1.0.0",
  providerId: "browser.chrome.devtools",
  title: "Take snapshot",
  description: "Read an accessibility snapshot from a selected Chrome page.",
  tags: ["browser", "snapshot"],
  inputSchema: { type: "object", additionalProperties: false },
  outputSchema: { type: "object" },
  effects: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: true,
  },
  permissions: [{
    id: "chrome.connection",
    required: true,
    description: "Access to the current Chrome profile.",
  }],
  availability: {
    requiresAwake: false,
    requiresLoggedInSession: true,
    requiresUnlocked: false,
    requiresForegroundApp: false,
  },
  execution: {
    modes: ["sync"],
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 120_000,
    requiresLease: true,
    resourceTypes: ["browser_page"],
  },
  metadata: { "io.devspace.upstreamTool": "take_snapshot" },
};

assert.deepEqual(parseCapabilityDescriptor(validDescriptor), validDescriptor);
assert.throws(
  () => parseCapabilityDescriptor({ ...validDescriptor, id: "snapshot" }),
  /Invalid string/,
);
assert.throws(
  () => parseCapabilityDescriptor({ ...validDescriptor, version: "latest" }),
  /Invalid string/,
);
assert.throws(
  () => parseCapabilityDescriptor({
    ...validDescriptor,
    execution: { ...validDescriptor.execution, defaultTimeoutMs: 120_000, maxTimeoutMs: 1_000 },
  }),
  /defaultTimeoutMs must not exceed maxTimeoutMs/,
);
assert.throws(
  () => parseCapabilityDescriptor({
    ...validDescriptor,
    execution: { ...validDescriptor.execution, resourceTypes: [] },
  }),
  /lease-bound capabilities must declare/,
);
assert.throws(
  () => parseCapabilityDescriptor({
    ...validDescriptor,
    effects: { ...validDescriptor.effects, destructive: true },
  }),
  /read-only capability cannot be destructive/,
);
assert.throws(
  () => parseCapabilityDescriptor({ ...validDescriptor, unexpected: true }),
  /Unrecognized key/,
);

const schema = capabilityDescriptorJsonSchema();
assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.type, "object");

console.log("capability descriptor schema tests passed");
