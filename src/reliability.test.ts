import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { get } from "node:http";
import { discoverContextFiles, discoverContextFilesFallback } from "./context-discovery.js";
import { readTextPage, READ_PAGE_BYTES } from "./file-reader.js";
import { createHttpApp } from "./http-app.js";
import { loadConfig } from "./config.js";
import { applyPatch } from "./apply-patch.js";

const root = await mkdtemp(join(tmpdir(), "devspace-reliability-"));
try {
  for (const directory of ["src", ".hidden", ".build/checkouts/dependency", ".gradle/cache", "Pods"] ) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, "AGENTS.md"), "instructions");
  }
  const expected = [join(root, "src/AGENTS.md"), join(root, ".hidden/AGENTS.md")].sort();
  assert.deepEqual((await discoverContextFiles(root)).sort(), expected);
  assert.deepEqual((await discoverContextFilesFallback(root)).sort(), expected);
  assert.equal((await discoverContextFilesFallback(root, { maxEntries: 0, maxFiles: 1, timeoutMs: 20 })).length, 0);
  assert.equal((await discoverContextFilesFallback(root, { maxEntries: 100, maxFiles: 1, timeoutMs: 1000 })).length, 1);

  const path = join(root, "large.txt");
  const original = "中文🙂".repeat(READ_PAGE_BYTES / 4) + "\nlast line\n";
  await writeFile(path, original);
  let byteOffset = 0;
  let combined = "";
  do {
    const result = await readTextPage(path, { byteOffset });
    combined += result.text.split("\n[More content:")[0];
    assert.ok(result.details.bytesRead <= READ_PAGE_BYTES);
    if (!result.details.truncated) break;
    assert.ok(result.details.nextByteOffset! > byteOffset);
    byteOffset = result.details.nextByteOffset!;
  } while (true);
  assert.equal(combined, original);
  const last = await readTextPage(path, { offset: 2, limit: 1 });
  assert.equal(last.text, "last line\n");
  await assert.rejects(readTextPage(path, { offset: 1, byteOffset: 1 }), /not both/);
  await writeFile(path, "a\nb\nc\n");
  assert.equal((await readTextPage(path, { offset: 2, limit: 1 })).details.nextByteOffset, 4);
  await assert.rejects(readTextPage(path, { byteOffset: 99 }), /beyond/);
  // A sparse 8 GiB file must never be materialized in memory; seek to its tail.
  const sparse = await open(path, "w");
  await sparse.truncate(8 * 1024 ** 3);
  await sparse.write(Buffer.from("tail"), 0, 4, 8 * 1024 ** 3 - 4);
  await sparse.close();
  assert.equal((await readTextPage(path, { byteOffset: 8 * 1024 ** 3 - 4 })).text, "tail");
  await assert.rejects(applyPatch(root, "*** Begin Patch\n*** Delete File: large.txt\n*** End Patch"), /patch budget/);

  const config = loadConfig({
    DEVSPACE_CONFIG_DIR: join(root, "config"),
    DEVSPACE_OAUTH_OWNER_TOKEN: "reliability-test-owner-token",
    DEVSPACE_AUTH_MODE: "trusted-local",
    DEVSPACE_MCP_MAX_CONCURRENT_REQUESTS: "16",
    DEVSPACE_MCP_MAX_QUEUED_REQUESTS: "32",
  });
  assert.equal(config.resources.mcpMaxRequestBytes, 16 * 1024 * 1024);
  assert.throws(() => loadConfig({ DEVSPACE_MCP_MAX_REQUEST_BYTES: String(65 * 1024 * 1024), DEVSPACE_OAUTH_OWNER_TOKEN: "reliability-test-owner-token" }), /64 MiB/);
  const app = createHttpApp(config);
  const held: Array<() => void> = [];
  app.post("/mcp", (req, res) => {
    if (req.body.content === "hold") {
      held.push(() => res.end("{}"));
      res.write(" ");
    } else res.json({ size: req.body.content.length });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  try {
    const post = (content: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
    const large = await post("x".repeat(2 * 1024 * 1024));
    assert.equal(large.status, 200);
    assert.equal((await large.json()).size, 2 * 1024 * 1024);
    const oversized = await post("x".repeat(16 * 1024 * 1024));
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error.message, /split/);
    const valid = await post("still healthy");
    assert.equal(valid.status, 200);
    await valid.text();
    const hostileStatus = await new Promise<number | undefined>((resolve, reject) => {
      get(url, { headers: { host: "evil.example" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }).on("error", reject);
    });
    assert.equal(hostileStatus, 403);
    const reservations = await Promise.all(Array.from({ length: 48 }, () => post("hold")));
    const busy = await post("forty-ninth");
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "2");
    await busy.text();
    held.forEach((finish) => finish());
    await Promise.all(reservations.map((res) => res.text()));
    const available = await post("slot released");
    assert.equal(available.status, 200);
    await available.text();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log("reliability tests passed: bounded discovery, UTF-8 paging, 8 GiB seek, 2 MiB JSON, 413, host protection");
} finally { await rm(root, { recursive: true, force: true }); }
