import type Database from "better-sqlite3";

interface Migration {
  version: number;
  name: string;
  up(sqlite: Database.Database): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "workspace-state",
    up: migrateWorkspaceState,
  },
  {
    version: 2,
    name: "oauth-state",
    up: migrateOAuthState,
  },
  {
    version: 3,
    name: "local-agent-sessions",
    up: migrateLocalAgentSessions,
  },
  {
    version: 4,
    name: "single-active-checkout-workspace",
    up: migrateSingleActiveCheckoutWorkspace,
  },
  {
    version: 5,
    name: "capability-runtime-catalog",
    up: migrateCapabilityRuntimeCatalog,
  },
];

export function migrateDatabase(sqlite: Database.Database): void {
  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);

    const applied = new Set(
      (
        sqlite.prepare("select version from devspace_schema_migrations").all() as Array<{
          version: number;
        }>
      ).map((row) => row.version),
    );
    const recordMigration = sqlite.prepare(
      "insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)",
    );

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      migration.up(sqlite);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    }
  });

  migrate.immediate();
}

function migrateWorkspaceState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);

  addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
  addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
  addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}

function migrateOAuthState(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}

function migrateLocalAgentSessions(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);

  addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}

function migrateSingleActiveCheckoutWorkspace(sqlite: Database.Database): void {
  sqlite.exec(`
    update workspace_sessions as stale
    set status = 'superseded'
    where stale.mode = 'checkout'
      and stale.status = 'active'
      and exists (
        select 1
        from workspace_sessions as newer
        where newer.root = stale.root
          and newer.mode = 'checkout'
          and newer.status = 'active'
          and (
            newer.last_used_at > stale.last_used_at
            or (
              newer.last_used_at = stale.last_used_at
              and newer.created_at > stale.created_at
            )
            or (
              newer.last_used_at = stale.last_used_at
              and newer.created_at = stale.created_at
              and newer.id > stale.id
            )
          )
      );

    create unique index if not exists workspace_sessions_active_checkout_root_unique
      on workspace_sessions(root)
      where mode = 'checkout' and status = 'active';
  `);
}

function migrateCapabilityRuntimeCatalog(sqlite: Database.Database): void {
  sqlite.exec(`
    create table if not exists capability_providers (
      provider_id text primary key,
      kind text not null,
      enabled integer not null default 0,
      manifest_digest text,
      state text not null,
      last_seen_at text,
      last_error_code text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists capability_providers_state_idx
      on capability_providers(state, updated_at desc);

    create table if not exists capability_descriptors (
      capability_id text primary key,
      version text not null,
      provider_id text not null,
      descriptor_json text not null,
      descriptor_digest text not null,
      catalog_revision integer not null,
      discovered_at text not null,
      retired_at text,
      foreign key (provider_id) references capability_providers(provider_id) on delete cascade
    );

    create index if not exists capability_descriptors_provider_idx
      on capability_descriptors(provider_id, retired_at);

    create index if not exists capability_descriptors_revision_idx
      on capability_descriptors(catalog_revision);

    create table if not exists capability_catalog_state (
      singleton integer primary key check (singleton = 1),
      revision integer not null,
      updated_at text not null
    );

    insert into capability_catalog_state (singleton, revision, updated_at)
    values (1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    on conflict(singleton) do nothing;

    create table if not exists capability_grants (
      grant_id text primary key,
      principal_id text not null,
      capability_pattern text not null,
      provider_pattern text not null,
      resource_type text,
      target_constraint_json text,
      allowed_effects_json text not null,
      expires_at text,
      created_by text not null,
      created_at text not null,
      revoked_at text
    );

    create index if not exists capability_grants_principal_idx
      on capability_grants(principal_id, revoked_at);

    create index if not exists capability_grants_expiry_idx
      on capability_grants(expires_at);

    create table if not exists capability_invocations (
      invocation_id text primary key,
      principal_id text not null,
      capability_id text not null,
      provider_id text not null,
      lease_id text,
      status text not null,
      arguments_digest text not null,
      result_digest text,
      error_code text,
      queued_at text not null,
      started_at text,
      finished_at text,
      expires_at text not null
    );

    create index if not exists capability_invocations_principal_idx
      on capability_invocations(principal_id, queued_at desc);

    create index if not exists capability_invocations_status_idx
      on capability_invocations(status, queued_at desc);

    create table if not exists capability_audit_events (
      event_id text primary key,
      request_id text not null,
      principal_id text not null,
      event_type text not null,
      capability_id text,
      provider_id text,
      decision text,
      redacted_summary_json text not null,
      created_at text not null
    );

    create index if not exists capability_audit_events_created_idx
      on capability_audit_events(created_at desc);

    create index if not exists capability_audit_events_principal_idx
      on capability_audit_events(principal_id, created_at desc);
  `);
}

function addColumnIfMissing(
  sqlite: Database.Database,
  table: "workspace_sessions" | "local_agent_sessions",
  column: string,
  definition: string,
): void {
  const columns = sqlite.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((existingColumn) => existingColumn.name === column)) return;

  sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
