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
const downloads = [];
const port = {
  onMessage: { addListener(listener) { nativeMessageListener = listener; } },
  onDisconnect: { addListener() {} },
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
    connectNative() { return port; },
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
    async sendCommand() { return {}; },
    onEvent: { addListener(listener) { debuggerEventListener = listener; } },
  },
  downloads: {
    async download(options) { downloads.push(options); return 42; },
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
vm.runInNewContext(source, { chrome, console, Map, Set, Number, String, Error }, { filename: "background.js" });
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
await request("release_tab", { clientId: "devspace", tabId: 7 });
assert.equal(tabs.has(7), true);

const downloaded = await request("download", { clientId: "devspace", url: "https://example.test/file", filename: "file.txt" });
assert.equal(downloaded.result.downloadId, 42);
assert.equal(downloads[0].saveAs, false);

const opened = await request("open_tab", { clientId: "devspace", url: "https://fixture.test/" });
assert.equal(opened.result.ownership, "agent");
assert.equal(createdOptions.url, "https://fixture.test/");
assert.equal(createdOptions.active, false);
assert.deepEqual(sessionStorage.devspaceOwnedTabs.devspace.tabs, [8]);

// A Manifest V3 service-worker restart must retain the distinction between an
// Agent-created tab and an adopted user tab.
vm.runInNewContext(source, { chrome, console, Map, Set, Number, String, Error }, { filename: "background-restarted.js" });
const reacquired = await request("use_tab", { clientId: "devspace", tabId: 8 });
assert.equal(reacquired.result.ownership, "agent");
await request("close_tab", { clientId: "devspace", tabId: 8 });
assert.deepEqual(removed, [8]);
assert.equal(tabs.has(8), false);

assert.deepEqual(sessionStorage.devspaceOwnedTabs.devspace.tabs, []);
assert.equal(typeof tabRemovedListener, "function");

console.log("browser extension tests passed: adoption safety, persisted ownership, agent-tab cleanup");

function request(command, params) {
  return new Promise((resolve) => {
    responseWaiters.set(command, resolve);
    nativeMessageListener({ protocol: 1, id: command, command, params });
  });
}
