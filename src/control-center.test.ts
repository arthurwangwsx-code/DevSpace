import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startControlCenter, __test } from "./control-center.js";
import { loadDevspaceFiles, writeDevspaceAuth, writeDevspaceConfig } from "./user-config.js";

const dir = mkdtempSync(join(tmpdir(), "devspace-control-center-test-"));
process.env.DEVSPACE_CONFIG_DIR = dir;

writeDevspaceConfig({ allowedRoots: [dir], port: 17676 });
writeDevspaceAuth({ ownerToken: "test-owner-token" });

const running = await startControlCenter({ host: "127.0.0.1", port: 0, token: "control-token", openBrowser: false });
try {
  const root = await fetch(running.url);
  assert.equal(root.status, 200);
  assert.equal(root.headers.get("cache-control"), "no-store");
  assert.equal(root.headers.get("referrer-policy"), "no-referrer");
  assert.match(root.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  const html = await root.text();
  assert.match(html, /history\.replaceState/);

  const base = running.url.replace(/\?token=.*$/, "").replace(/\/$/, "");
  const noToken = await fetch(`${base}/api/config`);
  assert.equal(noToken.status, 401);
  const queryToken = await fetch(`${base}/api/config?token=control-token`);
  assert.equal(queryToken.status, 401);
  const authorized = await fetch(`${base}/api/config`, { headers: { authorization: "Bearer control-token" } });
  assert.equal(authorized.status, 200);

  const savedTunnelKey = await fetch(`${base}/api/actions/tunnel.saveApiKey`, {
    method: "POST",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({ apiKey: "runtime-test-key" }),
  });
  assert.equal(savedTunnelKey.status, 200);
  const savedTunnelKeyBody = await savedTunnelKey.json() as { result?: { path?: string } };
  assert.ok(savedTunnelKeyBody.result?.path);
  assert.equal(readFileSync(savedTunnelKeyBody.result.path!, "utf8"), "runtime-test-key\n");
  assert.equal((await import("node:fs")).statSync(savedTunnelKeyBody.result.path!).mode & 0o777, 0o600);

  const emptyRoots = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({ allowedRoots: [], port: 17676 }),
  });
  assert.equal(emptyRoots.status, 400);

  const saved = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { authorization: "Bearer control-token", "content-type": "application/json" },
    body: JSON.stringify({
      allowedRoots: [dir],
      port: 17676,
      tunnel: { enabled: false, command: null, cwd: null },
    }),
  });
  assert.equal(saved.status, 200);
  const config = loadDevspaceFiles().config;
  assert.equal(config.tunnel?.command, undefined);
  assert.equal(config.tunnel?.cwd, undefined);

  const configPath = loadDevspaceFiles().configPath;
  writeFileSync(configPath, readFileSync(configPath), { mode: 0o644 });
  writeDevspaceConfig(loadDevspaceFiles().config);
  const mode = (await import("node:fs")).statSync(configPath).mode & 0o777;
  assert.equal(mode, 0o600);
  const authPath = loadDevspaceFiles().authPath;
  writeFileSync(authPath, JSON.stringify({ ownerToken: "test-owner-token" }), { mode: 0o644 });
  writeDevspaceAuth(loadDevspaceFiles().auth);
  const authMode = (await import("node:fs")).statSync(authPath).mode & 0o777;
  assert.equal(authMode, 0o600);

  assert.throws(() => __test.normalizeControlCenterConfig({ allowedRoots: [], port: 7676 }), /At least one allowed workspace root/);
  assert.throws(() => __test.normalizeControlCenterConfig({ allowedRoots: [dir], port: 70000 }), /Port must be between/);
  assert.throws(
    () => __test.requireConfiguredWorkspaceRoots({}),
    (error: unknown) => {
      const typed = error as Error & { statusCode?: number };
      assert.equal(typed.statusCode, 400);
      assert.match(typed.message, /Choose at least one workspace folder/);
      return true;
    },
  );
  const preset = __test.normalizeControlCenterConfig({
    allowedRoots: [dir],
    port: 17676,
    tunnel: {
      enabled: false,
      preset: "tunnel-client",
      tunnelId: "tunnel_test",
      apiKeyFile: "/tmp/devspace-test-key",
      command: process.execPath,
    },
  });
  assert.equal(preset.tunnel?.preset, "tunnel-client");
  assert.deepEqual(preset.tunnel?.args, [
    "run",
    "--control-plane.api-key=file:${apiKeyFile}",
    "--control-plane.tunnel-id=${tunnelId}",
    "--mcp.server-url=${localMcpUrl}",
  ]);
  assert.throws(() => __test.normalizeControlCenterConfig({
    allowedRoots: [dir],
    tunnel: { enabled: true, preset: "tunnel-client", command: process.execPath, tunnelId: null, apiKeyFile: null },
  }), /Tunnel ID is required/);

  await assert.rejects(
    () => __test.runCommand("/bin/sh", ["-c", "printf fail >&2; exit 7"]),
    (error: unknown) => {
      const typed = error as Error & { statusCode?: number; result?: { code?: number; stderr?: string } };
      assert.equal(typed.statusCode, 422);
      assert.equal(typed.result?.code, 7);
      assert.match(typed.result?.stderr ?? "", /fail/);
      return true;
    },
  );

  console.log("control center tests passed: auth, headers, config safety, tunnel preset, explicit clears, file mode, command failure semantics");
} finally {
  await running.close();
}
