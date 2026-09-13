const HOST = "com.devspace.browser_bridge";
const PROTOCOL = 1;
const clients = new Map();
const tabOwner = new Map();
const attached = new Set();
let port = null;
let stateReady = null;

async function persistState() {
  const serialized = {};
  for (const [clientId, value] of clients) {
    serialized[clientId] = { tabs: [...value.tabs], adopted: [...value.adopted] };
  }
  try { await chrome.storage.session.set({ devspaceOwnedTabs: serialized }); } catch {}
}

async function restoreState() {
  try {
    const stored = (await chrome.storage.session.get("devspaceOwnedTabs"))?.devspaceOwnedTabs || {};
    for (const [clientId, value] of Object.entries(stored)) {
      if (!value || typeof value !== "object") continue;
      const owned = state(clientId);
      for (const tabId of Array.isArray(value.tabs) ? value.tabs : []) {
        if (!Number.isInteger(tabId)) continue;
        try { await chrome.tabs.get(tabId); owned.tabs.add(tabId); tabOwner.set(tabId, clientId); } catch {}
      }
      for (const tabId of Array.isArray(value.adopted) ? value.adopted : []) {
        if (owned.tabs.has(tabId)) owned.adopted.add(tabId);
      }
    }
  } catch {}
}

function ensureStateReady() {
  if (!stateReady) stateReady = restoreState();
  return stateReady;
}

