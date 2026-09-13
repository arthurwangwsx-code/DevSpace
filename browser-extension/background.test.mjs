import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const tabs = new Map([[7, { id: 7, windowId: 1, title: "User tab", url: "https://example.test/", active: true }]]);
let nativeMessageListener;
let createdOptions;
const removed = [];
const responseWaiters = new Map();
const sessionStorage = {};
const localStorage = {};
let tabRemovedListener;
let debuggerEventListener;
let nativeDisconnectListener;
let reconnectCallback;
let nativeConnectCount = 0;
const downloads = [];
let downloadState = "complete";
const debuggerCommands = [];
const port = {
  onMessage: { addListener(listener) { nativeMessageListener = listener; } },
  onDisconnect: { addListener(listener) { nativeDisconnectListener = listener; } },
  postMessage(message) {
    const resolve = responseWaiters.get(message.id);
    if (resolve) {
      responseWaiters.delete(message.id);
      resolve(message);
    }
  },
};
const chrome = {
  runtime: {
    connectNative() { nativeConnectCount += 1; return port; },
    getManifest() { return { version: "0.2.0" }; },
    lastError: undefined,
  },
  tabs: {
    async query() { return [...tabs.values()]; },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error(`unknown tab ${tabId}`);
      return tab;
    },
    async create(options) {
      createdOptions = options;
      const tab = { id: 8, windowId: 1, title: "", url: options.url, active: options.active };
      tabs.set(8, tab);
      return tab;
    },
    async remove(tabId) { removed.push(tabId); tabs.delete(tabId); },
    async update() {},
    async reload() {},
    onRemoved: { addListener(listener) { tabRemovedListener = listener; } },
  },
  debugger: {
    async attach() {},
    async detach() {},
    async sendCommand(_target, method, params = {}) {
      debuggerCommands.push({ method, params });
      if (method === "Runtime.evaluate") {
        if (params.returnByValue !== true && String(params.expression).includes("data-devspace-index")) {
          return { result: { objectId: "object-1" } };
        }
        return { result: { value: true, type: "boolean" } };
      }
      if (method === "DOM.describeNode") return { node: { backendNodeId: 99 } };
      if (method === "Performance.getMetrics") return { metrics: [{ name: "TaskDuration", value: 1.5 }] };
      if (method === "Page.getNavigationHistory") return { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      if (method === "Page.captureScreenshot") return { data: "ZmFrZQ==" };
      return {};
    },
    onEvent: { addListener(listener) { debuggerEventListener = listener; } },
  },
  downloads: {
    async download(options) { downloads.push(options); return 42; },
    async search({ id }) { return id === 42 ? [{ id: 42, state: downloadState, paused: false, filename: "/tmp/file.txt", url: "https://example.test/file", bytesReceived: 12, totalBytes: 12 }] : []; },
  },
  alarms: {
    create() {},
    onAlarm: { addListener() {} },
  },
  storage: {
    session: {
      async get(key) { return { [key]: sessionStorage[key] }; },
      async set(value) { Object.assign(sessionStorage, structuredClone(value)); },
    },
    local: {
      async get(key) { return { [key]: localStorage[key] }; },
      async set(value) { Object.assign(localStorage, structuredClone(value)); },
    },
  },
};

const source = await readFile(new URL("./background.js", import.meta.url), "utf8");
function createRuntimeGlobals() {
  return {
    chrome, console, Map, Set, Number, String, Error,
    setTimeout(callback) { reconnectCallback = callback; return 1; },
    clearTimeout() {},
  };
}
vm.runInNewContext(source, createRuntimeGlobals(), { filename: "background.js" });
assert.equal(typeof nativeMessageListener, "function");

const listed = await request("list_tabs", { clientId: "devspace", all: true });
assert.equal(listed.ok, true);
assert.equal(listed.result.tabs[0].ownership, "user");

