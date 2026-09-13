import assert from "node:assert/strict";
import { CapabilityError } from "./errors.js";
import {
  enforceSessionRequirements,
  SystemSessionStateProbe,
  type SessionState,
  type SessionStateProbe,
} from "./session-state.js";

const output = new Map<string, string>([
  ["/usr/bin/stat", "ai\n"],
  ["/usr/sbin/ioreg", '"CGSSessionScreenIsLocked" = Yes'],
]);
const mac = new SystemSessionStateProbe("darwin", async (file) => output.get(file) ?? "");
const locked = await mac.probe(new AbortController().signal);
assert.equal(locked.loggedIn, true);
assert.equal(locked.locked, true);
assert.equal(locked.consoleUser, "ai");

const unknown = await new SystemSessionStateProbe("linux").probe(new AbortController().signal);
assert.equal(unknown.awake, true);
assert.equal(unknown.loggedIn, null);
assert.equal(unknown.locked, null);

const requirements = {
  requiresAwake: true,
  requiresLoggedInSession: true,
  requiresUnlocked: true,
  requiresForegroundApp: false,
};
await assert.rejects(
  enforceSessionRequirements(requirements, fixed(locked), new AbortController().signal),
  (error) => error instanceof CapabilityError
    && error.code === "temporarily_unavailable"
    && error.details?.unavailable instanceof Array
    && error.details.unavailable.includes("unlocked"),
);
await enforceSessionRequirements(requirements, fixed({ ...locked, locked: false }), new AbortController().signal);

console.log("session state tests passed: macOS login/lock probe and fail-closed requirements");

function fixed(state: SessionState): SessionStateProbe {
  return { async probe() { return state; } };
}
