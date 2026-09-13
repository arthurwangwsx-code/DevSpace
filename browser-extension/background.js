const HOST = "com.devspace.browser_bridge";
const PROTOCOL = 1;
const clients = new Map();
const tabOwner = new Map();
const attached = new Set();
const consoleEvents = new Map();
const networkEvents = new Map();
const lastNetworkActivity = new Map();
const MAX_EVENT_BUFFER = 500;
let port = null;
let reconnectTimer = null;
let stateReady = null;
let profileIdPromise = null;

function ensureProfileId() {
  if (!profileIdPromise) profileIdPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get("devspaceProfileId");
      if (stored?.devspaceProfileId) return stored.devspaceProfileId;
      const id = globalThis.crypto?.randomUUID?.() || `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await chrome.storage.local.set({ devspaceProfileId: id });
      return id;
    } catch {
      return "profile-unknown";
    }
  })();
  return profileIdPromise;
}

async function profileMetadata() {
  let focused = false;
  try { focused = Boolean((await chrome.windows.getLastFocused())?.focused); } catch {}
  let tabCount = 0;
  try { tabCount = (await chrome.tabs.query({})).length; } catch {}
  return {
    profileId: await ensureProfileId(),
    extensionVersion: chrome.runtime.getManifest().version,
    incognito: Boolean(chrome.extension?.inIncognitoContext),
    focused,
    tabCount,
  };
}

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
  await Promise.allSettled([
    chrome.debugger.sendCommand({ tabId }, "Runtime.enable"),
    chrome.debugger.sendCommand({ tabId }, "Log.enable"),
    chrome.debugger.sendCommand({ tabId }, "Network.enable"),
    chrome.debugger.sendCommand({ tabId }, "Performance.enable"),
  ]);
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
  return { profileId: await ensureProfileId(), tabs: tabs.filter((tab) => all || tabOwner.get(tab.id) === clientId).map((tab) => ({
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
  const elements = [];
  const selector = 'a,button,input,textarea,select,[role=button],[role=link],[role=textbox],[role=combobox],[role=option],[role=menuitem],[contenteditable=true],summary';
  let index = 0;
  function absolutePoint(el) {
    let r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    let win = el.ownerDocument?.defaultView;
    try {
      while (win && win !== win.parent && win.frameElement) {
        const fr = win.frameElement.getBoundingClientRect(); x += fr.left; y += fr.top; win = win.parent;
      }
    } catch {}
    return { x: Math.round(x), y: Math.round(y) };
  }
  function visit(root, framePath = []) {
    if (!root || index >= 500) return;
    for (const el of root.querySelectorAll(selector)) {
      if (index >= 500) break;
      const r = el.getBoundingClientRect(), s = el.ownerDocument?.defaultView?.getComputedStyle(el) || getComputedStyle(el);
      if (r.width < 2 || r.height < 2 || s.display === 'none' || s.visibility === 'hidden') continue;
      const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      const point = absolutePoint(el);
      el.setAttribute('data-devspace-index', String(index));
      const isShadow = typeof ShadowRoot !== 'undefined' && el.getRootNode() instanceof ShadowRoot;
      elements.push({ index: index++, tag: el.tagName.toLowerCase(), label, x: point.x, y: point.y, ...(framePath.length ? { framePath } : {}), ...(isShadow ? { shadow: true } : {}) });
    }
    for (const el of root.querySelectorAll('*')) {
      if (index >= 500) break;
      if (el.shadowRoot) visit(el.shadowRoot, framePath);
      if (el.tagName === 'IFRAME') {
        try { if (el.contentDocument) visit(el.contentDocument, [...framePath, el.getAttribute('name') || el.id || 'iframe']); } catch {}
      }
    }
  }
  visit(document);
  return { title: document.title, url: location.href, elements };
})()`;
async function snapshot(tabId) {
  const value = await send(tabId, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text || "snapshot failed"); return value.result.value;
}
async function click(tabId, params) {
  let x = params.x, y = params.y;
  if (params.index !== undefined) {
    ({ x, y } = await elementPoint(tabId, params.index));
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("click requires index or x/y");
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  return { clicked: { x, y } };
}

async function elementPoint(tabId, index) {
  const expression = findElementExpression(index, `
    let r=e.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2, win=e.ownerDocument?.defaultView;
    try { while(win && win!==win.parent && win.frameElement){ const fr=win.frameElement.getBoundingClientRect(); x+=fr.left; y+=fr.top; win=win.parent; } } catch {}
    return {x,y};
  `);
  const point = await send(tabId, "Runtime.evaluate", { expression, returnByValue: true });
  if (!point.result.value) throw new Error(`snapshot element ${index} is unavailable`);
  return point.result.value;
}

async function evaluate(tabId, expression, awaitPromise = true) {
  const value = await send(tabId, "Runtime.evaluate", {
    expression: String(expression),
    awaitPromise: Boolean(awaitPromise),
    returnByValue: true,
    userGesture: true,
  });
  if (value.exceptionDetails) {
    throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text || "evaluation failed");
  }
  return { value: value.result?.value, type: value.result?.type, description: value.result?.description };
}

async function hover(tabId, params) {
  let x = params.x, y = params.y;
  if (params.index !== undefined) ({ x, y } = await elementPoint(tabId, params.index));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("hover requires index or x/y");
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y, button: "none", buttons: 0, pointerType: "mouse",
  });
  return { hovered: { x, y } };
}

