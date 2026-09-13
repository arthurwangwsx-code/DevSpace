import os from "node:os";
import { existsSync } from "node:fs";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CapabilityError } from "../errors.js";
import type { CapabilityProvider, ProviderCapability, ProviderContext, ProviderInvocation, ProviderInvocationContext, ProviderLease, ProviderOpenRequest } from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";
import { BrowserExtensionBridge } from "./browser-extension-bridge.js";

export const BROWSER_EXTENSION_PROVIDER_ID = "browser.chrome.extension";
const CLIENT_ID = "devspace";
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
const MUTATION = { readOnly: false, destructive: false, idempotent: false, openWorld: true };

export function browserExtensionShouldEnable(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.DEVSPACE_BROWSER_EXTENSION === "0") return false;
  if (environment.DEVSPACE_BROWSER_EXTENSION === "1") return true;
  if (environment.DEVSPACE_CHROME_NATIVE_HOST_MANIFEST) {
    return existsSync(environment.DEVSPACE_CHROME_NATIVE_HOST_MANIFEST);
  }
  if (process.platform !== "darwin") return false;
  const manifest = join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "com.devspace.browser_bridge.json");
  return existsSync(manifest);
}

export class BrowserExtensionProvider implements CapabilityProvider {
  readonly id = BROWSER_EXTENSION_PROVIDER_ID;
  private readonly bridge: BrowserExtensionBridge;
  private readySince?: string;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.bridge = new BrowserExtensionBridge(environment.DEVSPACE_BROWSER_SOCKET || join(os.homedir(), ".devspace", "browser-extension.sock"));
  }
  async start(_context: ProviderContext): Promise<void> { await this.bridge.start(); this.readySince = new Date().toISOString(); }
  async stop(_reason: string): Promise<void> { await this.bridge.stop(); this.readySince = undefined; }
  async health(_signal: AbortSignal): Promise<ProviderHealth> {
    // The provider itself is healthy once its local bridge is listening. Chrome
    // is an attachable client and may legitimately be closed or restarting;
    // treating that as provider degradation makes global strict doctor checks
    // fail on otherwise healthy machines. Individual calls still fail closed
    // with provider_unavailable until the extension connects.
    return { state: "ready", since: this.readySince ?? new Date().toISOString() };
  }
  async discover(_signal: AbortSignal): Promise<ProviderCapability[]> {
    return [
      capability("browser.extension.list_profiles", "List connected Chrome profiles", "__list_profiles", false, READ_ONLY, {}),
      capability("browser.extension.status", "Inspect the connected Chrome extension and profile", "hello", false, READ_ONLY, {}),
      capability("browser.extension.list_pages", "List current Chrome profile tabs", "list_tabs", false, READ_ONLY, { all: { type: "boolean", default: true } }, [], ["browser.chrome.list_pages"]),
      capability("browser.extension.open_page", "Open an agent Chrome tab", "open_tab", false, MUTATION, { url: { type: "string" } }, [], ["browser.chrome.open_page"]),
      capability("browser.extension.snapshot", "Read an acquired Chrome tab snapshot", "snapshot", true, READ_ONLY, {}, [], ["browser.chrome.take_snapshot"]),
      capability("browser.extension.screenshot", "Capture an acquired Chrome tab", "screenshot", true, READ_ONLY, {
        format: { type: "string", enum: ["png", "jpeg"] }, quality: { type: "integer", minimum: 1, maximum: 100 }, fullPage: { type: "boolean" },
      }, [], ["browser.chrome.take_screenshot"]),
      capability("browser.extension.navigate", "Navigate an acquired Chrome tab", "navigate", true, MUTATION, { url: { type: "string" } }, ["url"], ["browser.chrome.navigate"]),
      capability("browser.extension.reload", "Reload an acquired Chrome tab", "reload", true, MUTATION, { bypassCache: { type: "boolean" } }, [], ["browser.chrome.reload"]),
      capability("browser.extension.go_back", "Navigate back in an acquired Chrome tab", "go_back", true, MUTATION, {}, [], ["browser.chrome.go_back"]),
      capability("browser.extension.go_forward", "Navigate forward in an acquired Chrome tab", "go_forward", true, MUTATION, {}, [], ["browser.chrome.go_forward"]),
      capability("browser.extension.activate", "Bring an acquired Chrome tab to the foreground", "activate_tab", true, MUTATION, {}, [], ["browser.chrome.activate"]),
      capability("browser.extension.click", "Click an acquired Chrome tab", "click", true, MUTATION, { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }, [], ["browser.chrome.click"]),
      capability("browser.extension.hover", "Hover an acquired Chrome tab", "hover", true, MUTATION, { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }),
      capability("browser.extension.scroll", "Scroll an acquired Chrome tab", "scroll", true, MUTATION, { x: { type: "number" }, y: { type: "number" }, atX: { type: "number" }, atY: { type: "number" } }),
      capability("browser.extension.select_option", "Select a value in a select element", "select_option", true, MUTATION, { index: { type: "integer" }, value: { type: "string" } }, ["index", "value"]),
      capability("browser.extension.set_input_files", "Upload local files through a file input", "set_input_files", true, MUTATION, {
        index: { type: "integer" }, files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      }, ["index", "files"]),
      capability("browser.extension.type_text", "Type in an acquired Chrome tab", "type", true, MUTATION, { text: { type: "string" } }, ["text"], ["browser.chrome.type_text"]),
      capability("browser.extension.press_key", "Press a key in an acquired Chrome tab", "press", true, MUTATION, { key: { type: "string" } }, ["key"], ["browser.chrome.press_key"]),
      capability("browser.extension.evaluate", "Evaluate JavaScript in an acquired Chrome tab", "evaluate", true, MUTATION, { expression: { type: "string" }, awaitPromise: { type: "boolean" } }, ["expression"]),
      capability("browser.extension.get_html", "Read the current page HTML", "get_html", true, READ_ONLY, {}),
      capability("browser.extension.wait_for", "Wait for a selector, text or page load", "wait_for", true, READ_ONLY, {
        selector: { type: "string" }, text: { type: "string" }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 }, intervalMs: { type: "integer", minimum: 25, maximum: 1000 },
      }),
      capability("browser.extension.list_console_messages", "Read buffered console messages", "list_console", true, READ_ONLY, { limit: { type: "integer", minimum: 1, maximum: 500 } }, [], ["browser.chrome.list_console_messages"]),
      capability("browser.extension.list_network_requests", "Read buffered network activity with sensitive headers redacted", "list_network", true, READ_ONLY, { limit: { type: "integer", minimum: 1, maximum: 500 } }, [], ["browser.chrome.list_network_requests"]),
      capability("browser.extension.performance", "Read Chrome page performance metrics", "performance", true, READ_ONLY, {}),
      capability("browser.extension.download", "Download a URL with the current Chrome profile", "download", false, MUTATION, {
        url: { type: "string" }, filename: { type: "string" }, saveAs: { type: "boolean" },
      }, ["url"]),
    ];
  }
  async open(request: ProviderOpenRequest, context: ProviderInvocationContext): Promise<ProviderLease> {
    if (request.resourceType !== "browser_page") throw new CapabilityError("invalid_arguments", "Browser extension supports browser_page leases only.");
    const tabId = request.selector.tabId;
    const profileId = typeof request.selector.profileId === "string" ? request.selector.profileId : undefined;
    if (!Number.isInteger(tabId) || (tabId as number) < 0) throw new CapabilityError("invalid_arguments", "selector.tabId must be a non-negative integer.");
    const result = await this.bridge.call("use_tab", { clientId: CLIENT_ID, tabId: tabId as number }, context.signal, 10_000, profileId);
    return {
      handle: { tabId: tabId as number, ...(profileId ? { profileId } : {}) },
      display: { ...asObject(result), ...(profileId ? { profileId } : {}) },
    };
  }
  async close(lease: ProviderLease, context: ProviderInvocationContext): Promise<void> {
    const tabId = lease.handle.tabId;
    if (Number.isInteger(tabId)) {
      const command = lease.display.ownership === "agent" ? "close_tab" : "release_tab";
      const profileId = typeof lease.handle.profileId === "string" ? lease.handle.profileId : undefined;
      await this.bridge.call(command, { clientId: CLIENT_ID, tabId: tabId as number }, context.signal, 10_000, profileId);
    }
  }
  async invoke(request: ProviderInvocation, context: ProviderInvocationContext): Promise<JsonValue> {
    const command = typeof request.binding.command === "string" ? request.binding.command : undefined;
    if (!command) throw new CapabilityError("invalid_arguments", "Browser extension command binding is missing.");
    const params = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments) ? { ...request.arguments } : {};
    if (command === "__list_profiles") return { profiles: this.bridge.listProfiles() };
    params.clientId = CLIENT_ID;
    const requestedProfileId = typeof params.profileId === "string" ? params.profileId : undefined;
    delete params.profileId;
    if (command === "set_input_files") {
      const files = Array.isArray(params.files) ? params.files : [];
      params.files = files.map((file) => this.validateUploadPath(file));
    }
    if (command === "list_tabs" && params.all === undefined) params.all = true;
    if (request.descriptor.execution.requiresLease) {
      const tabId = request.lease?.handle.tabId;
      if (!Number.isInteger(tabId)) throw new CapabilityError("lease_required", "A browser_page lease is required.");
      params.tabId = tabId as number;
    }
    const leaseProfileId = typeof request.lease?.handle.profileId === "string" ? request.lease.handle.profileId : undefined;
    const profileId = leaseProfileId ?? requestedProfileId;
    try { return await this.bridge.call(command, params, context.signal, 10_000, profileId); }
    catch (error) {
      if (/not connected|disconnected|connection (?:failed|was replaced)|bridge stopped/i.test(String(error))) {
        throw new CapabilityError("provider_unavailable", "DevSpace Browser Bridge extension is not connected.", { cause: error });
      }
      if (/timed out/i.test(String(error))) {
        throw new CapabilityError("timeout", "The browser extension request timed out.", { cause: error });
      }
      if (/exceeds the bridge limit/i.test(String(error))) {
        throw new CapabilityError("output_too_large", "The browser extension response exceeds the configured limit.", { cause: error });
      }
      throw error;
    }
  }

  private validateUploadPath(value: JsonValue): string {
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new CapabilityError("invalid_arguments", "Browser file uploads require absolute file paths.");
    }
    let target: string;
    try { target = realpathSync(value); }
    catch { throw new CapabilityError("invalid_arguments", `Upload file does not exist: ${value}`); }
    return target;
  }
}

function capability(id: string, title: string, command: string, requiresLease: boolean, effects: typeof READ_ONLY, properties: JsonObject, required: string[] = [], aliases: string[] = []): ProviderCapability {
  return { descriptor: { id, version: "1.1.0", providerId: BROWSER_EXTENSION_PROVIDER_ID, title, description: title, tags: ["browser", "chrome", "extension"], inputSchema: { type: "object", properties, required, additionalProperties: false }, effects, permissions: [], availability: { requiresAwake: true, requiresLoggedInSession: true, requiresUnlocked: false, requiresForegroundApp: false }, execution: { modes: ["sync"], defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, requiresLease, resourceTypes: requiresLease ? ["browser_page"] : [] }, metadata: { transport: "chrome-native-messaging" } }, binding: { command }, aliases };
}
function asObject(value: JsonValue): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
