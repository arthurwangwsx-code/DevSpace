import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "../db/client.js";
import { parseCapabilityDescriptor } from "./descriptor-schema.js";
import type { CapabilityDescriptor, ProviderHealth } from "./types.js";

export interface StoredCapabilityCatalog {
  revision: number;
  descriptors: CapabilityDescriptor[];
}

export class SqliteCapabilityCatalogStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
  }

  loadCatalog(): StoredCapabilityCatalog {
    const revision = this.database.sqlite
      .prepare("select revision from capability_catalog_state where singleton = 1")
      .pluck()
      .get() as number;
    const rows = this.database.sqlite
      .prepare(`
        select descriptor_json
        from capability_descriptors
        where retired_at is null
        order by capability_id
      `)
      .all() as Array<{ descriptor_json: string }>;
    return {
      revision,
      descriptors: rows.map((row) => parseCapabilityDescriptor(JSON.parse(row.descriptor_json))),
    };
  }

  replaceProviderCatalog(input: {
    providerId: string;
    kind: string;
    enabled: boolean;
    health: ProviderHealth;
    descriptors: CapabilityDescriptor[];
    manifestDigest?: string;
  }): number {
    const transaction = this.database.sqlite.transaction(() => {
      const now = new Date().toISOString();
      const revision = (this.database.sqlite
        .prepare("select revision from capability_catalog_state where singleton = 1")
        .pluck()
        .get() as number) + 1;

      this.database.sqlite.prepare(`
        insert into capability_providers (
          provider_id, kind, enabled, manifest_digest, state, last_seen_at,
          last_error_code, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(provider_id) do update set
          kind = excluded.kind,
          enabled = excluded.enabled,
          manifest_digest = excluded.manifest_digest,
          state = excluded.state,
          last_seen_at = excluded.last_seen_at,
          last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at
      `).run(
        input.providerId,
        input.kind,
        input.enabled ? 1 : 0,
        input.manifestDigest ?? null,
        input.health.state,
        now,
        input.health.reasonCode ?? null,
        now,
        now,
      );

      this.database.sqlite.prepare(`
        update capability_descriptors
        set retired_at = ?, catalog_revision = ?
        where provider_id = ? and retired_at is null
      `).run(now, revision, input.providerId);

      const upsert = this.database.sqlite.prepare(`
        insert into capability_descriptors (
          capability_id, version, provider_id, descriptor_json, descriptor_digest,
          catalog_revision, discovered_at, retired_at
        ) values (?, ?, ?, ?, ?, ?, ?, null)
        on conflict(capability_id) do update set
          version = excluded.version,
          provider_id = excluded.provider_id,
          descriptor_json = excluded.descriptor_json,
          descriptor_digest = excluded.descriptor_digest,
          catalog_revision = excluded.catalog_revision,
          discovered_at = excluded.discovered_at,
          retired_at = null
      `);
      for (const descriptor of input.descriptors) {
        const descriptorJson = canonicalJson(descriptor);
        upsert.run(
          descriptor.id,
          descriptor.version,
          descriptor.providerId,
          descriptorJson,
          createHash("sha256").update(descriptorJson).digest("base64url"),
          revision,
          now,
        );
      }

      this.database.sqlite.prepare(`
        update capability_catalog_state
        set revision = ?, updated_at = ?
        where singleton = 1
      `).run(revision, now);
      return revision;
    });
    return transaction.immediate();
  }

  close(): void {
    this.database.close();
  }
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
