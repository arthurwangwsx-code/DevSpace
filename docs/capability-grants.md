# Capability grants

Capability discovery uses OAuth scopes for coarse API access and persistent grants for per-principal,
per-provider, per-capability authorization. A token with `capabilities:invoke` is not enough by itself.

The admin API is fixed:

```text
GET    /api/capabilities/v1/grants
POST   /api/capabilities/v1/grants
DELETE /api/capabilities/v1/grants/:grantId
```

Only a principal with `capabilities:admin` may use it. Example:

```json
{
  "principalId": "ci:browser-fixture",
  "capabilityPattern": "browser.chrome.*",
  "providerPattern": "browser.chrome.devtools",
  "resourceType": "browser_page",
  "allowedEffects": ["readOnly", "mutation", "openWorld"],
  "targetConstraints": { "origins": ["http://127.0.0.1:4173"] },
  "expiresAt": "2026-09-14T00:00:00Z"
}
```

The same operation is available to operators through `devspace grants add|list|revoke`. Grant IDs
are generated when omitted. Duplicate IDs fail closed, expiration must be in the future, revocation is
durable, and all changes are audited without storing invocation arguments or results.
