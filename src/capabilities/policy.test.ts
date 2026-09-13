import assert from "node:assert/strict";
import { CapabilityError } from "./errors.js";
import { fakeDescriptor } from "./fake-provider.test-support.js";
import { CapabilityPolicyEngine } from "./policy.js";
import type { CapabilityPrincipal } from "./types.js";

const principal: CapabilityPrincipal = {
  id: "approval-aware-agent",
  kind: "test",
  resource: "https://fixture.test/capabilities/mcp",
  scopes: [],
};
const descriptor = {
  ...fakeDescriptor("test.policy.provider"),
  effects: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: true,
  },
};

const delegated = new CapabilityPolicyEngine(false);
assert.equal(delegated.canDiscover(principal, descriptor), true);
assert.doesNotThrow(() => delegated.authorizeOpen({
  principal,
  providerId: descriptor.providerId,
  resourceType: "browser_page",
}));
assert.doesNotThrow(() => delegated.authorizeOpenTarget({
  principal,
  providerId: descriptor.providerId,
  resourceType: "browser_page",
  display: { origin: "https://unrestricted.example" },
}));
assert.doesNotThrow(() => delegated.authorizeInvocation({
  principal,
  descriptor,
  arguments: { inputType: "password", password: "delegated-to-upstream-agent" },
}));

const enforced = new CapabilityPolicyEngine(true);
assert.equal(enforced.canDiscover(principal, descriptor), false);
assert.throws(() => enforced.authorizeInvocation({
  principal,
  descriptor,
  arguments: {},
}), (error: unknown) => error instanceof CapabilityError && error.code === "policy_denied");

console.log("capability policy tests passed: delegated mode is grantless; enforced mode remains opt-in");
