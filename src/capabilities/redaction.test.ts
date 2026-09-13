import assert from "node:assert/strict";
import { redactCapabilityValue } from "./redaction.js";

const circular: Record<string, unknown> = {};
circular.self = circular;

const redacted = redactCapabilityValue({
  authorization: "Bearer secret-token",
  nested: {
    api_key: "secret-api-key",
    password: "hunter2",
    safe: "visible",
    url: "https://user:pass@example.test/path?token=value#private",
  },
  long: "x".repeat(100),
  circular,
});

assert.deepEqual(redacted, {
  authorization: "[REDACTED]",
  nested: {
    api_key: "[REDACTED]",
    password: "[REDACTED]",
    safe: "visible",
    url: "https://example.test/path?[REDACTED]#[REDACTED]",
  },
  long: "x".repeat(100),
  circular: { self: "[CIRCULAR]" },
});

assert.equal(
  redactCapabilityValue("x".repeat(100), { maxStringLength: 30 }),
  "xxxxxxxxxxxxxxxxx[TRUNCATED]",
);

const bounded = redactCapabilityValue(
  { values: [1, 2, 3], object: { a: 1, b: 2, c: 3 } },
  { maxArrayItems: 2, maxObjectKeys: 2 },
);
assert.deepEqual(bounded, {
  values: [1, 2, "[TRUNCATED]"],
  object: { a: 1, b: 2, _truncated: true },
});

console.log("capability redaction tests passed");
