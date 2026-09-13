import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CapabilityError } from "./errors.js";
import type { CapabilityRuntimeRequirements, JsonObject } from "./types.js";

const execFileAsync = promisify(execFile);

export interface SessionState {
  awake: boolean | null;
  loggedIn: boolean | null;
  locked: boolean | null;
  consoleUser?: string;
  observedAt: string;
}

export interface SessionStateProbe {
  probe(signal: AbortSignal): Promise<SessionState>;
}

export class SystemSessionStateProbe implements SessionStateProbe {
  constructor(
    private readonly platform = process.platform,
    private readonly execute: (file: string, args: string[], signal: AbortSignal) => Promise<string>
      = async (file, args, signal) => (await execFileAsync(file, args, {
        signal,
        encoding: "utf8",
        timeout: 2_000,
        maxBuffer: 512 * 1024,
      })).stdout,
  ) {}

  async probe(signal: AbortSignal): Promise<SessionState> {
    const observedAt = new Date().toISOString();
    if (this.platform !== "darwin") {
      return { awake: true, loggedIn: null, locked: null, observedAt };
    }
    const [consoleUserResult, ioregResult] = await Promise.allSettled([
      this.execute("/usr/bin/stat", ["-f", "%Su", "/dev/console"], signal),
      this.execute("/usr/sbin/ioreg", ["-n", "Root", "-d1"], signal),
    ]);
    const consoleUser = consoleUserResult.status === "fulfilled"
      ? consoleUserResult.value.trim()
      : undefined;
    const loggedIn = consoleUser
      ? !["root", "loginwindow", "_mbsetupuser"].includes(consoleUser)
      : null;
    const locked = ioregResult.status === "fulfilled"
      ? /(?:CGSSessionScreenIsLocked|CGSSessionScreenLocked)"\s*=\s*(?:Yes|true|1)/i.test(ioregResult.value)
      : null;
    return {
      awake: true,
      loggedIn,
      locked,
      ...(consoleUser ? { consoleUser } : {}),
      observedAt,
    };
  }
}

export async function enforceSessionRequirements(
  requirements: CapabilityRuntimeRequirements,
  probe: SessionStateProbe,
  signal: AbortSignal,
): Promise<SessionState> {
  if (!requirements.requiresAwake
    && !requirements.requiresLoggedInSession
    && !requirements.requiresUnlocked
    && !requirements.requiresForegroundApp) {
    return {
      awake: null,
      loggedIn: null,
      locked: null,
      observedAt: new Date().toISOString(),
    };
  }
  const state = await probe.probe(signal);
  const unavailable: string[] = [];
  if (requirements.requiresAwake && state.awake !== true) unavailable.push("awake");
  if (requirements.requiresLoggedInSession && state.loggedIn !== true) unavailable.push("logged_in");
  if (requirements.requiresUnlocked && state.locked !== false) unavailable.push("unlocked");
  if (requirements.requiresForegroundApp) unavailable.push("foreground_app");
  if (unavailable.length > 0) {
    throw new CapabilityError(
      "temporarily_unavailable",
      "The local user session does not satisfy this capability's runtime requirements.",
      { details: sessionDetails(state, unavailable) },
    );
  }
  return state;
}

function sessionDetails(state: SessionState, unavailable: string[]): JsonObject {
  return {
    unavailable,
    awake: state.awake,
    loggedIn: state.loggedIn,
    locked: state.locked,
    observedAt: state.observedAt,
  };
}
