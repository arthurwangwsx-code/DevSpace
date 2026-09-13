#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baseUrl = (process.env.DEVSPACE_BROWSER_REAL_BASE_URL
  ?? "http://127.0.0.1:7676/api/capabilities/v1").replace(/\/$/, "");
const uploadFile = join(projectRoot, "package.json");
const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const artifactDir = join(
  process.env.DEVSPACE_BROWSER_REAL_OUTPUT ?? join(projectRoot, ".build", "browser-control-real"),
  runId,
);
const downloadName = `devspace-browser-control-e2e-${runId}.txt`;
const steps: string[] = [];
let fixtureServer: Server | undefined;
let leaseId: string | undefined;
let downloadedFile: string | undefined;
let failure: string | undefined;

try {
  const fixture = await startFixture();
  fixtureServer = fixture.server;

  const search = await requestJson("POST", `${baseUrl}/capabilities/search`, {
    query: "browser click",
    limit: 50,
  });
  const searchItems = objectArray(objectValue(search.data).items);
  assert.ok(searchItems.some((entry) => objectValue(entry.capability).id === "browser.page.click"));
  assert.equal(searchItems.some((entry) => {
    const id = String(objectValue(entry.capability).id ?? "");
    return id.startsWith("browser.extension.") || id.startsWith("browser.chrome.");
  }), false, "internal browser backends leaked into default capability search");
  pass("canonical_search");

  const status = await invoke("browser.connection.status", {});
  assert.match(String(objectValue(status).extensionVersion ?? ""), /^0\.[3-9]\.|^[1-9]\d*\./);
  pass("extension_connected");

  const opened = objectValue(await invoke("browser.tab.open", { url: fixture.url }));
  assert.ok(Number.isInteger(opened.tabId));
  pass("tab_open");

  const leaseResponse = await requestJson("POST", `${baseUrl}/leases`, {
    providerId: "browser.control",
    resourceType: "browser_page",
    selector: { tabId: opened.tabId },
  });
  leaseId = String(objectValue(leaseResponse.data).id);
  assert.ok(leaseId.startsWith("lease_"));
  pass("lease_open");

  await sleep(500);
  const snapshot = objectValue(await invoke("browser.page.snapshot", {}, true));
  const elements = objectArray(snapshot.elements).map(objectValue);
  const shadow = requiredElement(elements, "Shadow Action");
  const frame = requiredElement(elements, "Frame Action");
  const upload = requiredElement(elements, "Upload fixture");
  const secure = requiredElement(elements, "Secure fixture input");
  assert.equal(shadow.shadow, true);
  assert.ok(Array.isArray(frame.framePath) && frame.framePath.length > 0);
  assert.equal(secure.secure, true);
  pass("shadow_iframe_discovery");

  const secureMarker = "DevSpace secure fixture value";
  await invoke("browser.page.click", { index: secure.index }, true);
  await invoke("browser.page.type", { text: secureMarker }, true);
  const secureSnapshot = objectValue(await invoke("browser.page.snapshot", {}, true));
  assert.equal(secureSnapshot.title, `secure-length:${secureMarker.length}`);
  assert.equal(JSON.stringify(secureSnapshot).includes(secureMarker), false, "secure input value leaked into snapshot");
  assert.equal(requiredElement(objectArray(secureSnapshot.elements), "Secure fixture input").secure, true);
  pass("secure_input_write_redaction");

  await invoke("browser.page.click", { index: shadow.index }, true);
  assert.equal(objectValue(await invoke("browser.page.evaluate", { expression: "document.title" }, true)).value, "shadow-clicked");
  pass("shadow_click");

  await invoke("browser.page.click", { index: frame.index }, true);
  assert.equal(objectValue(await invoke("browser.page.evaluate", { expression: "document.title" }, true)).value, "frame-clicked");
  pass("iframe_click");

  const uploaded = objectValue(await invoke("browser.file.upload", {
    index: upload.index,
    files: [uploadFile],
  }, true));
  assert.equal(uploaded.files, 1);
  const uploadedName = objectValue(await invoke("browser.page.evaluate", {
    expression: "document.querySelector('input[type=file]').files[0]?.name",
  }, true));
  assert.equal(uploadedName.value, "package.json");
  pass("file_upload");

  await invoke("browser.page.evaluate", {
    expression: "fetch('/api/slow'); 'started'",
    awaitPromise: false,
  }, true);
  const idleStarted = Date.now();
  const idle = objectValue(await invoke("browser.page.wait", {
    networkIdleMs: 300,
    timeoutMs: 5_000,
    intervalMs: 50,
  }, true));
  assert.equal(idle.condition, "network_idle");
  assert.ok(Date.now() - idleStarted >= 250);
  pass("network_idle_wait");

  await invoke("browser.page.navigate", { url: `${fixture.url}nav` }, true);
  const urlWait = objectValue(await invoke("browser.page.wait", {
    urlContains: "/nav",
    timeoutMs: 5_000,
  }, true));
  assert.equal(urlWait.condition, "url");
  pass("url_wait");

  const download = objectValue(await invoke("browser.file.download", {
    url: `${fixture.url}download`,
    filename: `DevSpace/${downloadName}`,
    saveAs: false,
  }));
  assert.ok(Number.isInteger(download.downloadId));
  const completed = objectValue(await invoke("browser.file.wait_download", {
    downloadId: download.downloadId,
    timeoutMs: 10_000,
    intervalMs: 50,
  }));
  assert.equal(completed.state, "complete");
  downloadedFile = typeof completed.filename === "string" ? completed.filename : undefined;
  const downloadStatus = objectValue(await invoke("browser.file.download_status", {
    downloadId: download.downloadId,
  }));
  assert.equal(downloadStatus.state, "complete");
  if (downloadedFile && existsSync(downloadedFile)) {
    assert.equal((await readFile(downloadedFile, "utf8")), "devspace-download-ok\n");
  }
  pass("download_wait_status");
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  if (leaseId) {
    await requestJson("DELETE", `${baseUrl}/leases/${leaseId}`).catch(() => {});
  }
  if (fixtureServer) await closeServer(fixtureServer).catch(() => {});
  if (downloadedFile) {
    await rm(downloadedFile, { force: true }).catch(() => {});
    await rm(dirname(downloadedFile), { recursive: false }).catch(() => {});
  } else {
    await rm(join(homedir(), "Downloads", "DevSpace", downloadName), { force: true }).catch(() => {});
  }
}