async function scroll(tabId, p) {
  const x = Number(p.x || 0), y = Number(p.y || 0);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Number.isFinite(p.atX) ? p.atX : 1,
    y: Number.isFinite(p.atY) ? p.atY : 1,
    deltaX: x,
    deltaY: y,
  });
  return { scrolled: { x, y } };
}

async function selectOption(tabId, index, value) {
  const script = findElementExpression(index, `
    if(e.tagName !== 'SELECT') return {ok:false};
    e.value=${JSON.stringify(String(value))};
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    return {ok:true,value:e.value};
  `);
  const result = await evaluate(tabId, script, false);
  if (!result.value?.ok) throw new Error(`snapshot element ${index} is not a selectable <select>`);
  return result.value;
}

async function setInputFiles(tabId, index, files) {
  const expression = findElementExpression(index, "return e;");
  const evaluated = await send(tabId, "Runtime.evaluate", { expression });
  if (!evaluated.result?.objectId) throw new Error(`snapshot element ${index} is unavailable`);
  const described = await send(tabId, "DOM.describeNode", { objectId: evaluated.result.objectId });
  const backendNodeId = described.node?.backendNodeId;
  if (!backendNodeId) throw new Error(`snapshot element ${index} cannot be resolved to a DOM node`);
  await send(tabId, "DOM.setFileInputFiles", { backendNodeId, files: files.map(String) });
  return { files: files.length };
}

function findElementExpression(index, body) {
  return `(() => {
    const wanted=${JSON.stringify(String(Number(index)))};
    function find(root){
      if(!root)return null;
      for(const el of root.querySelectorAll('*')){
        if(el.getAttribute && el.getAttribute('data-devspace-index')===wanted)return el;
        if(el.shadowRoot){const found=find(el.shadowRoot);if(found)return found;}
        if(el.tagName==='IFRAME'){try{const found=find(el.contentDocument);if(found)return found;}catch{}}
      }
      return null;
    }
    const e=find(document); if(!e)return null;
    ${body}
  })()`;
}