function state(clientId) {
  if (!clientId) throw new Error("clientId is required");
  let value = clients.get(clientId);
  if (!value) { value = { tabs: new Set(), adopted: new Set() }; clients.set(clientId, value); }
  return value;
}
function assertOwned(clientId, tabId) {
  if (tabOwner.get(tabId) !== clientId) throw new Error(`tab ${tabId} is not acquired by this client`);
}
async function attach(tabId) {
  if (attached.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3"); attached.add(tabId);
}
async function detach(tabId) {
  if (!attached.delete(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch {}
}
async function send(tabId, method, params = {}) {
  await attach(tabId); return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function listTabs(clientId, all) {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.filter((tab) => all || tabOwner.get(tab.id) === clientId).map((tab) => ({
    tabId: tab.id, windowId: tab.windowId, title: tab.title || "", url: tab.url || "", active: Boolean(tab.active),
    ownership: tabOwner.get(tab.id) === clientId ? (state(clientId).adopted.has(tab.id) ? "adopted" : "agent") : "user",
  })) };
}
async function useTab(clientId, tabId) {
  if (tabOwner.has(tabId) && tabOwner.get(tabId) !== clientId) throw new Error(`tab ${tabId} is owned by another client`);
  await chrome.tabs.get(tabId);
  const owned = state(clientId);
  if (tabOwner.get(tabId) === clientId) {
    return { tabId, ownership: owned.adopted.has(tabId) ? "adopted" : "agent" };
  }
  owned.tabs.add(tabId); owned.adopted.add(tabId); tabOwner.set(tabId, clientId);
  await persistState();
  return { tabId, ownership: "adopted" };
}
async function releaseTab(clientId, tabId) {
  assertOwned(clientId, tabId); await detach(tabId);
  const owned = state(clientId); owned.tabs.delete(tabId); owned.adopted.delete(tabId); tabOwner.delete(tabId);
  await persistState();
  return { tabId, released: true };
}
async function closeTab(clientId, tabId) {
  assertOwned(clientId, tabId);
  if (state(clientId).adopted.has(tabId)) throw new Error(`adopted tab ${tabId} cannot be closed by lease cleanup`);
  await detach(tabId);
  await chrome.tabs.remove(tabId);
  const owned = state(clientId); owned.tabs.delete(tabId); owned.adopted.delete(tabId); tabOwner.delete(tabId);
  await persistState();
  return { tabId, closed: true };
}
async function openTab(clientId, url = "about:blank") {
  const tab = await chrome.tabs.create({ url, active: false });
  if (tab.id === undefined) throw new Error("Chrome did not return a tab id");
  state(clientId).tabs.add(tab.id); tabOwner.set(tab.id, clientId);
  await persistState();
  return { tabId: tab.id, windowId: tab.windowId, ownership: "agent" };
}

const SNAPSHOT_JS = `(() => {
  const elements = []; const selector = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=option],[role=menuitem],[contenteditable=true],summary'; let index = 0;
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width < 2 || r.height < 2 || s.display === 'none' || s.visibility === 'hidden') continue;
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    el.setAttribute('data-devspace-index', String(index)); elements.push({ index: index++, tag: el.tagName.toLowerCase(), label, x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
    if (index >= 300) break;
  }
  return { title: document.title, url: location.href, elements };
})()`;
async function snapshot(tabId) {
  const value = await send(tabId, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text || "snapshot failed"); return value.result.value;
}
async function click(tabId, params) {
  let x = params.x, y = params.y;
  if (params.index !== undefined) {
    const expression = `(() => { const e=document.querySelector('[data-devspace-index="${Number(params.index)}"]'); if(!e)return null; const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`;
    const point = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true });
    if (!point.result.value) throw new Error(`snapshot element ${params.index} is unavailable`); ({ x, y } = point.result.value);
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires index or x/y");
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  return { clicked: { x, y } };
}

const handlers = {
  hello: async () => ({ protocol: PROTOCOL, extensionVersion: chrome.runtime.getManifest().version }),
  list_tabs: async (p) => listTabs(p.clientId, p.all === true), use_tab: async (p) => useTab(p.clientId, p.tabId),
  release_tab: async (p) => releaseTab(p.clientId, p.tabId), close_tab: async (p) => closeTab(p.clientId, p.tabId),
  open_tab: async (p) => openTab(p.clientId, p.url),
  snapshot: async (p) => { assertOwned(p.clientId, p.tabId); return snapshot(p.tabId); },
  navigate: async (p) => { assertOwned(p.clientId, p.tabId); await chrome.tabs.update(p.tabId, { url: p.url }); return { tabId: p.tabId, url: p.url }; },
  click: async (p) => { assertOwned(p.clientId, p.tabId); return click(p.tabId, p); },
  type: async (p) => { assertOwned(p.clientId, p.tabId); await send(p.tabId, "Input.insertText", { text: p.text }); return { typed: String(p.text).length }; },
  press: async (p) => { assertOwned(p.clientId, p.tabId); await send(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: p.key }); await send(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key }); return { key: p.key }; },
  screenshot: async (p) => { assertOwned(p.clientId, p.tabId); const r = await send(p.tabId, "Page.captureScreenshot", { format: "png" }); return { data: r.data, mimeType: "image/png" }; },
};
async function handle(message, replyPort) {
  await ensureStateReady();
  const { id, protocol, command, params = {} } = message || {};
  if (protocol !== PROTOCOL) return replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: `unsupported protocol: ${protocol}` });
  const handler = handlers[command]; if (!handler) return replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: `unknown command: ${command}` });
  try { replyPort.postMessage({ protocol: PROTOCOL, id, ok: true, result: await handler(params) }); }
  catch (error) { replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: error?.message || String(error) }); }
}
function connect() {
  if (port) return; try { port = chrome.runtime.connectNative(HOST); } catch { port = null; return; }
  const current = port; current.onMessage.addListener((message) => void handle(message, current));
  current.onDisconnect.addListener(() => { void chrome.runtime.lastError; if (port === current) port = null; });
}
chrome.tabs.onRemoved.addListener((tabId) => {
  const clientId = tabOwner.get(tabId);
  if (clientId) {
    state(clientId).tabs.delete(tabId); state(clientId).adopted.delete(tabId); tabOwner.delete(tabId);
    void persistState();
  }
  attached.delete(tabId);
});
chrome.alarms.create("devspace-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "devspace-reconnect") connect(); });
// Establish Native Messaging immediately. Commands still await restored
// ownership state in handle(), so reconnect does not need to wait for storage
// I/O before Chrome can attach the native port.
connect();
void ensureStateReady();
