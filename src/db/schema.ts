import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceSessions = sqliteTable(
  "workspace_sessions",
  {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
  ],
);

export const loadedAgentFiles = sqliteTable(
  "loaded_agent_files",
  {
    workspaceSessionId: text("workspace_session_id")
      .notNull()
      .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
  ],
);

export const oauthClients = sqliteTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
  },
);

export const oauthAccessTokens = sqliteTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const oauthRefreshTokens = sqliteTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
  },
);

export const localAgentSessions = sqliteTable(
  "local_agent_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
  ],
);

export const capabilityProviders = sqliteTable(
  "capability_providers",
  {
    providerId: text("provider_id").primaryKey(),
    kind: text("kind").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    manifestDigest: text("manifest_digest"),
    state: text("state").notNull(),
    lastSeenAt: text("last_seen_at"),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("capability_providers_state_idx").on(table.state, table.updatedAt)],
);

export const capabilityDescriptors = sqliteTable(
  "capability_descriptors",
  {
    capabilityId: text("capability_id").primaryKey(),
    version: text("version").notNull(),
    providerId: text("provider_id")
      .notNull()
      .references(() => capabilityProviders.providerId, { onDelete: "cascade" }),
    descriptorJson: text("descriptor_json").notNull(),
    descriptorDigest: text("descriptor_digest").notNull(),
    catalogRevision: integer("catalog_revision").notNull(),
    discoveredAt: text("discovered_at").notNull(),
    retiredAt: text("retired_at"),
  },
  (table) => [
    index("capability_descriptors_provider_idx").on(table.providerId, table.retiredAt),
    index("capability_descriptors_revision_idx").on(table.catalogRevision),
  ],
);

export const capabilityCatalogState = sqliteTable("capability_catalog_state", {
  singleton: integer("singleton").primaryKey(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const capabilityGrants = sqliteTable(
  "capability_grants",
  {
    grantId: text("grant_id").primaryKey(),
    principalId: text("principal_id").notNull(),
    capabilityPattern: text("capability_pattern").notNull(),
    providerPattern: text("provider_pattern").notNull(),
    resourceType: text("resource_type"),
    targetConstraintJson: text("target_constraint_json"),
    allowedEffectsJson: text("allowed_effects_json").notNull(),
    expiresAt: text("expires_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("capability_grants_principal_idx").on(table.principalId, table.revokedAt),
    index("capability_grants_expiry_idx").on(table.expiresAt),
  ],
);

export const capabilityInvocations = sqliteTable(
  "capability_invocations",
  {
    invocationId: text("invocation_id").primaryKey(),
    principalId: text("principal_id").notNull(),
    capabilityId: text("capability_id").notNull(),
    providerId: text("provider_id").notNull(),
    leaseId: text("lease_id"),
    status: text("status").notNull(),
    argumentsDigest: text("arguments_digest").notNull(),
    resultDigest: text("result_digest"),
    errorCode: text("error_code"),
    queuedAt: text("queued_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("capability_invocations_principal_idx").on(table.principalId, table.queuedAt),
    index("capability_invocations_status_idx").on(table.status, table.queuedAt),
  ],
);

export const capabilityAuditEvents = sqliteTable(
  "capability_audit_events",
  {
    eventId: text("event_id").primaryKey(),
    requestId: text("request_id").notNull(),
    principalId: text("principal_id").notNull(),
    eventType: text("event_type").notNull(),
    capabilityId: text("capability_id"),
    providerId: text("provider_id"),
    decision: text("decision"),
    redactedSummaryJson: text("redacted_summary_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("capability_audit_events_created_idx").on(table.createdAt),
    index("capability_audit_events_principal_idx").on(table.principalId, table.createdAt),
  ],
);

export type WorkspaceSessionRow = typeof workspaceSessions.$inferSelect;
export type NewWorkspaceSessionRow = typeof workspaceSessions.$inferInsert;
export type LoadedAgentFileRow = typeof loadedAgentFiles.$inferSelect;
export type NewLoadedAgentFileRow = typeof loadedAgentFiles.$inferInsert;
export type LocalAgentSessionRow = typeof localAgentSessions.$inferSelect;
export type NewLocalAgentSessionRow = typeof localAgentSessions.$inferInsert;
export type CapabilityProviderRow = typeof capabilityProviders.$inferSelect;
export type CapabilityDescriptorRow = typeof capabilityDescriptors.$inferSelect;