async function waitFor(tabId, p) {
  const timeoutMs = Math.min(Math.max(Number(p.timeoutMs || 5000), 0), 30000);
  const intervalMs = Math.min(Math.max(Number(p.intervalMs || 100), 25), 1000);
  const deadline = Date.now() + timeoutMs;
  if (p.networkIdleMs !== undefined) await attach(tabId);
  for (;;) {
    let matched = false;
    let condition = "load";
    if (p.urlEquals !== undefined || p.urlContains !== undefined) {
      const tab = await chrome.tabs.get(tabId);
      const url = tab.url || "";
      matched = p.urlEquals !== undefined
        ? url === String(p.urlEquals)
        : url.includes(String(p.urlContains));
      condition = "url";
    } else if (p.networkIdleMs !== undefined) {
      const idleMs = Math.min(Math.max(Number(p.networkIdleMs || 500), 0), 30000);
      const last = lastNetworkActivity.get(tabId) || 0;
      matched = Date.now() - last >= idleMs;
      condition = "network_idle";
    } else {
      const script = p.selector
        ? `Boolean(document.querySelector(${JSON.stringify(String(p.selector))}))`
        : p.text
          ? `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(String(p.text))}))`
          : "document.readyState === 'complete'";
      const result = await evaluate(tabId, script, false);
      matched = result.value === true;
      condition = p.selector ? "selector" : p.text ? "text" : "load";
    }
    if (matched) return { matched: true, condition };
    if (Date.now() >= deadline) throw new Error("wait condition timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function downloadStatus(downloadId) {
  const items = await chrome.downloads.search({ id: Number(downloadId) });
  const item = items?.[0];
  if (!item) throw new Error(`download ${downloadId} was not found`);
  return {
    downloadId: item.id,
    state: item.state,
    paused: Boolean(item.paused),
    filename: item.filename,
    url: item.url,
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    error: item.error,
  };
}

async function waitDownload(downloadId, timeoutMs = 30000, intervalMs = 100) {
  const timeout = Math.min(Math.max(Number(timeoutMs || 30000), 0), 120000);
  const interval = Math.min(Math.max(Number(intervalMs || 100), 25), 1000);
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await downloadStatus(downloadId);
    if (value.state === "complete") return value;
    if (value.state === "interrupted") throw new Error(`download ${downloadId} was interrupted${value.error ? `: ${value.error}` : ""}`);
    if (Date.now() >= deadline) throw new Error(`download ${downloadId} timed out`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function pushBounded(map, tabId, entry) {
  let values = map.get(tabId);
  if (!values) { values = []; map.set(tabId, values); }
  values.push(entry);
  if (values.length > MAX_EVENT_BUFFER) values.splice(0, values.length - MAX_EVENT_BUFFER);
}

function sanitizeNetworkHeaders(headers) {
  if (!headers || typeof headers !== "object") return undefined;
  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = /^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(key) ? "<redacted>" : value;
  }
  return out;
}

function onDebuggerEvent(source, method, params) {
  const tabId = source?.tabId;
  if (!Number.isInteger(tabId)) return;
  if (method === "Runtime.consoleAPICalled") {
    pushBounded(consoleEvents, tabId, {
      source: "console", type: params.type, timestamp: params.timestamp,
      args: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type),
    });
  } else if (method === "Log.entryAdded") {
    const entry = params.entry || {};
    pushBounded(consoleEvents, tabId, {
      source: "log", level: entry.level, text: entry.text, url: entry.url, timestamp: entry.timestamp,
    });
  } else if (method === "Network.requestWillBeSent") {
    lastNetworkActivity.set(tabId, Date.now());
    const request = params.request || {};
    pushBounded(networkEvents, tabId, {
      phase: "request", requestId: params.requestId, method: request.method, url: request.url,
      type: params.type, timestamp: params.timestamp, headers: sanitizeNetworkHeaders(request.headers),
    });
  } else if (method === "Network.responseReceived") {
    lastNetworkActivity.set(tabId, Date.now());
    const response = params.response || {};
    pushBounded(networkEvents, tabId, {
      phase: "response", requestId: params.requestId, url: response.url, status: response.status,
      statusText: response.statusText, mimeType: response.mimeType, type: params.type,
      timestamp: params.timestamp, fromDiskCache: response.fromDiskCache, fromServiceWorker: response.fromServiceWorker,
    });
  }
}

if (chrome.debugger.onEvent?.addListener) chrome.debugger.onEvent.addListener(onDebuggerEvent);

const handlers = {
  hello: async () => {
    const manifest = chrome.runtime.getManifest();
    return {
      protocol: PROTOCOL,
      extensionVersion: manifest.version,
      profileId: await ensureProfileId(),
      incognito: Boolean(chrome.extension?.inIncognitoContext),
      permissions: manifest.permissions || [],
      hostPermissions: manifest.host_permissions || [],
    };
  },
  list_tabs: async (p) => listTabs(p.clientId, p.all === true), use_tab: async (p) => useTab(p.clientId, p.tabId),
  release_tab: async (p) => releaseTab(p.clientId, p.tabId), close_tab: async (p) => closeTab(p.clientId, p.tabId),
  open_tab: async (p) => openTab(p.clientId, p.url),
  snapshot: async (p) => { assertOwned(p.clientId, p.tabId); return snapshot(p.tabId); },
  navigate: async (p) => { assertOwned(p.clientId, p.tabId); await chrome.tabs.update(p.tabId, { url: p.url }); return { tabId: p.tabId, url: p.url }; },
  reload: async (p) => { assertOwned(p.clientId, p.tabId); await chrome.tabs.reload(p.tabId, { bypassCache: Boolean(p.bypassCache) }); return { tabId: p.tabId, reloaded: true }; },
  go_back: async (p) => {
    assertOwned(p.clientId, p.tabId);
    const history = await send(p.tabId, "Page.getNavigationHistory");
    if (history.currentIndex > 0) await send(p.tabId, "Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex - 1].id });
    return { tabId: p.tabId, moved: history.currentIndex > 0 };
  },
  go_forward: async (p) => {
    assertOwned(p.clientId, p.tabId);
    const history = await send(p.tabId, "Page.getNavigationHistory");
    if (history.currentIndex + 1 < history.entries.length) await send(p.tabId, "Page.navigateToHistoryEntry", { entryId: history.entries[history.currentIndex + 1].id });
    return { tabId: p.tabId, moved: history.currentIndex + 1 < history.entries.length };
  },
  activate_tab: async (p) => { assertOwned(p.clientId, p.tabId); await chrome.tabs.update(p.tabId, { active: true }); return { tabId: p.tabId, active: true }; },
  click: async (p) => { assertOwned(p.clientId, p.tabId); return click(p.tabId, p); },
  hover: async (p) => { assertOwned(p.clientId, p.tabId); return hover(p.tabId, p); },
  scroll: async (p) => { assertOwned(p.clientId, p.tabId); return scroll(p.tabId, p); },
  select_option: async (p) => { assertOwned(p.clientId, p.tabId); return selectOption(p.tabId, p.index, p.value); },
  set_input_files: async (p) => { assertOwned(p.clientId, p.tabId); return setInputFiles(p.tabId, p.index, p.files || []); },
  type: async (p) => { assertOwned(p.clientId, p.tabId); await send(p.tabId, "Input.insertText", { text: p.text }); return { typed: String(p.text).length }; },
  press: async (p) => { assertOwned(p.clientId, p.tabId); await send(p.tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: p.key }); await send(p.tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: p.key }); return { key: p.key }; },
  screenshot: async (p) => {
    assertOwned(p.clientId, p.tabId);
    const format = p.format === "jpeg" ? "jpeg" : "png";
    const options = { format, captureBeyondViewport: p.fullPage === true };
    if (format === "jpeg") options.quality = Math.min(Math.max(Number(p.quality || 85), 1), 100);
    const r = await send(p.tabId, "Page.captureScreenshot", options);
    return { data: r.data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" };
  },
  evaluate: async (p) => { assertOwned(p.clientId, p.tabId); return evaluate(p.tabId, p.expression, p.awaitPromise !== false); },
  get_html: async (p) => { assertOwned(p.clientId, p.tabId); const r = await evaluate(p.tabId, "document.documentElement.outerHTML", false); return { html: r.value || "" }; },
  wait_for: async (p) => { assertOwned(p.clientId, p.tabId); return waitFor(p.tabId, p); },
  list_console: async (p) => { assertOwned(p.clientId, p.tabId); await attach(p.tabId); return { messages: [...(consoleEvents.get(p.tabId) || [])].slice(-Math.min(Math.max(Number(p.limit || 100), 1), 500)) }; },
  list_network: async (p) => { assertOwned(p.clientId, p.tabId); await attach(p.tabId); return { requests: [...(networkEvents.get(p.tabId) || [])].slice(-Math.min(Math.max(Number(p.limit || 100), 1), 500)) }; },
  performance: async (p) => { assertOwned(p.clientId, p.tabId); const r = await send(p.tabId, "Performance.getMetrics"); return { metrics: r.metrics || [] }; },
  download: async (p) => {
    const downloadId = await chrome.downloads.download({
      url: String(p.url),
      filename: p.filename ? String(p.filename) : undefined,
      saveAs: Boolean(p.saveAs),
    });
    return { downloadId };
  },
  download_status: async (p) => downloadStatus(p.downloadId),
  wait_download: async (p) => waitDownload(p.downloadId, p.timeoutMs, p.intervalMs),
};
async function handle(message, replyPort) {
  await ensureStateReady();
  const { id, protocol, command, params = {} } = message || {};
  if (protocol !== PROTOCOL) return replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: `unsupported protocol: ${protocol}` });
  const handler = handlers[command]; if (!handler) return replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: `unknown command: ${command}` });
  try { replyPort.postMessage({ protocol: PROTOCOL, id, ok: true, result: await handler(params) }); }
  catch (error) { replyPort.postMessage({ protocol: PROTOCOL, id, ok: false, error: error?.message || String(error) }); }
}
async function connect() {
  if (port) return; try { port = chrome.runtime.connectNative(HOST); } catch { port = null; return; }
  const current = port; current.onMessage.addListener((message) => void handle(message, current));
  current.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (port === current) port = null;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 1_000);
  });
  try { current.postMessage({ protocol: PROTOCOL, event: "profile_hello", profile: await profileMetadata() }); } catch {}
}
chrome.tabs.onRemoved.addListener((tabId) => {
  const clientId = tabOwner.get(tabId);
  if (clientId) {
    state(clientId).tabs.delete(tabId); state(clientId).adopted.delete(tabId); tabOwner.delete(tabId);
    void persistState();
  }
  attached.delete(tabId);
  consoleEvents.delete(tabId);
  networkEvents.delete(tabId);
  lastNetworkActivity.delete(tabId);
});
chrome.alarms.create("devspace-reconnect", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "devspace-reconnect") void connect(); });
// Establish Native Messaging immediately. Commands still await restored
// ownership state in handle(), so reconnect does not need to wait for storage
// I/O before Chrome can attach the native port.
void connect();
void ensureStateReady();
