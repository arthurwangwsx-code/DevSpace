import { openDatabase, type DatabaseHandle } from "../db/client.js";
import type { CapabilityGrant } from "./policy.js";

export interface StoredCapabilityGrant extends CapabilityGrant {
  createdBy: string;
  createdAt: string;
}

export class SqliteCapabilityGrantStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  loadAll(): StoredCapabilityGrant[] {
    const rows = this.database.sqlite.prepare(`
      select grant_id, principal_id, capability_pattern, provider_pattern,
        resource_type, target_constraint_json, allowed_effects_json, expires_at,
        created_by, created_at, revoked_at
      from capability_grants
      order by created_at asc, grant_id asc
    `).all() as GrantRow[];
    return rows.map(fromRow);
  }

  create(grant: StoredCapabilityGrant): void {
    this.database.sqlite.prepare(`
      insert into capability_grants (
        grant_id, principal_id, capability_pattern, provider_pattern,
        resource_type, target_constraint_json, allowed_effects_json, expires_at,
        created_by, created_at, revoked_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grant.id,
      grant.principalId,
      grant.capabilityPattern,
      grant.providerPattern,
      grant.resourceType ?? null,
      grant.targetConstraints ? JSON.stringify(grant.targetConstraints) : null,
      JSON.stringify(grant.allowedEffects),
      grant.expiresAt ?? null,
      grant.createdBy,
      grant.createdAt,
      grant.revokedAt ?? null,
    );
  }

  revoke(grantId: string, revokedAt: string): boolean {
    const result = this.database.sqlite.prepare(`
      update capability_grants set revoked_at = ?
      where grant_id = ? and revoked_at is null
    `).run(revokedAt, grantId);
    return result.changes === 1;
  }

  close(): void {
    this.database.close();
  }
}

interface GrantRow {
  grant_id: string;
  principal_id: string;
  capability_pattern: string;
  provider_pattern: string;
  resource_type: string | null;
  target_constraint_json: string | null;
  allowed_effects_json: string;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function fromRow(row: GrantRow): StoredCapabilityGrant {
  return {
    id: row.grant_id,
    principalId: row.principal_id,
    capabilityPattern: row.capability_pattern,
    providerPattern: row.provider_pattern,
    ...(row.resource_type ? { resourceType: row.resource_type } : {}),
    ...(row.target_constraint_json
      ? { targetConstraints: JSON.parse(row.target_constraint_json) as StoredCapabilityGrant["targetConstraints"] }
      : {}),
    allowedEffects: JSON.parse(row.allowed_effects_json) as StoredCapabilityGrant["allowedEffects"],
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}