const report = {
  ok: failure === undefined,
  mode: "live-current-profile",
  baseUrl,
  startedAt: runId,
  finishedAt: new Date().toISOString(),
  passed: steps.length,
  steps,
  ...(failure ? { failure } : {}),
};
await mkdir(artifactDir, { recursive: true });
await writeFile(join(artifactDir, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(join(artifactDir, "summary.md"), renderMarkdown(report));
console.log(JSON.stringify({ ...report, artifactDir }, null, 2));

async function invoke(capabilityId: string, argumentsValue: Record<string, unknown>, useLease = false): Promise<unknown> {
  const response = await requestJson("POST", `${baseUrl}/invocations`, {
    capabilityId,
    arguments: argumentsValue,
    ...(useLease ? { leaseId } : {}),
  });
  if (response.error) throw new Error(`${capabilityId}: ${JSON.stringify(response.error)}`);
  const data = objectValue(response.data);
  assert.equal(data.status, "succeeded", `${capabilityId} did not succeed`);
  return data.result ?? null;
}

async function requestJson(method: string, url: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`${method} ${url} -> ${response.status}: ${text}`);
  return value;
}

async function startFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer(async (req, res) => {
    if (req.url === "/api/slow") {
      await sleep(500);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/download") {
      const body = "devspace-download-ok\n";
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-disposition": "attachment; filename=\"devspace-browser-control-e2e.txt\"",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url === "/frame") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><button aria-label="Frame Action" onclick="parent.document.title='frame-clicked'">Frame Action</button><input aria-label="Frame Input">`);
      return;
    }
    if (req.url === "/nav") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><title>Navigation Target</title><div id="ready">ready</div>`);
      return;
    }
    if (req.url !== "/") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>DevSpace Browser Control E2E</title>
      <input type="file" aria-label="Upload fixture">
      <input type="password" placeholder="Secure fixture input" oninput="document.title='secure-length:'+this.value.length">
      <div id="shadow-host"></div>
      <iframe id="frame-one" name="frame-one" src="/frame" style="width:500px;height:120px"></iframe>
      <script>
        const root=document.querySelector('#shadow-host').attachShadow({mode:'open'});
        root.innerHTML='<button aria-label="Shadow Action">Shadow Action</button><input aria-label="Shadow Input">';
        root.querySelector('button').onclick=()=>{document.title='shadow-clicked'};
        fetch('/api/slow').then(r=>r.text()).then(()=>window.slowDone=true);
      </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(hardTimer);
      if (error) reject(error); else resolve();
    };
    const forceTimer = setTimeout(() => server.closeAllConnections(), 1_000);
    const hardTimer = setTimeout(() => finish(), 5_000);
    server.close((error) => finish(error ?? undefined));
    server.closeIdleConnections();
  });
}

function requiredElement(elements: Array<Record<string, unknown>>, label: string): Record<string, unknown> {
  const value = elements.find((entry) => entry.label === label);
  assert.ok(value, `snapshot element not found: ${label}`);
  assert.ok(Number.isInteger(value.index), `snapshot element has no index: ${label}`);
  return value;
}

function objectValue(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

function objectArray(value: unknown): Array<Record<string, any>> {
  assert.ok(Array.isArray(value));
  return value.map(objectValue);
}

function pass(name: string): void {
  steps.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function renderMarkdown(reportValue: typeof report): string {
  const rows = reportValue.steps.map((step) => `| PASS | ${step} |`).join("\n");
  return `# Browser control real-profile smoke\n\n- Result: ${reportValue.ok ? "PASS" : "FAIL"}\n- Mode: ${reportValue.mode}\n- Base URL: ${reportValue.baseUrl}\n- Passed steps: ${reportValue.passed}\n${reportValue.failure ? `- Failure: ${reportValue.failure}\n` : ""}\n| Result | Step |\n| --- | --- |\n${rows}\n`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
