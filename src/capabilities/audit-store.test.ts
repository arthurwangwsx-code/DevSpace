import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { SqliteCapabilityAuditStore } from "./audit-store.js";
import type { CapabilityInvocation } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-audit-test-"));

try {
  const store = new SqliteCapabilityAuditStore(root, {
    maxInvocations: 3,
    invocationRetentionMs: 60_000,
    maxAuditEvents: 4,
    pruneEveryWrites: 1,
  });
  const base = Date.now();
  for (let index = 0; index < 6; index += 1) {
    store.saveInvocation(invocation(`inv_${index}`, new Date(base + index).toISOString()), {
      secret: `must-not-be-persisted-${index}`,
    });
    store.recordEvent({
      requestId: `req_${index}`,
      principalId: "principal",
      eventType: "capability.invocation.succeeded",
      summary: { index },
    });
  }

  const database = openDatabase(root);
  try {
    const invocationIds = database.sqlite.prepare(`
      select invocation_id from capability_invocations order by queued_at
    `).all().map((row) => String((row as { invocation_id: string }).invocation_id));
    assert.deepEqual(invocationIds, ["inv_3", "inv_4", "inv_5"]);
    const auditCount = database.sqlite.prepare("select count(*) as count from capability_audit_events")
      .get() as { count: number } | undefined;
    assert.equal(auditCount?.count, 4);
  } finally {
    database.close();
  }
  store.close();

  const expiryRoot = mkdtempSync(join(tmpdir(), "devspace-capability-audit-expiry-test-"));
  try {
    const expiryStore = new SqliteCapabilityAuditStore(expiryRoot, {
      maxInvocations: 10,
      invocationRetentionMs: 1_000,
      pruneEveryWrites: 1,
    });
    const expiredAt = new Date(Date.now() - 2_000).toISOString();
    expiryStore.saveInvocation(invocation("expired", expiredAt), {});
    expiryStore.saveInvocation({ ...invocation("active", expiredAt), status: "running" }, {});
    const expiryDatabase = openDatabase(expiryRoot);
    try {
      const rows = expiryDatabase.sqlite.prepare(`
        select invocation_id from capability_invocations order by invocation_id
      `).all().map((row) => String((row as { invocation_id: string }).invocation_id));
      assert.deepEqual(rows, ["active"]);
    } finally {
      expiryDatabase.close();
    }
    expiryStore.close();
  } finally {
    rmSync(expiryRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("capability audit store tests passed: count cap, expiry, and active preservation");

function invocation(id: string, queuedAt: string): CapabilityInvocation {
  return {
    id,
    principalId: "principal",
    capabilityId: "fixture.echo",
    providerId: "fixture",
    status: "succeeded",
    queuedAt,
    startedAt: queuedAt,
    finishedAt: queuedAt,
    result: { ok: true },
  };
}
