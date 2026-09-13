import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { FakeCapabilityProvider } from "./fake-provider.test-support.js";

const root = mkdtempSync(join(tmpdir(), "devspace-capability-http-test-"));
const config = loadConfig({
  DEVSPACE_CONFIG_DIR: join(root, "config"),
  DEVSPACE_STATE_DIR: join(root, "state"),
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "capability-http-owner-token-long-enough",
  DEVSPACE_AUTH_MODE: "trusted-local",
  DEVSPACE_CAPABILITIES: "1",
  DEVSPACE_LOG_LEVEL: "silent",
});
const provider = new FakeCapabilityProvider();
const running = createServer(config, {
  capabilityProviders: [{ provider, kind: "test", enabled: true }],
});
const server = running.app.listen(0, "127.0.0.1");

try {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/capabilities/v1`;
  const principalId = `local:${process.getuid?.() ?? "user"}`;
  const createdGrant = await postJson(`${base}/grants`, {
    id: "test-all",
    principalId,
    capabilityPattern: "test.fake.*",
    providerPattern: "test.fake.*",
    allowedEffects: ["readOnly", "mutation", "destructive", "openWorld"],
  });
  assert.equal(createdGrant.response.status, 200);
  assert.equal(createdGrant.body.data.id, "test-all");
  const grants = await getJson(`${base}/grants`);
  assert.equal(grants.body.data.items[0].createdBy, principalId);

  const providers = await getJson(`${base}/providers`);
  assert.equal(providers.response.status, 200);
  const fakeProvider = providers.body.data.items.find((item: any) => item.id === "test.fake.provider");
  assert.equal(fakeProvider.id, "test.fake.provider");
  assert.equal(fakeProvider.health.state, "ready");

  const capabilities = await getJson(`${base}/capabilities?availableOnly=true`);
  assert.equal(capabilities.body.data.items.some((item: any) => item.id === "test.fake.echo"), true);
  assert.equal(typeof capabilities.body.meta.catalogRevision, "number");

  const search = await postJson(`${base}/capabilities/search`, {
    query: "echo",
    filters: { availableOnly: true },
  });
  assert.equal(search.body.data.items[0].capability.id, "test.fake.echo");

  const described = await getJson(`${base}/capabilities/test.fake.echo`);
  assert.equal(described.body.data.inputSchema.type, "object");

  const lease = await postJson(`${base}/leases`, {
    providerId: "test.fake.provider",
    resourceType: "test_resource",
    selector: { label: "fixture" },
    ttlSeconds: 60,
  });
  assert.match(lease.body.data.id, /^lease_/);
  const closed = await fetch(`${base}/leases/${lease.body.data.id}`, { method: "DELETE" });
  assert.equal(closed.status, 200);

  const invoked = await postJson(`${base}/invocations`, {
    capabilityId: "test.fake.echo",
    arguments: { text: "hello" },
    mode: "sync",
  });
  assert.equal(invoked.response.status, 200);
  assert.equal(invoked.body.data.status, "succeeded");
  assert.equal(invoked.body.data.result.arguments.text, "hello");

  const status = await getJson(`${base}/invocations/${invoked.body.data.id}`);
  assert.equal(status.body.data.status, "succeeded");

  const bad = await postJson(`${base}/invocations`, {
    capabilityId: "missing.capability",
    arguments: {},
  });
  assert.equal(bad.response.status, 404);
  assert.equal(bad.body.error.code, "capability_not_found");
  assert.equal(typeof bad.body.meta.requestId, "string");

  const revoked = await fetch(`${base}/grants/test-all`, { method: "DELETE" });
  assert.equal(revoked.status, 200);

  const controller = new AbortController();
  const eventsResponse = await fetch(`${base}/events`, { signal: controller.signal });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") ?? "", /text\/event-stream/);
  const firstChunk = await eventsResponse.body!.getReader().read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: snapshot/);
  controller.abort();

  console.log("capability HTTP tests passed: catalog, search, lease, invoke, error, SSE");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await running.close();
  rmSync(root, { recursive: true, force: true });
}

async function getJson(url: string) {
  const response = await fetch(url);
  return { response, body: await response.json() as any };
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() as any };
}
