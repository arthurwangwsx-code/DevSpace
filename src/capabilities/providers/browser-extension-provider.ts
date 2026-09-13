import os from "node:os";
import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { browserControlShouldEnable } from "../../browser-control-config.js";
import { CapabilityError } from "../errors.js";
import type { CapabilityProvider, ProviderCapability, ProviderContext, ProviderInvocation, ProviderInvocationContext, ProviderLease, ProviderOpenRequest } from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";
import { BrowserExtensionBridge } from "./browser-extension-bridge.js";

// Public capabilities are canonical browser-domain APIs. The extension is an
// implementation detail behind the browser control provider, not part of the
// model-facing capability namespace.
export const BROWSER_CONTROL_PROVIDER_ID = "browser.control";
/** @deprecated Internal compatibility alias; public capabilities use browser.* canonical IDs. */
export const BROWSER_EXTENSION_PROVIDER_ID = BROWSER_CONTROL_PROVIDER_ID;
const CLIENT_ID = "devspace";
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
const MUTATION = { readOnly: false, destructive: false, idempotent: false, openWorld: true };

export function browserExtensionShouldEnable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return browserControlShouldEnable(environment);
}

export class BrowserControlProvider implements CapabilityProvider {
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
      capability("browser.profile.list", "List connected browser profiles", "__list_profiles", false, READ_ONLY, {}, [], ["browser.extension.list_profiles", "chrome profiles", "浏览器 profile"]),
      capability("browser.connection.status", "Inspect the active browser connection", "hello", false, READ_ONLY, {}, [], ["browser.extension.status", "browser health", "chrome connection"]),
      capability("browser.tab.list", "List tabs in the selected browser profile", "list_tabs", false, READ_ONLY, { all: { type: "boolean", default: true }, profileId: { type: "string" } }, [], ["browser.extension.list_pages", "browser.chrome.list_pages", "browser pages", "current tabs"]),
      capability("browser.tab.open", "Open an agent-owned browser tab", "open_tab", false, MUTATION, { url: { type: "string" }, profileId: { type: "string" } }, [], ["browser.extension.open_page", "browser.chrome.open_page", "open browser page"]),
      capability("browser.page.snapshot", "Read a semantic snapshot of an acquired browser page", "snapshot", true, READ_ONLY, {}, [], ["browser.extension.snapshot", "browser.chrome.take_snapshot", "page accessibility snapshot"]),
      capability("browser.page.screenshot", "Capture an acquired browser page", "screenshot", true, READ_ONLY, {
        format: { type: "string", enum: ["png", "jpeg"] }, quality: { type: "integer", minimum: 1, maximum: 100 }, fullPage: { type: "boolean" },
      }, [], ["browser.extension.screenshot", "browser.chrome.take_screenshot", "page screenshot"]),
      capability("browser.page.navigate", "Navigate an acquired browser page", "navigate", true, MUTATION, { url: { type: "string" } }, ["url"], ["browser.extension.navigate", "browser.chrome.navigate"]),
      capability("browser.page.reload", "Reload an acquired browser page", "reload", true, MUTATION, { bypassCache: { type: "boolean" } }, [], ["browser.extension.reload", "browser.chrome.reload"]),
      capability("browser.page.go_back", "Navigate back in an acquired browser page", "go_back", true, MUTATION, {}, [], ["browser.extension.go_back", "browser.chrome.go_back"]),
      capability("browser.page.go_forward", "Navigate forward in an acquired browser page", "go_forward", true, MUTATION, {}, [], ["browser.extension.go_forward", "browser.chrome.go_forward"]),
      capability("browser.tab.activate", "Bring an acquired browser tab to the foreground", "activate_tab", true, MUTATION, {}, [], ["browser.extension.activate", "browser.chrome.activate"]),
      capability("browser.page.click", "Click an element or point in an acquired browser page", "click", true, MUTATION, { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }, [], ["browser.extension.click", "browser.chrome.click", "press button", "点击网页"]),
      capability("browser.page.hover", "Hover an element or point in an acquired browser page", "hover", true, MUTATION, { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }, [], ["browser.extension.hover"]),
      capability("browser.page.scroll", "Scroll an acquired browser page", "scroll", true, MUTATION, { x: { type: "number" }, y: { type: "number" }, atX: { type: "number" }, atY: { type: "number" } }, [], ["browser.extension.scroll"]),
      capability("browser.page.select", "Select an option in an acquired browser page", "select_option", true, MUTATION, { index: { type: "integer" }, value: { type: "string" } }, ["index", "value"], ["browser.extension.select_option", "select dropdown"]),
      capability("browser.file.upload", "Upload local files through a browser file input", "set_input_files", true, MUTATION, {
        index: { type: "integer" }, files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      }, ["index", "files"], ["browser.extension.set_input_files", "upload file", "file input"]),
      capability("browser.page.type", "Type text into an acquired browser page", "type", true, MUTATION, { text: { type: "string" } }, ["text"], ["browser.extension.type_text", "browser.chrome.type_text", "enter text"]),
      capability("browser.page.press", "Press a key in an acquired browser page", "press", true, MUTATION, { key: { type: "string" } }, ["key"], ["browser.extension.press_key", "browser.chrome.press_key", "keyboard"]),
      capability("browser.page.evaluate", "Evaluate JavaScript in an acquired browser page", "evaluate", true, MUTATION, { expression: { type: "string" }, awaitPromise: { type: "boolean" } }, ["expression"], ["browser.extension.evaluate", "page javascript"]),
      capability("browser.page.html", "Read the current browser page HTML", "get_html", true, READ_ONLY, {}, [], ["browser.extension.get_html", "page source", "html"]),
      capability("browser.page.wait", "Wait for a selector, text or page load", "wait_for", true, READ_ONLY, {
        selector: { type: "string" }, text: { type: "string" }, urlEquals: { type: "string" }, urlContains: { type: "string" }, networkIdleMs: { type: "integer", minimum: 0, maximum: 30000 }, timeoutMs: { type: "integer", minimum: 0, maximum: 30000 }, intervalMs: { type: "integer", minimum: 25, maximum: 1000 },
      }, [], ["browser.extension.wait_for", "wait selector", "wait text", "wait load"]),
      capability("browser.debug.console", "Read buffered browser console messages", "list_console", true, READ_ONLY, { limit: { type: "integer", minimum: 1, maximum: 500 } }, [], ["browser.extension.list_console_messages", "browser.chrome.list_console_messages", "console logs"]),
      capability("browser.debug.network", "Read buffered browser network activity with sensitive headers redacted", "list_network", true, READ_ONLY, { limit: { type: "integer", minimum: 1, maximum: 500 } }, [], ["browser.extension.list_network_requests", "browser.chrome.list_network_requests", "network requests"]),
      capability("browser.debug.performance", "Read browser page performance metrics", "performance", true, READ_ONLY, {}, [], ["browser.extension.performance", "performance metrics"]),
      capability("browser.file.download", "Download a URL with the selected browser profile", "download", false, MUTATION, {
        url: { type: "string" }, filename: { type: "string" }, saveAs: { type: "boolean" },
      }, ["url"], ["browser.extension.download", "download file"]),
      capability("browser.file.download_status", "Read browser download status", "download_status", false, READ_ONLY, {
        downloadId: { type: "integer" }, profileId: { type: "string" },
      }, ["downloadId"], ["download progress", "download status"]),
      capability("browser.file.wait_download", "Wait for a browser download to complete", "wait_download", false, READ_ONLY, {
        downloadId: { type: "integer" }, timeoutMs: { type: "integer", minimum: 0, maximum: 120000 }, intervalMs: { type: "integer", minimum: 25, maximum: 1000 }, profileId: { type: "string" },
      }, ["downloadId"], ["wait download", "download complete"]),
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
    try {
      return await this.bridge.call(
        command,
        params,
        context.signal,
        request.descriptor.execution.defaultTimeoutMs,
        profileId,
      );
    }
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

/** @deprecated Use BrowserControlProvider. Kept for internal test/import compatibility. */
export class BrowserExtensionProvider extends BrowserControlProvider {}

function capability(id: string, title: string, command: string, requiresLease: boolean, effects: typeof READ_ONLY, properties: JsonObject, required: string[] = [], aliases: string[] = []): ProviderCapability {
  const [, resource = "browser", action = "invoke"] = id.split(".");
  return { descriptor: { id, version: "2.0.0", providerId: BROWSER_EXTENSION_PROVIDER_ID, title, description: title, tags: ["browser", resource, action], inputSchema: { type: "object", properties, required, additionalProperties: false }, effects, permissions: [], availability: { requiresAwake: true, requiresLoggedInSession: true, requiresUnlocked: false, requiresForegroundApp: false }, execution: { modes: ["sync"], defaultTimeoutMs: 20_000, maxTimeoutMs: 60_000, requiresLease, resourceTypes: requiresLease ? ["browser_page"] : [] }, metadata: { domain: "browser", resource, action, routing: "extension-first", transport: "chrome-native-messaging" } }, binding: { command }, aliases };
}
function asObject(value: JsonValue): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
