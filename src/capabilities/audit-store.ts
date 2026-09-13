import { createHash, randomUUID } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { redactCapabilityValue } from "./redaction.js";
import type { CapabilityInvocation, JsonValue } from "./types.js";

export const DEFAULT_CAPABILITY_MAX_TRACKED_INVOCATIONS = 10_000;
export const DEFAULT_CAPABILITY_INVOCATION_RETENTION_MS = 24 * 60 * 60_000;

export interface CapabilityAuditStoreOptions {
  maxInvocations?: number;
  invocationRetentionMs?: number;
  maxAuditEvents?: number;
  pruneEveryWrites?: number;
}

export class SqliteCapabilityAuditStore {
  private readonly database: DatabaseHandle;
  private readonly maxInvocations: number;
  private readonly invocationRetentionMs: number;
  private readonly maxAuditEvents: number;
  private readonly pruneEveryWrites: number;
  private writesSincePrune = 0;

  constructor(stateDir: string, options: CapabilityAuditStoreOptions = {}) {
    this.database = openDatabase(stateDir);
    this.maxInvocations = options.maxInvocations ?? DEFAULT_CAPABILITY_MAX_TRACKED_INVOCATIONS;
    this.invocationRetentionMs = options.invocationRetentionMs
      ?? DEFAULT_CAPABILITY_INVOCATION_RETENTION_MS;
    this.maxAuditEvents = options.maxAuditEvents ?? this.maxInvocations * 4;
    this.pruneEveryWrites = options.pruneEveryWrites ?? 1_000;
    if (!Number.isInteger(this.maxInvocations) || this.maxInvocations < 1
      || !Number.isInteger(this.invocationRetentionMs) || this.invocationRetentionMs < 1_000
      || !Number.isInteger(this.maxAuditEvents) || this.maxAuditEvents < 1
      || !Number.isInteger(this.pruneEveryWrites) || this.pruneEveryWrites < 1) {
      throw new Error("Invalid capability audit retention limits.");
    }
    this.prune();
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
      new Date(Date.parse(invocation.queuedAt) + this.invocationRetentionMs).toISOString(),
    );
    this.maybePrune();
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
    this.maybePrune();
  }

  prune(now = new Date()): { invocations: number; auditEvents: number } {
    const nowIso = now.toISOString();
    const auditCutoff = new Date(now.getTime() - this.invocationRetentionMs).toISOString();
    const transaction = this.database.sqlite.transaction(() => {
      let invocations = this.database.sqlite.prepare(`
        delete from capability_invocations
        where status not in ('queued', 'running') and expires_at <= ?
      `).run(nowIso).changes;
      invocations += this.database.sqlite.prepare(`
        delete from capability_invocations
        where invocation_id in (
          select invocation_id from capability_invocations
          where status not in ('queued', 'running')
          order by queued_at desc, invocation_id desc
          limit -1 offset ?
        )
      `).run(this.maxInvocations).changes;
      let auditEvents = this.database.sqlite.prepare(`
        delete from capability_audit_events where created_at <= ?
      `).run(auditCutoff).changes;
      auditEvents += this.database.sqlite.prepare(`
        delete from capability_audit_events
        where event_id in (
          select event_id from capability_audit_events
          order by created_at desc, event_id desc
          limit -1 offset ?
        )
      `).run(this.maxAuditEvents).changes;
      return { invocations, auditEvents };
    });
    const removed = transaction();
    this.writesSincePrune = 0;
    return removed;
  }

  close(): void {
    this.prune();
    this.database.close();
  }

  private maybePrune(): void {
    this.writesSincePrune += 1;
    if (this.writesSincePrune >= this.pruneEveryWrites) this.prune();
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
