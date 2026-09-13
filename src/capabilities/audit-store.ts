import { createHash, randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { redactCapabilityValue } from "./redaction.js";
import type { CapabilityInvocation, JsonValue } from "./types.js";

export class SqliteCapabilityAuditStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  saveInvocation(invocation: CapabilityInvocation, argumentsValue: JsonValue): void {
    this.database.sqlite.prepare(`
      insert into capability_invocations (
        invocation_id, principal_id, capability_id, provider_id, lease_id, status,
        arguments_digest, result_digest, error_code, queued_at, started_at,
        finished_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(invocation_id) do update set
        status = excluded.status,
        result_digest = excluded.result_digest,
        error_code = excluded.error_code,
        started_at = excluded.started_at,
        finished_at = excluded.finished_at,
        expires_at = excluded.expires_at
    `).run(
      invocation.id,
      invocation.principalId,
      invocation.capabilityId,
      invocation.providerId,
      invocation.leaseId ?? null,
      invocation.status,
      digest(argumentsValue),
      invocation.result === undefined ? null : digest(invocation.result),
      invocation.errorCode ?? null,
      invocation.queuedAt,
      invocation.startedAt ?? null,
      invocation.finishedAt ?? null,
      new Date(Date.parse(invocation.queuedAt) + 24 * 60 * 60_000).toISOString(),
    );
  }

  recordEvent(input: {
    requestId: string;
    principalId: string;
    eventType: string;
    capabilityId?: string;
    providerId?: string;
    decision?: string;
    summary?: unknown;
  }): void {
    this.database.sqlite.prepare(`
      insert into capability_audit_events (
        event_id, request_id, principal_id, event_type, capability_id,
        provider_id, decision, redacted_summary_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `evt_${randomUUID()}`,
      input.requestId,
      input.principalId,
      input.eventType,
      input.capabilityId ?? null,
      input.providerId ?? null,
      input.decision ?? null,
      JSON.stringify(redactCapabilityValue(input.summary ?? {})),
      new Date().toISOString(),
    );
  }

  close(): void {
    this.database.close();
  }
}

export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("base64url");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
}
