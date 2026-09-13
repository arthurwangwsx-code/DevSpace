import { randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Server } from "node:http";
import {
  generateOwnerToken,
  loadDevspaceFiles,
  writeDevspaceAuth,
  writeDevspaceConfig,
  type DevspaceTunnelConfig,
  type DevspaceUserConfig,
} from "./user-config.js";

export interface ControlCenterOptions {
  host?: string;
  port?: number;
  token?: string;
  openBrowser?: boolean;
}

export interface RunningControlCenter {
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function startControlCenter(options: ControlCenterOptions = {}): Promise<RunningControlCenter> {
  const host = options.host ?? "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("DevSpace Control Center only listens on loopback addresses.");
  }
  const port = options.port ?? 7680;
  const token = options.token ?? process.env.DEVSPACE_CONTROL_TOKEN ?? randomBytes(24).toString("base64url");
  ensureLocalAuth();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_request, response) => {
    response.type("html").send(controlCenterHtml());
  });

  app.use("/api", (request, response, next) => {
    const auth = request.header("authorization");
    const queryToken = typeof request.query.token === "string" ? request.query.token : undefined;
    if (auth === `Bearer ${token}` || queryToken === token) return next();
    response.status(401).json({ ok: false, error: "unauthorized" });
  });

  app.get("/api/config", (_request, response) => {
    const files = loadDevspaceFiles();
    response.json({ ok: true, config: files.config, configPath: files.configPath });
  });

  app.put("/api/config", (request, response) => {
    try {
      const config = normalizeControlCenterConfig(request.body);
      const path = writeDevspaceConfig(config);
      response.json({ ok: true, config, path, restartRequired: true });
    } catch (error) {
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/status", async (_request, response) => {
    const files = loadDevspaceFiles();
    const hostValue = files.config.host ?? "127.0.0.1";
    const portValue = files.config.port ?? 7676;
    const healthUrl = `http://${hostValue}:${portValue}/healthz`;
    const service = serviceIdentity(portValue);
    response.json({
      ok: true,
      configExists: files.configExists,
      authExists: files.authExists,
      health: await probeJson(healthUrl),
      tunnel: {
        configured: Boolean(files.config.tunnel?.command),
        enabled: files.config.tunnel?.enabled === true,
        autoStart: files.config.tunnel?.autoStart !== false,
        publicBaseUrl: files.config.tunnel?.publicBaseUrl ?? files.config.publicBaseUrl ?? null,
      },
      service: {
        label: service.label,
        plistPath: service.plistPath,
        startAtLogin: existsSync(service.plistPath),
      },
      platform: process.platform,
      arch: process.arch,
      node: process.version,
    });
  });

  app.post("/api/actions/:action", async (request, response) => {
    try {
      const result = await runControlAction(request.params.action, request.body ?? {});
      response.json({ ok: true, result });
    } catch (error) {
      response.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const server = await new Promise<Server>((resolveServer, reject) => {
    const running = app.listen(port, host, () => resolveServer(running));
    running.once("error", reject);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host === "::1" ? "[::1]" : host}:${actualPort}/?token=${encodeURIComponent(token)}`;
  if (options.openBrowser !== false && process.platform === "darwin") {
    spawn("/usr/bin/open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  return {
    url,
    token,
    server,
    close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

function ensureLocalAuth(): void {
  const files = loadDevspaceFiles();
  if (files.auth.ownerToken) return;
  writeDevspaceAuth({ ownerToken: generateOwnerToken() });
}

function normalizeControlCenterConfig(value: unknown): DevspaceUserConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be a JSON object.");
  const input = value as Record<string, unknown>;
  const current = loadDevspaceFiles().config;
  const roots = Array.isArray(input.allowedRoots)
    ? input.allowedRoots.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => resolve(entry.trim()))
    : current.allowedRoots;
  const port = input.port === undefined ? current.port : Number(input.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Port must be between 1 and 65535.");
  const publicBaseUrl = normalizeOptionalUrl(input.publicBaseUrl, "publicBaseUrl");
  const tunnel = normalizeTunnelConfig(input.tunnel, current.tunnel);
  return {
    ...current,
    host: typeof input.host === "string" && input.host.trim() ? input.host.trim() : current.host ?? "127.0.0.1",
    port,
    allowedRoots: roots,
    publicBaseUrl: publicBaseUrl === undefined ? current.publicBaseUrl : publicBaseUrl,
    subagents: typeof input.subagents === "boolean" ? input.subagents : current.subagents,
    tunnel,
  };
}

function normalizeTunnelConfig(value: unknown, current: DevspaceTunnelConfig | undefined): DevspaceTunnelConfig | undefined {
  if (value === undefined) return current;
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("tunnel must be an object or null.");
  const input = value as Record<string, unknown>;
  const args = input.args === undefined
    ? current?.args
    : Array.isArray(input.args)
      ? input.args.filter((entry): entry is string => typeof entry === "string")
      : (() => { throw new Error("tunnel.args must be an array of strings."); })();
  const environment = input.environment === undefined
    ? current?.environment
    : normalizeStringRecord(input.environment, "tunnel.environment");
  return {
    enabled: bool(input.enabled, current?.enabled ?? false),
    autoStart: bool(input.autoStart, current?.autoStart ?? true),
    command: stringOrUndefined(input.command, current?.command),
    args,
    cwd: stringOrUndefined(input.cwd, current?.cwd),
    publicBaseUrl: normalizeOptionalUrl(input.publicBaseUrl, "tunnel.publicBaseUrl") ?? current?.publicBaseUrl ?? null,
    restartOnExit: bool(input.restartOnExit, current?.restartOnExit ?? true),
    environment,
  };
}

function normalizeStringRecord(value: unknown, name: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, entry]) => typeof entry === "string")) throw new Error(`${name} values must be strings.`);
  return Object.fromEntries(entries) as Record<string, string>;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOrUndefined(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Expected a string value.");
  return value.trim() || undefined;
}

function normalizeOptionalUrl(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a URL string or null.`);
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${name} must use http or https.`);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

async function runControlAction(action: string, body: Record<string, unknown>): Promise<unknown> {
  const node = process.execPath;
  switch (action) {
    case "browser.installHost":
      return runCommand(node, [join(packageRoot, "native-host", "install.mjs")]);
    case "browser.doctor":
      return runCommand(node, [join(packageRoot, "scripts", "doctor-browser-extension.mjs")]);
    case "browser.openExtensions":
      if (process.platform !== "darwin") throw new Error("Opening Chrome extensions is currently implemented for macOS only.");
      return runCommand("/usr/bin/open", ["-a", "Google Chrome", "chrome://extensions"]);
    case "desktop.install":
      if (process.platform !== "darwin") throw new Error("Desktop Host installation requires macOS.");
      {
        const bundledDesktopHost = resolve(packageRoot, "..", "DevSpaceDesktopHost.app");
        if (existsSync(bundledDesktopHost)) {
          return runCommand("/bin/sh", [join(packageRoot, "scripts", "install-desktop-host.sh"), bundledDesktopHost]);
        }
        return runCommand("/bin/sh", [join(packageRoot, "scripts", "build-desktop-host.sh")], {
          DEVSPACE_DESKTOP_SIGNING_IDENTITY: typeof body.signingIdentity === "string" ? body.signingIdentity : process.env.DEVSPACE_DESKTOP_SIGNING_IDENTITY ?? "-",
        }).then(async (build) => ({ build, install: await runCommand("/bin/sh", [join(packageRoot, "scripts", "install-desktop-host.sh")]) }));
      }
    case "desktop.permissions":
      return runCommand(node, [join(packageRoot, "scripts", "doctor-desktop-host.mjs"), "--request-permissions"]);
    case "desktop.doctor":
      return runCommand(node, [join(packageRoot, "scripts", "doctor-desktop-host.mjs")]);
    case "service.install": {
      const args = [
        join(packageRoot, "scripts", "macos", "install-service.mjs"),
        "--node", process.execPath,
        "--devspace-bin", join(packageRoot, "dist", "cli.js"),
      ];
      if (body.activate === true) args.push("--activate");
      return runCommand(node, args);
    }
    case "service.start":
    case "service.restart": {
      if (process.platform !== "darwin") throw new Error("DevSpace login service requires macOS.");
      return runCommand(node, [
        join(packageRoot, "scripts", "macos", "install-service.mjs"),
        "--node", process.execPath,
        "--devspace-bin", join(packageRoot, "dist", "cli.js"),
        "--activate",
      ]);
    }
    case "service.stop": {
      if (process.platform !== "darwin") throw new Error("DevSpace login service requires macOS.");
      const files = loadDevspaceFiles();
      const identity = serviceIdentity(files.config.port ?? 7676);
      return runCommand("/bin/launchctl", ["bootout", `gui/${identity.uid}/${identity.label}`]);
    }
    case "service.disableLogin": {
      if (process.platform !== "darwin") throw new Error("DevSpace login service requires macOS.");
      const files = loadDevspaceFiles();
      const identity = serviceIdentity(files.config.port ?? 7676);
      const stopped = await runCommand("/bin/launchctl", ["bootout", `gui/${identity.uid}/${identity.label}`]);
      if (existsSync(identity.plistPath)) rmSync(identity.plistPath);
      return { stopped, removed: identity.plistPath };
    }
    case "service.doctor":
      return runCommand(node, [join(packageRoot, "scripts", "macos", "doctor-service.mjs")]);
    default:
      throw new Error(`Unknown Control Center action: ${action}`);
  }
}

function serviceIdentity(port: number): { uid: number; label: string; plistPath: string } {
  const uid = process.getuid?.() ?? Number(process.env.UID ?? 0);
  const label = `com.devspace.${uid}.${port}`;
  return { uid, label, plistPath: join(homedir(), "Library", "LaunchAgents", `${label}.plist`) };
}

async function runCommand(command: string, args: string[], env?: Record<string, string>): Promise<{ command: string; code: number; stdout: string; stderr: string }> {
  if (!existsSync(command) && command.startsWith("/")) throw new Error(`Executable does not exist: ${command}`);
  return new Promise((resolveCommand, reject) => {
    execFile(command, args, { cwd: packageRoot, env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code !== "number") return reject(error);
      resolveCommand({ command: [command, ...args].join(" "), code: typeof (error as { code?: unknown } | null)?.code === "number" ? Number((error as { code: number }).code) : 0, stdout, stderr });
    });
  });
}

async function probeJson(url: string): Promise<{ ok: boolean; status?: number; body?: unknown; error?: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function controlCenterHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DevSpace</title><style>
  :root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,sans-serif;color:#16181c;background:#f4f5f7}*{box-sizing:border-box}body{margin:0}.shell{display:grid;grid-template-columns:236px 1fr;min-height:100vh}.sidebar{background:linear-gradient(180deg,#17191e,#111318);color:#fff;padding:26px 16px;display:flex;flex-direction:column}.brand{font-size:21px;font-weight:750;letter-spacing:-.3px;padding:0 10px;margin-bottom:4px}.brandSub{font-size:11px;color:#8f98a6;padding:0 10px;margin-bottom:26px}.nav{display:grid;gap:6px}.nav button{border:0;background:transparent;color:#aeb5c0;text-align:left;padding:10px 12px;border-radius:9px;font-size:14px;font-weight:560}.nav button.active,.nav button:hover{background:#292d35;color:#fff}.sideStatus{margin-top:auto;border-top:1px solid #292d35;padding:16px 10px 0;font-size:12px;color:#aeb5c0}.main{padding:36px;max-width:1160px;width:100%}.page{display:none}.page.active{display:block}h1{font-size:29px;letter-spacing:-.5px;margin:0 0 6px}.sub{color:#69717d;margin-bottom:25px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{background:#fff;border:1px solid #e1e4e8;border-radius:16px;padding:19px;box-shadow:0 2px 8px #00000008}.card h2{font-size:15px;margin:0 0 14px}.card p.help{font-size:12px;color:#737b86;line-height:1.5;margin:0 0 12px}.row{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:9px 0;border-bottom:1px solid #f0f1f3}.row:last-child{border-bottom:0}.pill{padding:4px 9px;border-radius:999px;font-size:11px;font-weight:650;background:#eef1f4}.ok{background:#e7f7ec;color:#176b35}.bad{background:#fdebec;color:#a52b35}.warn{background:#fff5d6;color:#795c00}label{display:block;font-size:12px;font-weight:650;color:#4a515b;margin:12px 0 6px}input,textarea{width:100%;border:1px solid #d5dae1;border-radius:9px;padding:9px 10px;font:inherit;background:#fff;outline:none}input:focus,textarea:focus{border-color:#77a9f7;box-shadow:0 0 0 3px #1f6feb18}textarea{min-height:88px;resize:vertical}.toggle{width:auto}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}button.action{border:1px solid #cfd4dc;background:#fff;padding:8px 12px;border-radius:9px;font-weight:650;cursor:pointer}button.action:hover{background:#f6f8fa}button.action:disabled{opacity:.55;cursor:default}button.primary{background:#1f6feb;color:#fff;border-color:#1f6feb}button.danger{color:#b42318}.result{white-space:pre-wrap;background:#11151a;color:#dce2ea;border-radius:10px;padding:12px;max-height:280px;overflow:auto;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:12px}.hidden{display:none}.statusdot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#9aa2ad;margin-right:7px}.statusdot.on{background:#2da44e}@media(max-width:760px){.shell{grid-template-columns:1fr}.sidebar{padding:15px}.brandSub,.sideStatus{display:none}.nav{grid-template-columns:repeat(4,1fr)}.main{padding:20px}}
  </style></head><body><div class="shell"><aside class="sidebar"><div class="brand">DevSpace</div><div class="brandSub">Agent control plane</div><div class="nav"><button data-page="overview" class="active">Overview</button><button data-page="settings">Settings</button><button data-page="browser">Browser</button><button data-page="desktop">Computer Use</button></div><div id="sideStatus" class="sideStatus">Checking service…</div></aside><main class="main">
  <section id="overview" class="page active"><h1>Control Center</h1><div class="sub">Run, configure and diagnose the whole DevSpace stack from one place.</div><div class="grid"><div class="card"><h2>Core service</h2><div id="coreStatus">Loading…</div><div class="actions"><button class="action primary" data-action="service.start">Start</button><button class="action" data-action="service.restart">Restart</button><button class="action danger" data-action="service.stop">Stop</button><button class="action" data-action="service.doctor">Doctor</button></div></div><div class="card"><h2>Tunnel</h2><div id="tunnelStatus">Loading…</div><div class="actions"><button class="action" data-goto="settings">Configure tunnel</button></div></div></div><div id="globalResult" class="result hidden"></div></section>
  <section id="settings" class="page"><h1>Settings</h1><div class="sub">The App and CLI share the same configuration and service lifecycle.</div><div class="grid"><div class="card"><h2>Workspace & Core</h2><p class="help">Only these roots are exposed to MCP clients.</p><label>Allowed roots (one per line)</label><textarea id="allowedRoots"></textarea><label>Port</label><input id="port" type="number"><label>Public base URL</label><input id="publicBaseUrl" placeholder="https://devspace.example.com"></div><div class="card"><h2>Tunnel</h2><label><input id="tunnelEnabled" class="toggle" type="checkbox"> Enable managed tunnel</label><label><input id="tunnelAutoStart" class="toggle" type="checkbox"> Start tunnel with DevSpace</label><label>Command</label><input id="tunnelCommand" placeholder="/usr/local/bin/cloudflared"><label>Arguments (one per line)</label><textarea id="tunnelArgs" placeholder="tunnel\n--url\n\${localMcpUrl}"></textarea><label>Working directory</label><input id="tunnelCwd"><label>Public base URL</label><input id="tunnelPublicBaseUrl" placeholder="https://devspace.example.com"><label><input id="tunnelRestart" class="toggle" type="checkbox"> Restart if tunnel exits</label></div><div class="card"><h2>Login & service</h2><p class="help">Install a LaunchAgent so DevSpace starts automatically when this macOS user logs in.</p><div id="loginStatus">Loading…</div><div class="actions"><button class="action primary" data-action="service.install" data-activate="true">Enable & Start at Login</button><button class="action danger" data-action="service.disableLogin">Disable Login Start</button><button class="action" data-action="service.doctor">Service Doctor</button></div></div><div class="card"><h2>Permissions</h2><p class="help">Computer Use requires Accessibility and Screen Recording. macOS keeps the grants on the signed Desktop Host identity.</p><div class="actions"><button class="action primary" data-action="desktop.permissions">Request Permissions</button><button class="action" data-action="desktop.doctor">Permission Doctor</button><button class="action" data-goto="desktop">Open Computer Use</button></div></div></div><div class="actions"><button id="save" class="action primary">Save configuration</button><button id="saveRestart" class="action">Save & Restart Service</button></div><div id="saveResult" class="result hidden"></div></section>
  <section id="browser" class="page"><h1>Browser</h1><div class="sub">Install and verify the current-profile Chrome bridge.</div><div class="card"><div class="actions"><button class="action primary" data-action="browser.installHost">Install Native Host</button><button class="action" data-action="browser.openExtensions">Open Chrome Extensions</button><button class="action" data-action="browser.doctor">Run Browser Doctor</button></div><div class="result hidden"></div></div></section>
  <section id="desktop" class="page"><h1>Computer Use</h1><div class="sub">Install the signed desktop host and grant macOS permissions.</div><div class="card"><div class="actions"><button class="action primary" data-action="desktop.install">Build & Install Host</button><button class="action" data-action="desktop.permissions">Request Permissions</button><button class="action" data-action="desktop.doctor">Run Desktop Doctor</button></div><div class="result hidden"></div></div></section>
  </main></div><script>
  const token=new URLSearchParams(location.search).get('token')||''; const headers={'content-type':'application/json','authorization':'Bearer '+token};
  async function api(path,opts={}){const r=await fetch('/api'+path,{...opts,headers:{...headers,...(opts.headers||{})}});const j=await r.json();if(!r.ok||j.ok===false)throw new Error(j.error||('HTTP '+r.status));return j}
  function showResult(el,value){el.classList.remove('hidden');el.textContent=typeof value==='string'?value:JSON.stringify(value,null,2)}
  function page(id){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id===id));document.querySelectorAll('.nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===id))}
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));document.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>page(b.dataset.goto));
  async function load(){const [s,c]=await Promise.all([api('/status'),api('/config')]);const running=!!s.health.ok;coreStatus.innerHTML='<div class="row"><span>Service</span><span class="pill '+(running?'ok':'bad')+'"><span class="statusdot '+(running?'on':'')+'"></span>'+(running?'Running':'Stopped')+'</span></div><div class="row"><span>Node</span><span>'+s.node+'</span></div><div class="row"><span>Architecture</span><span>'+s.arch+'</span></div>';sideStatus.innerHTML='<span class="statusdot '+(running?'on':'')+'"></span>'+(running?'Core service running':'Core service stopped');tunnelStatus.innerHTML='<div class="row"><span>Configured</span><span>'+(s.tunnel.configured?'Yes':'No')+'</span></div><div class="row"><span>Enabled</span><span class="pill '+(s.tunnel.enabled?'ok':'warn')+'">'+(s.tunnel.enabled?'Enabled':'Disabled')+'</span></div><div class="row"><span>Public URL</span><span>'+(s.tunnel.publicBaseUrl||'—')+'</span></div>';loginStatus.innerHTML='<div class="row"><span>Start at login</span><span class="pill '+(s.service.startAtLogin?'ok':'warn')+'">'+(s.service.startAtLogin?'Enabled':'Disabled')+'</span></div><div class="row"><span>LaunchAgent</span><span title="'+s.service.plistPath+'">'+s.service.label+'</span></div>';const x=c.config||{};allowedRoots.value=(x.allowedRoots||[]).join('\n');port.value=x.port||7676;publicBaseUrl.value=x.publicBaseUrl||'';const t=x.tunnel||{};tunnelEnabled.checked=!!t.enabled;tunnelAutoStart.checked=t.autoStart!==false;tunnelCommand.value=t.command||'';tunnelArgs.value=(t.args||[]).join('\n');tunnelCwd.value=t.cwd||'';tunnelPublicBaseUrl.value=t.publicBaseUrl||'';tunnelRestart.checked=t.restartOnExit!==false}
  function currentConfig(){return{allowedRoots:allowedRoots.value.split(/\n+/).map(x=>x.trim()).filter(Boolean),port:Number(port.value),publicBaseUrl:publicBaseUrl.value||null,tunnel:{enabled:tunnelEnabled.checked,autoStart:tunnelAutoStart.checked,command:tunnelCommand.value||undefined,args:tunnelArgs.value.split(/\n+/).map(x=>x.trim()).filter(Boolean),cwd:tunnelCwd.value||undefined,publicBaseUrl:tunnelPublicBaseUrl.value||null,restartOnExit:tunnelRestart.checked}}}
  async function saveConfig(restart){try{showResult(saveResult,'Saving…');const saved=await api('/config',{method:'PUT',body:JSON.stringify(currentConfig())});if(restart){showResult(saveResult,'Configuration saved. Restarting service…');const restarted=await api('/actions/service.restart',{method:'POST',body:'{}'});showResult(saveResult,{saved,restarted})}else showResult(saveResult,saved);await load()}catch(e){showResult(saveResult,String(e))}}
  save.onclick=()=>saveConfig(false);saveRestart.onclick=()=>saveConfig(true);
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=async()=>{const box=b.closest('.card')?.querySelector('.result')||globalResult;try{b.disabled=true;showResult(box,'Running…');const body=b.dataset.activate==='true'?{activate:true}:{};showResult(box,await api('/actions/'+encodeURIComponent(b.dataset.action),{method:'POST',body:JSON.stringify(body)}));await load()}catch(e){showResult(box,String(e))}finally{b.disabled=false}});
  load().catch(e=>showResult(globalResult,String(e))); setInterval(()=>load().catch(()=>{}),10000);
  </script></body></html>`;
}
