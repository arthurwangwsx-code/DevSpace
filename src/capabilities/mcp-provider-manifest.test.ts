import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installMcpProviderManifest,
  loadMcpProviderManifests,
  parseMcpProviderManifest,
} from "./mcp-provider-manifest.js";

const fixture = {
  apiVersion: "devspace.capabilities/v1",
  kind: "McpProvider",
  metadata: { id: "test.external.mcp" },
  spec: {
    transport: { type: "stdio", command: process.execPath, args: [] },
    tools: [{
      tool: "echo",
      capabilityId: "test.external.echo",
      effects: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
    }],
  },
};
const parsed = parseMcpProviderManifest(fixture);
assert.equal(parsed.spec.enabled, true);
assert.equal(parsed.spec.tools[0]!.defaultTimeoutMs, 30_000);
assert.deepEqual(parsed.spec.tools[0]!.availability, {
  requiresAwake: false,
  requiresLoggedInSession: false,
  requiresUnlocked: false,
  requiresForegroundApp: false,
});
assert.deepEqual(parsed.spec.tools[0]!.permissions, []);
assert.equal(parsed.spec.tools[0]!.requiresLease, false);
assert.deepEqual(parsed.spec.tools[0]!.resourceTypes, []);
assert.throws(() => parseMcpProviderManifest({
  ...fixture,
  spec: { ...fixture.spec, transport: { type: "stdio", command: "npx" } },
}), /stdio command must be absolute/);
assert.throws(() => parseMcpProviderManifest({
  ...fixture,
  spec: { ...fixture.spec, transport: { type: "streamable-http", url: "http://example.com/mcp" } },
}), /HTTPS or loopback/);
assert.throws(() => parseMcpProviderManifest({
  ...fixture,
  spec: { ...fixture.spec, tools: [fixture.spec.tools[0], fixture.spec.tools[0]] },
}), /duplicate/);
assert.throws(() => parseMcpProviderManifest({
  ...fixture,
  spec: { ...fixture.spec, tools: [{ ...fixture.spec.tools[0], requiresLease: true }] },
}), /lease-bound tools require resourceTypes/);

const root = mkdtempSync(join(tmpdir(), "devspace-mcp-manifest-test-"));
try {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "b.yaml"), JSON.stringify(fixture));
  writeFileSync(join(root, "a.json"), JSON.stringify({
    ...fixture,
    metadata: { id: "test.external.first" },
    spec: { ...fixture.spec, tools: [{ ...fixture.spec.tools[0], capabilityId: "test.external.first" }] },
  }));
  assert.deepEqual(
    loadMcpProviderManifests(root).map(({ manifest }) => manifest.metadata.id),
    ["test.external.first", "test.external.mcp"],
  );
  const installed = installMcpProviderManifest(join(root, "b.yaml"), join(root, "installed"));
  assert.equal(installed, join(root, "installed", "test.external.mcp.json"));
  assert.equal(loadMcpProviderManifests(join(root, "installed")).length, 1);
  assert.throws(
    () => installMcpProviderManifest(join(root, "b.yaml"), join(root, "installed")),
    /EEXIST/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("MCP provider manifest tests passed: schema, safe transports, defaults, deterministic load");
