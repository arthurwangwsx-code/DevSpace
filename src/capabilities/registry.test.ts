import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/client.js";
import { SqliteCapabilityCatalogStore } from "./catalog-store.js";
import { CapabilityError } from "./errors.js";
import { CapabilityRegistry, type DiscoveredCapability } from "./registry.js";
import type { CapabilityDescriptor, JsonValue, ProviderHealth } from "./types.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-registry-"));
const ready: ProviderHealth = { state: "ready", since: "2026-09-13T00:00:00.000Z" };

try {
  const store = new SqliteCapabilityCatalogStore(root);
  const registry = new CapabilityRegistry(store);
  assert.equal(registry.revision, 0);

  const snapshot = capability("browser.chrome.take_snapshot", "Read page snapshot", ["snapshot"]);
  const click = capability("browser.chrome.click", "Click page element", ["browser", "mutation"], false);
  assert.equal(registry.replaceProviderCatalog({
    providerId: "browser.chrome.devtools",
    kind: "mcp-stdio",
    health: ready,
    capabilities: [snapshot, click],
  }), 1);
  assert.equal(registry.list().items.length, 2);
  assert.equal(registry.list({ availableOnly: true }).items.length, 2);

  const firstPage = registry.list({ limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const secondPage = registry.list({ limit: 1, cursor: firstPage.nextCursor });
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);

  assert.equal(registry.search({ query: "snapshot", availableOnly: true }).items[0]?.capability.id,
    "browser.chrome.take_snapshot");
  assert.equal(registry.search({ query: "点击页面", availableOnly: true }).items[0]?.capability.id,
    "browser.chrome.click");

  const previousRevision = registry.revision;
  assert.throws(
    () => registry.replaceProviderCatalog({
      providerId: "desktop.macos.accessibility",
      kind: "native-socket",
      health: ready,
      capabilities: [{
        ...snapshot,
        descriptor: { ...snapshot.descriptor, providerId: "desktop.macos.accessibility" },
      }],
    }),
    (error) => error instanceof CapabilityError && error.code === "conflict",
  );
  assert.equal(registry.revision, previousRevision);
  assert.equal(registry.getDescriptor("browser.chrome.take_snapshot")?.providerId,
    "browser.chrome.devtools");

  assert.throws(
    () => registry.replaceProviderCatalog({
      providerId: "browser.chrome.devtools",
      kind: "mcp-stdio",
      health: ready,
      capabilities: [{
        ...snapshot,
        descriptor: { ...snapshot.descriptor, inputSchema: { type: "object", required: ["changed"] } },
      }],
    }),
    (error) => error instanceof CapabilityError
      && error.code === "conflict"
      && /without a version change/.test(error.message),
  );

  const staleCursor = firstPage.nextCursor;
  registry.replaceProviderCatalog({
    providerId: "browser.chrome.devtools",
    kind: "mcp-stdio",
    health: ready,
    capabilities: [snapshot],
  });
  assert.throws(
    () => registry.list({ cursor: staleCursor }),
    (error) => error instanceof CapabilityError && error.code === "conflict",
  );
  store.close();

  const restoredStore = new SqliteCapabilityCatalogStore(root);
  const restored = new CapabilityRegistry(restoredStore);
  assert.equal(restored.revision, 2);
  assert.equal(restored.list().items.length, 1);
  assert.equal(restored.list().items[0]?.availability.state, "unavailable");
  assert.throws(
    () => restored.getBinding("browser.chrome.take_snapshot"),
    (error) => error instanceof CapabilityError && error.code === "provider_unavailable",
  );
  restoredStore.close();

  const database = openDatabase(root);
  try {
    const migrations = database.sqlite
      .prepare("select version, name from devspace_schema_migrations order by version")
      .all() as Array<{ version: number; name: string }>;
    assert.deepEqual(migrations.at(-1), { version: 5, name: "capability-runtime-catalog" });
    const descriptorColumns = database.sqlite
      .prepare("pragma table_info(capability_descriptors)")
      .all() as Array<{ name: string }>;
    assert.ok(descriptorColumns.some(({ name }) => name === "descriptor_digest"));
  } finally {
    database.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function capability(
  id: string,
  title: string,
  tags: string[],
  readOnly = true,
): DiscoveredCapability {
  const descriptor: CapabilityDescriptor = {
    id,
    version: "1.0.0",
    providerId: "browser.chrome.devtools",
    title,
    description: id.endsWith("click") ? "点击页面中的元素" : "读取当前 Chrome 页面语义快照",
    tags,
    inputSchema: { type: "object" },
    effects: {
      readOnly,
      destructive: false,
      idempotent: readOnly,
      openWorld: true,
    },
    permissions: [{
      id: "chrome.connection",
      required: true,
      description: "Access the current Chrome profile.",
    }],
    availability: {
      requiresAwake: false,
      requiresLoggedInSession: true,
      requiresUnlocked: false,
      requiresForegroundApp: false,
    },
    execution: {
      modes: ["sync"],
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      requiresLease: id !== "browser.chrome.list_pages",
      resourceTypes: id !== "browser.chrome.list_pages" ? ["browser_page"] : [],
    },
  };
  return {
    descriptor,
    aliases: [id.split(".").at(-1)!],
    binding: { async invoke(): Promise<JsonValue> { return { ok: true }; } },
  };
}
