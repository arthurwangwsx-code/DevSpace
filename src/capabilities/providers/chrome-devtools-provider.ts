import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { CapabilityError } from "../errors.js";
import {
  parseMcpProviderManifest,
  type McpProviderManifest,
} from "../mcp-provider-manifest.js";
import type {
  ProviderInvocation,
  ProviderInvocationContext,
  ProviderLease,
  ProviderOpenRequest,
} from "../provider.js";
import type { JsonObject, JsonValue } from "../types.js";
import { McpClientProvider } from "./mcp-client-provider.js";

const PROVIDER_ID = "browser.chrome.devtools";
const RUNTIME_REQUIREMENTS = {
  requiresAwake: true,
  requiresLoggedInSession: true,
  // Kept fail-closed until the versioned real lock-screen matrix passes.
  requiresUnlocked: true,
  requiresForegroundApp: false,
};
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: true };

export class ChromeDevToolsProvider extends McpClientProvider {
  private serial = Promise.resolve();
  private pageOperationSucceeded = false;

  async open(request: ProviderOpenRequest, context: { signal: AbortSignal }): Promise<ProviderLease> {
    if (request.resourceType !== "browser_page") {
      throw new CapabilityError("invalid_arguments", "Chrome supports only browser_page leases.");
    }
    const pageId = request.selector.pageId;
    if (!Number.isInteger(pageId) || (pageId as number) < 0) {
      throw new CapabilityError("invalid_arguments", "selector.pageId must be a non-negative integer.");
    }
    await this.runSerialized(async () => {
      await this.callChrome("select_page", { pageId: pageId as number, bringToFront: false }, context.signal);
    });
    return { handle: { pageId: pageId as number }, display: { pageId: pageId as number } };
  }

  override async invoke(
    request: ProviderInvocation,
    context: ProviderInvocationContext,
  ): Promise<JsonValue> {
    try {
      return await this.runSerialized(async () => {
        if (request.descriptor.execution.requiresLease) {
          const pageId = request.lease?.handle.pageId;
          if (!Number.isInteger(pageId) || (pageId as number) < 0) {
            throw new CapabilityError("lease_required", "A valid browser_page lease is required.");
          }
          await this.callChrome("select_page", { pageId: pageId as number, bringToFront: false }, context.signal);
        }
        const result = await super.invoke(request, context);
        this.pageOperationSucceeded = true;
        return result;
      });
    } catch (error) {
      throw this.classifyInitialConnectionError(error);
    }
  }

  private async callChrome(
    tool: string,
    argumentsValue: JsonObject,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    try {
      const result = await this.callDownstreamTool(tool, argumentsValue, signal);
      this.pageOperationSucceeded = true;
      return result;
    } catch (error) {
      throw this.classifyInitialConnectionError(error);
    }
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private classifyInitialConnectionError(error: unknown): unknown {
    if (error instanceof CapabilityError) return error;
    if (!this.pageOperationSucceeded && looksLikeConnectionApprovalTimeout(error)) {
      const permissionError = new CapabilityError(
        "permission_required",
        "Chrome has not completed the remote-debugging handshake.",
        { details: { action: "Unlock Chrome and approve the remote debugging prompt; then restart the provider." }, cause: error },
      );
      this.context?.reportFailure(permissionError);
      return permissionError;
    }
    return error;
  }
}

export function createChromeDevToolsManifest(command: string): McpProviderManifest {
  if (!isAbsolute(command)) throw new Error("Chrome DevTools MCP command must be absolute.");
  return parseMcpProviderManifest({
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: PROVIDER_ID, title: "Current Chrome via Chrome DevTools MCP" },
    spec: {
      enabled: true,
      transport: {
        type: "stdio",
        command,
        args: [
          "--autoConnect",
          "--no-category-extensions",
          "--no-performance-crux",
          "--no-usage-statistics",
        ],
      },
      tools: [
        mapping("list_pages", "browser.chrome.list_pages", "列出当前 Chrome 页面", false, ["browser", "chrome", "pages"]),
        mapping("take_snapshot", "browser.chrome.take_snapshot", "读取 Chrome 页面语义快照", true, ["browser", "chrome", "snapshot"]),
        mapping("take_screenshot", "browser.chrome.take_screenshot", "截取 Chrome 页面图像", true, ["browser", "chrome", "screenshot"]),
        mapping("list_console_messages", "browser.chrome.list_console_messages", "读取 Chrome 页面控制台消息", true, ["browser", "chrome", "console"]),
        mapping("list_network_requests", "browser.chrome.list_network_requests", "读取 Chrome 页面网络请求", true, ["browser", "chrome", "network"]),
      ],
    },
  });
}

export function findChromeDevToolsMcpCommand(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DEVSPACE_CHROME_MCP_COMMAND;
  if (override) return executable(override);
  const names = process.platform === "win32"
    ? ["chrome-devtools-mcp.cmd", "chrome-devtools-mcp.exe", "chrome-devtools-mcp"]
    : ["chrome-devtools-mcp"];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try { return executable(join(directory, name)); } catch {}
    }
  }
  throw new Error("chrome-devtools-mcp was not found on PATH. Install it with: npm install -g chrome-devtools-mcp@latest");
}

function mapping(tool: string, capabilityId: string, title: string, requiresLease: boolean, tags: string[]) {
  return {
    tool,
    capabilityId,
    title,
    version: "1.0.0",
    tags,
    aliases: [],
    effects: READ_ONLY,
    availability: RUNTIME_REQUIREMENTS,
    permissions: [{
      id: "chrome.remote_debugging",
      required: true,
      description: "Chrome must allow remote debugging for the current browser instance.",
    }],
    requiresLease,
    resourceTypes: requiresLease ? ["browser_page"] : [],
    defaultTimeoutMs: tool === "take_screenshot" ? 60_000 : 30_000,
    maxTimeoutMs: 120_000,
  };
}

function executable(path: string): string {
  if (!isAbsolute(path)) throw new Error("DEVSPACE_CHROME_MCP_COMMAND must be absolute.");
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}

function looksLikeConnectionApprovalTimeout(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /timed? out|deadline|request timed out|transport closed|socket connection was closed/i.test(message);
}
