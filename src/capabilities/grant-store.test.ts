import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteCapabilityGrantStore } from "./grant-store.js";

const root = mkdtempSync(join(tmpdir(), "devspace-grant-store-"));
try {
  const store = new SqliteCapabilityGrantStore(root);
  store.create({
    id: "grant-fixture",
    principalId: "agent:test",
    capabilityPattern: "browser.chrome.*",
    providerPattern: "browser.chrome.devtools",
    resourceType: "browser_page",
    allowedEffects: ["readOnly", "mutation", "openWorld"],
    targetConstraints: { origins: ["https://fixture.test"] },
    createdBy: "admin:test",
    createdAt: "2026-09-13T00:00:00.000Z",
  });
  assert.deepEqual(store.loadAll()[0], {
    id: "grant-fixture",
    principalId: "agent:test",
    capabilityPattern: "browser.chrome.*",
    providerPattern: "browser.chrome.devtools",
    resourceType: "browser_page",
    allowedEffects: ["readOnly", "mutation", "openWorld"],
    targetConstraints: { origins: ["https://fixture.test"] },
    createdBy: "admin:test",
    createdAt: "2026-09-13T00:00:00.000Z",
  });
  assert.equal(store.revoke("grant-fixture", "2026-09-13T01:00:00.000Z"), true);
  assert.equal(store.revoke("grant-fixture", "2026-09-13T02:00:00.000Z"), false);
  assert.equal(store.loadAll()[0]!.revokedAt, "2026-09-13T01:00:00.000Z");
  store.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("capability grant store tests passed: create, reload, constraints, revoke");