const adopted = await request("use_tab", { clientId: "devspace", tabId: 7 });
assert.equal(adopted.result.ownership, "adopted");
debuggerEventListener({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "log", timestamp: 1, args: [{ value: "hello" }] });
debuggerEventListener({ tabId: 7 }, "Network.requestWillBeSent", {
  requestId: "req-1", type: "Fetch", timestamp: 2,
  request: { method: "GET", url: "https://example.test/api", headers: { Authorization: "secret", Accept: "application/json" } },
});
const consoleResult = await request("list_console", { clientId: "devspace", tabId: 7 });
assert.equal(consoleResult.result.messages[0].args[0], "hello");
const networkResult = await request("list_network", { clientId: "devspace", tabId: 7 });
assert.equal(networkResult.result.requests[0].headers.Authorization, "<redacted>");
assert.equal(networkResult.result.requests[0].headers.Accept, "application/json");
const uploaded = await request("set_input_files", { clientId: "devspace", tabId: 7, index: 0, files: ["/tmp/a.txt"] });
assert.equal(uploaded.result.files, 1);
const fileCommand = debuggerCommands.find(({ method }) => method === "DOM.setFileInputFiles");
assert.equal(fileCommand?.params.backendNodeId, 99);
assert.equal(fileCommand?.params.files[0], "/tmp/a.txt");
const perf = await request("performance", { clientId: "devspace", tabId: 7 });
assert.equal(perf.result.metrics[0].name, "TaskDuration");
await request("snapshot", { clientId: "devspace", tabId: 7 });
const snapshotCommand = debuggerCommands.find(({ method, params }) =>
  method === "Runtime.evaluate" && String(params.expression).includes("const secure = inputType === 'password'"));
assert.ok(snapshotCommand, "snapshot must identify password inputs as secure");
assert.match(snapshotCommand.params.expression, /\(secure \? '' : el\.value\)/);
assert.match(snapshotCommand.params.expression, /secure \? \{ secure: true \}/);
const shot = await request("screenshot", { clientId: "devspace", tabId: 7, format: "jpeg", quality: 75, fullPage: true });
assert.equal(shot.result.mimeType, "image/jpeg");
assert.equal(debuggerCommands.find(({ method }) => method === "Page.captureScreenshot")?.params.captureBeyondViewport, true);
await request("release_tab", { clientId: "devspace", tabId: 7 });
assert.equal(tabs.has(7), true);

const downloaded = await request("download", { clientId: "devspace", url: "https://example.test/file", filename: "file.txt" });
assert.equal(downloaded.result.downloadId, 42);
assert.equal(downloads[0].saveAs, false);
const downloadStatus = await request("download_status", { clientId: "devspace", downloadId: 42 });
assert.equal(downloadStatus.result.state, "complete");
const completed = await request("wait_download", { clientId: "devspace", downloadId: 42, timeoutMs: 100 });
assert.equal(completed.result.filename, "/tmp/file.txt");

const opened = await request("open_tab", { clientId: "devspace", url: "https://fixture.test/" });
assert.equal(opened.result.ownership, "agent");
assert.equal(createdOptions.url, "https://fixture.test/");
assert.equal(createdOptions.active, false);
assert.deepEqual(sessionStorage.devspaceOwnedTabs.devspace.tabs, [8]);

// A Manifest V3 service-worker restart must retain the distinction between an
// Agent-created tab and an adopted user tab.
vm.runInNewContext(source, createRuntimeGlobals(), { filename: "background-restarted.js" });
const reacquired = await request("use_tab", { clientId: "devspace", tabId: 8 });
assert.equal(reacquired.result.ownership, "agent");
await request("close_tab", { clientId: "devspace", tabId: 8 });
assert.deepEqual(removed, [8]);
assert.equal(tabs.has(8), false);

assert.deepEqual(sessionStorage.devspaceOwnedTabs.devspace.tabs, []);
assert.equal(typeof tabRemovedListener, "function");
assert.equal(nativeConnectCount, 2);
nativeDisconnectListener();
assert.equal(typeof reconnectCallback, "function");
reconnectCallback();
assert.equal(nativeConnectCount, 3);

console.log("browser extension tests passed: adoption safety, persisted ownership, agent-tab cleanup, reconnect");

function request(command, params) {
  return new Promise((resolve) => {
    responseWaiters.set(command, resolve);
    nativeMessageListener({ protocol: 1, id: command, command, params });
  });
}
