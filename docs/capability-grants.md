# Capability grants

DevSpace defaults to delegated approval: an authenticated Agent can discover and invoke capabilities without
a DevSpace Grant, because that Agent owns the approval workflow. Persistent per-principal, per-provider and
per-capability Grants remain as an opt-in compatibility mode. Enable them with:

```bash
DEVSPACE_CAPABILITY_ENFORCE_POLICY=1
```

The admin API is fixed:

```text
GET    /api/capabilities/v1/grants
POST   /api/capabilities/v1/grants
DELETE /api/capabilities/v1/grants/:grantId
```

Only enforced-policy mode interprets these records during invocation, and in that mode a principal with
`capabilities:admin` manages them. Example:

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
