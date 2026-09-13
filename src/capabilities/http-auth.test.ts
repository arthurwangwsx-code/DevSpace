import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { SqliteOAuthClientsStore, SqliteOAuthStore } from "../oauth-store.js";
import { createServer } from "../server.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-auth-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "capability-auth-owner-token-long-enough",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_LOG_LEVEL: "silent",
});
const capabilityResource = new URL("/capabilities/mcp", config.publicBaseUrl).href;
const workspaceResource = new URL("/mcp", config.publicBaseUrl).href;
const now = Math.floor(Date.now() / 1_000);
const store = new SqliteOAuthStore(config.stateDir);
const client = new SqliteOAuthClientsStore(store, ["localhost"]).registerClient({
  redirect_uris: ["http://localhost/callback"],
});
store.saveAccessToken(hash("valid-discover"), {
  clientId: client.client_id,
  scopes: ["capabilities:discover"],
  expiresAt: now + 3_600,
  resource: capabilityResource,
});
store.saveAccessToken(hash("wrong-scope"), {
  clientId: client.client_id,
  scopes: ["devspace"],
  expiresAt: now + 3_600,
  resource: capabilityResource,
});
store.saveAccessToken(hash("wrong-audience"), {
  clientId: client.client_id,
  scopes: ["capabilities:discover"],
  expiresAt: now + 3_600,
  resource: workspaceResource,
});
store.saveAccessToken(hash("expired"), {
  clientId: client.client_id,
  scopes: ["capabilities:discover"],
  expiresAt: now - 1,
  resource: capabilityResource,
});
store.close();

const running = createServer(config);
const server = running.app.listen(0, "127.0.0.1");
try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/api/capabilities/v1/providers`;

  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await authorizedFetch(endpoint, "wrong-scope")).status, 403);
  assert.equal((await authorizedFetch(endpoint, "wrong-audience")).status, 403);
  assert.equal((await authorizedFetch(endpoint, "expired")).status, 401);
  const accepted = await authorizedFetch(endpoint, "valid-discover");
  assert.equal(accepted.status, 200);

  const existingMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(existingMetadata.status, 200);
  assert.equal((await existingMetadata.json() as any).resource, workspaceResource);
  const capabilityMetadata = await fetch(
    `${origin}/.well-known/oauth-protected-resource/capabilities/mcp`,
  );
  assert.equal(capabilityMetadata.status, 200);
  const metadata = await capabilityMetadata.json() as any;
  assert.equal(metadata.resource, capabilityResource);
  assert.deepEqual(metadata.scopes_supported, ["capabilities:discover", "capabilities:invoke"]);

  console.log("capability auth tests passed: token, scope, audience, expiry, dual metadata");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}

function authorizedFetch(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
