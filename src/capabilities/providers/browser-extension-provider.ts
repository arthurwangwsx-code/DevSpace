import os from "node:os";
import { join } from "node:path";
import { CapabilityError } from "../errors.js";
import type { CapabilityProvider, ProviderCapability, ProviderContext, ProviderInvocation, ProviderInvocationContext, ProviderLease, ProviderOpenRequest } from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";
import { BrowserExtensionBridge } from "./browser-extension-bridge.js";

export const BROWSER_EXTENSION_PROVIDER_ID = "browser.chrome.extension";
const CLIENT_ID = "devspace";
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
const MUTATION = { readOnly: false, destructive: false, idempotent: false, openWorld: true };

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
    return this.bridge.connected
      ? { state: "ready", since: this.readySince ?? new Date().toISOString() }
      : { state: "degraded", since: this.readySince ?? new Date().toISOString(), reasonCode: "extension_not_connected" };
  }
  async discover(_signal: AbortSignal): Promise<ProviderCapability[]> {
    return [
      capability("browser.extension.list_pages", "List current Chrome profile tabs", "list_tabs", false, READ_ONLY, { all: { type: "boolean", default: true } }),
      capability("browser.extension.open_page", "Open an agent Chrome tab", "open_tab", false, MUTATION, { url: { type: "string" } }),
      capability("browser.extension.snapshot", "Read an acquired Chrome tab snapshot", "snapshot", true, READ_ONLY, {}),
      capability("browser.extension.screenshot", "Capture an acquired Chrome tab", "screenshot", true, READ_ONLY, {}),
      capability("browser.extension.navigate", "Navigate an acquired Chrome tab", "navigate", true, MUTATION, { url: { type: "string" } }, ["url"]),
      capability("browser.extension.click", "Click an acquired Chrome tab", "click", true, MUTATION, { index: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }),
      capability("browser.extension.type_text", "Type in an acquired Chrome tab", "type", true, MUTATION, { text: { type: "string" } }, ["text"]),
      capability("browser.extension.press_key", "Press a key in an acquired Chrome tab", "press", true, MUTATION, { key: { type: "string" } }, ["key"]),
    ];
  }
  async open(request: ProviderOpenRequest, context: ProviderInvocationContext): Promise<ProviderLease> {
    if (request.resourceType !== "browser_page") throw new CapabilityError("invalid_arguments", "Browser extension supports browser_page leases only.");
    const tabId = request.selector.tabId;
    if (!Number.isInteger(tabId) || (tabId as number) < 0) throw new CapabilityError("invalid_arguments", "selector.tabId must be a non-negative integer.");
    const result = await this.bridge.call("use_tab", { clientId: CLIENT_ID, tabId: tabId as number }, context.signal);
    return { handle: { tabId: tabId as number }, display: asObject(result) };
  }
  async close(lease: ProviderLease, context: ProviderInvocationContext): Promise<void> {
    const tabId = lease.handle.tabId;
    if (Number.isInteger(tabId)) {
      const command = lease.display.ownership === "agent" ? "close_tab" : "release_tab";
      await this.bridge.call(command, { clientId: CLIENT_ID, tabId: tabId as number }, context.signal);
    }
  }
  async invoke(request: ProviderInvocation, context: ProviderInvocationContext): Promise<JsonValue> {
    const command = typeof request.binding.command === "string" ? request.binding.command : undefined;
    if (!command) throw new CapabilityError("invalid_arguments", "Browser extension command binding is missing.");
    const params = request.arguments && typeof request.arguments === "object" && !Array.isArray(request.arguments) ? { ...request.arguments } : {};
    params.clientId = CLIENT_ID;
    if (command === "list_tabs" && params.all === undefined) params.all = true;
    if (request.descriptor.execution.requiresLease) {
      const tabId = request.lease?.handle.tabId;
      if (!Number.isInteger(tabId)) throw new CapabilityError("lease_required", "A browser_page lease is required.");
      params.tabId = tabId as number;
    }
    try { return await this.bridge.call(command, params, context.signal); }
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
}

function capability(id: string, title: string, command: string, requiresLease: boolean, effects: typeof READ_ONLY, properties: JsonObject, required: string[] = []): ProviderCapability {
  return { descriptor: { id, version: "1.0.0", providerId: BROWSER_EXTENSION_PROVIDER_ID, title, description: title, tags: ["browser", "chrome", "extension"], inputSchema: { type: "object", properties, required, additionalProperties: false }, effects, permissions: [], availability: { requiresAwake: true, requiresLoggedInSession: true, requiresUnlocked: false, requiresForegroundApp: false }, execution: { modes: ["sync"], defaultTimeoutMs: 10_000, maxTimeoutMs: 30_000, requiresLease, resourceTypes: requiresLease ? ["browser_page"] : [] }, metadata: { transport: "chrome-native-messaging" } }, binding: { command } };
}
function asObject(value: JsonValue): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
