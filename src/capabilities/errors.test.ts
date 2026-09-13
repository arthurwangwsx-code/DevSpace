import assert from "node:assert/strict";
import {
  capabilityErrorEnvelope,
  CapabilityError,
  normalizeCapabilityError,
} from "./errors.js";

const denied = new CapabilityError("policy_denied", "Not allowed.", {
  details: { capabilityId: "browser.chrome.click" },
});
assert.equal(denied.httpStatus, 403);
assert.equal(denied.retryable, false);
assert.deepEqual(capabilityErrorEnvelope(denied, "req_1"), {
  error: {
    code: "policy_denied",
    message: "Not allowed.",
    retryable: false,
    details: { capabilityId: "browser.chrome.click" },
  },
  meta: { requestId: "req_1" },
});

const unavailable = new CapabilityError("provider_unavailable", "Unavailable.");
assert.equal(unavailable.httpStatus, 503);
assert.equal(unavailable.retryable, true);

const internal = normalizeCapabilityError(new Error("raw provider secret"));
assert.equal(internal.code, "internal_error");
assert.equal(internal.message, "The capability request failed.");
assert.doesNotMatch(JSON.stringify(capabilityErrorEnvelope(internal, "req_2")), /raw provider secret/);

console.log("capability error tests passed");
