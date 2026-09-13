import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installMcpProviderManifest,
  archiveMcpProviderManifest,
  loadMcpProviderManifests,
  parseMcpProviderManifest,
  setMcpProviderEnabled,
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
assert.equal(parsed.spec.discoverAllTools, false);
assert.equal(parsed.spec.discoveredToolVersion, "1.0.0");
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
const discoveryOnly = parseMcpProviderManifest({
  ...fixture,
  metadata: { id: "test.discovery.mcp" },
  spec: {
    transport: fixture.spec.transport,
    discoverAllTools: true,
    discoveredToolVersion: "2.1.0",
  },
});
assert.equal(discoveryOnly.spec.discoverAllTools, true);
assert.equal(discoveryOnly.spec.discoveredToolVersion, "2.1.0");
assert.deepEqual(discoveryOnly.spec.tools, []);
assert.throws(() => parseMcpProviderManifest({
  ...fixture,
  spec: { transport: fixture.spec.transport, tools: [] },
}), /tools must not be empty unless discoverAllTools=true/);

const root = mkdtempSync(join(tmpdir(), "devspace-mcp-manifest-test-"));
try {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "b.yaml"), JSON.stringify(fixture), { mode: 0o600 });
  writeFileSync(join(root, "a.json"), JSON.stringify({
    ...fixture,
    metadata: { id: "test.external.first" },
    spec: { ...fixture.spec, tools: [{ ...fixture.spec.tools[0], capabilityId: "test.external.first" }] },
  }), { mode: 0o600 });
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
  setMcpProviderEnabled("test.external.mcp", false, join(root, "installed"));
  assert.equal(JSON.parse(readFileSync(installed, "utf8")).spec.enabled, false);
  setMcpProviderEnabled("test.external.mcp", true, join(root, "installed"));
  assert.equal(JSON.parse(readFileSync(installed, "utf8")).spec.enabled, true);
  const archived = archiveMcpProviderManifest("test.external.mcp", join(root, "installed"));
  assert.equal(existsSync(archived.path), false);
  assert.equal(existsSync(archived.archivedPath), true);

  if (process.platform !== "win32") {
    const insecure = join(root, "insecure");
    mkdirSync(insecure);
    const insecureFile = join(insecure, "provider.json");
    writeFileSync(insecureFile, JSON.stringify(fixture), { mode: 0o644 });
    assert.throws(() => loadMcpProviderManifests(insecure), /mode 0600 or stricter/);
    chmodSync(insecureFile, 0o600);
    const linked = join(insecure, "linked.json");
    symlinkSync(insecureFile, linked);
    assert.throws(() => loadMcpProviderManifests(insecure), /regular file/);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("MCP provider manifest tests passed: schema, safe transports, secure files, lifecycle, deterministic load");
