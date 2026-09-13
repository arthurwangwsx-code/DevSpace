import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { CapabilityError } from "../errors.js";
import {
  parseMcpProviderManifest,
  type McpProviderManifest,
} from "../mcp-provider-manifest.js";
import type {
  CapabilityProvider,
  ProviderCapability,
  ProviderContext,
  ProviderInvocation,
  ProviderInvocationContext,
  ProviderLease,
  ProviderOpenRequest,
} from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";
import { ChromeDevToolsDaemonClient } from "./chrome-devtools-daemon-client.js";
import { McpClientProvider } from "./mcp-client-provider.js";

const PROVIDER_ID = "browser.chrome.devtools";
const RUNTIME_REQUIREMENTS = {
  requiresAwake: true,
  requiresLoggedInSession: true,
  // CDP is a background protocol. Let the downstream connection decide whether
  // an established session can continue while the display is locked.
  requiresUnlocked: false,
  requiresForegroundApp: false,
};
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: true };
const MUTATION = { readOnly: false, destructive: false, idempotent: false, openWorld: true };

export class ChromeDevToolsProvider implements CapabilityProvider {
  readonly id = PROVIDER_ID;
  private serial = Promise.resolve();
  private pageOperationSucceeded = false;
  private readonly legacy?: LegacyChromeMcpProvider;
  private readonly daemon?: ChromeDevToolsDaemonClient;
  private context?: ProviderContext;
  private readySince?: string;

  constructor(
    private readonly manifest: McpProviderManifest,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    const transport = manifest.spec.transport;
    if (transport.type === "stdio" && transport.args[0] === "start") {
      this.daemon = new ChromeDevToolsDaemonClient(
        transport.command,
        transport.args,
        environment,
      );
    } else {
      this.legacy = new LegacyChromeMcpProvider(manifest, environment);
    }
  }

  async start(context: ProviderContext): Promise<void> {
    this.context = context;
    if (this.daemon) await this.daemon.ensureRunning(context.signal);
    else await this.legacy!.start(context);
    this.readySince = new Date().toISOString();
  }

  async stop(reason: string): Promise<void> {
    await this.legacy?.stop(reason);
    this.daemon?.disconnect();
    this.readySince = undefined;
    // The CLI daemon intentionally outlives this Provider and DevSpace process.
  }

  async health(signal: AbortSignal): Promise<ProviderHealth> {
    if (this.legacy) return this.legacy.health(signal);
    try {
      await this.daemon!.status(signal);
      return { state: "ready", since: this.readySince ?? new Date().toISOString() };
    } catch {
      return { state: "stopped", since: new Date().toISOString(), reasonCode: "daemon_unavailable" };
    }
  }

  async discover(signal: AbortSignal): Promise<ProviderCapability[]> {
    if (this.legacy) {
      return (await this.legacy.discover(signal)).map(normalizeChromeCapability);
    }
    const daemon = this.daemon!;
    await daemon.status(signal);
    return this.manifest.spec.tools.map((mapping) => ({
      descriptor: {
        id: mapping.capabilityId,
        version: mapping.version,
        providerId: this.id,
        title: mapping.title ?? mapping.tool,
        description: mapping.description ?? `Call Chrome DevTools daemon tool ${mapping.tool}.`,
        tags: [...mapping.tags],
        inputSchema: chromeInputSchema(mapping.tool),
        effects: { ...mapping.effects },
        permissions: mapping.permissions.map((permission) => ({ ...permission })),
        availability: { ...mapping.availability },
        execution: {
          modes: ["sync", "async"],
          defaultTimeoutMs: mapping.defaultTimeoutMs,
          maxTimeoutMs: mapping.maxTimeoutMs,
          requiresLease: mapping.requiresLease,
          resourceTypes: [...mapping.resourceTypes],
        },
        metadata: {
          downstreamProtocol: "chrome-devtools-cli-daemon",
          downstreamTool: mapping.tool,
          daemonSocket: daemon.socketPath,
        },
      },
      binding: { tool: mapping.tool },
      aliases: [...mapping.aliases],
    }));
  }

  async open(request: ProviderOpenRequest, context: { signal: AbortSignal }): Promise<ProviderLease> {
    if (request.resourceType !== "browser_page") {
      throw new CapabilityError("invalid_arguments", "Chrome supports only browser_page leases.");
    }
    const pageId = request.selector.pageId;
    if (!Number.isInteger(pageId) || (pageId as number) < 0) {
      throw new CapabilityError("invalid_arguments", "selector.pageId must be a non-negative integer.");
    }
    const display = await this.runSerialized(async () => {
      const pages = await this.callChrome("list_pages", {}, context.signal);
      const page = findPage(pages, pageId as number);
      if (!page) throw new CapabilityError("invalid_arguments", "selector.pageId is not an available Chrome page.");
      await this.callChrome("select_page", { pageId: pageId as number, bringToFront: false }, context.signal);
      return { pageId: pageId as number, ...(page.origin ? { origin: page.origin } : {}) };
    });
    return { handle: { pageId: pageId as number }, display };
  }

  async invoke(
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
        const tool = typeof request.binding.tool === "string" ? request.binding.tool : undefined;
        if (!tool) throw new CapabilityError("invalid_arguments", "Chrome tool binding is missing.");
        const argumentsValue = request.arguments && typeof request.arguments === "object"
          && !Array.isArray(request.arguments)
          ? { ...request.arguments }
          : {};
        if (request.descriptor.execution.requiresLease) {
          argumentsValue.pageId = request.lease!.handle.pageId!;
        }
        const result = this.daemon
          ? await this.daemon.callTool(tool, argumentsValue, context.signal)
          : await this.legacy!.invoke({ ...request, arguments: argumentsValue }, context);
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
      const result = this.daemon
        ? await this.daemon.callTool(tool, argumentsValue, signal)
        : await this.legacy!.callChromeTool(tool, argumentsValue, signal);
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

class LegacyChromeMcpProvider extends McpClientProvider {
  callChromeTool(tool: string, argumentsValue: JsonObject, signal: AbortSignal): Promise<JsonValue> {
    return this.callDownstreamTool(tool, argumentsValue, signal);
  }
}

export function createChromeDevToolsManifest(command: string): McpProviderManifest {
  if (!isAbsolute(command)) throw new Error("Chrome DevTools CLI command must be absolute.");
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
          "start",
          "--autoConnect",
          "--no-category-extensions",
          "--no-memory-debugging",
          "--no-performance-crux",
          "--no-usage-statistics",
          "--redactNetworkHeaders",
        ],
      },
      tools: [
        mapping("list_pages", "browser.chrome.list_pages", "列出当前 Chrome 页面", false, ["browser", "chrome", "pages", "internal-backend"], READ_ONLY),
        mapping("take_snapshot", "browser.chrome.take_snapshot", "读取 Chrome 页面语义快照", true, ["browser", "chrome", "snapshot", "internal-backend"], READ_ONLY),
        mapping("take_screenshot", "browser.chrome.take_screenshot", "截取 Chrome 页面图像", true, ["browser", "chrome", "screenshot", "internal-backend"], READ_ONLY),
        mapping("list_console_messages", "browser.chrome.list_console_messages", "读取 Chrome 页面控制台消息", true, ["browser", "chrome", "console", "internal-backend"], READ_ONLY),
        mapping("list_network_requests", "browser.chrome.list_network_requests", "读取 Chrome 页面网络请求", true, ["browser", "chrome", "network", "internal-backend"], READ_ONLY),
        mapping("navigate_page", "browser.chrome.navigate", "导航 Chrome 页面", true, ["browser", "chrome", "navigation", "mutation", "internal-backend"], MUTATION),
        mapping("click", "browser.chrome.click", "点击 Chrome 页面元素", true, ["browser", "chrome", "input", "mutation", "internal-backend"], MUTATION),
        mapping("type_text", "browser.chrome.type_text", "向 Chrome 当前焦点输入文本", true, ["browser", "chrome", "input", "mutation", "internal-backend"], MUTATION),
        mapping("press_key", "browser.chrome.press_key", "向 Chrome 页面发送按键", true, ["browser", "chrome", "input", "mutation", "internal-backend"], MUTATION),
      ],
    },
  });
}

export function findChromeDevToolsMcpCommand(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DEVSPACE_CHROME_CLI_COMMAND ?? environment.DEVSPACE_CHROME_MCP_COMMAND;
  if (override) return executable(override);
  const names = process.platform === "win32"
    ? ["chrome-devtools.cmd", "chrome-devtools.exe", "chrome-devtools"]
    : ["chrome-devtools"];
  for (const directory of (environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of names) {
      try { return executable(join(directory, name)); } catch {}
    }
  }
  throw new Error("chrome-devtools CLI was not found on PATH. Install it with: npm install -g chrome-devtools-mcp@latest");
}

function normalizeChromeCapability(capability: ProviderCapability): ProviderCapability {
  const inputSchema = structuredClone(capability.descriptor.inputSchema);
  if (inputSchema.properties && typeof inputSchema.properties === "object"
      && !Array.isArray(inputSchema.properties)) {
    delete inputSchema.properties.pageId;
  }
  if (Array.isArray(inputSchema.required)) {
    inputSchema.required = inputSchema.required.filter((name) => name !== "pageId");
  }
  return {
    ...capability,
    descriptor: { ...capability.descriptor, inputSchema },
  };
}

function chromeInputSchema(tool: string): JsonObject {
  const common: Record<string, JsonObject> = {
    list_pages: {},
    take_snapshot: { verbose: { type: "boolean" } },
    take_screenshot: {
      format: { type: "string", enum: ["png", "jpeg", "webp"] },
      quality: { type: "number", minimum: 0, maximum: 100 },
      uid: { type: "string" },
      fullPage: { type: "boolean" },
    },
    list_console_messages: {
      pageSize: { type: "integer", minimum: 1 },
      pageIdx: { type: "integer", minimum: 0 },
      types: { type: "array", items: { type: "string" } },
      includePreservedMessages: { type: "boolean" },
      includeStackTraces: { type: "boolean" },
      serviceWorkerId: { type: "string" },
    },
    list_network_requests: {
      pageSize: { type: "integer", minimum: 1 },
      pageIdx: { type: "integer", minimum: 0 },
      resourceTypes: { type: "array", items: { type: "string" } },
      includePreservedRequests: { type: "boolean" },
    },
    navigate_page: {
      type: { type: "string" },
      url: { type: "string" },
      ignoreCache: { type: "boolean" },
      handleBeforeUnload: { type: "string" },
      initScript: { type: "string" },
      timeout: { type: "number", minimum: 0 },
    },
    click: {
      uid: { type: "string" },
      dblClick: { type: "boolean" },
      includeSnapshot: { type: "boolean" },
    },
    type_text: {
      text: { type: "string" },
      submitKey: { type: "string" },
    },
    press_key: {
      key: { type: "string" },
      includeSnapshot: { type: "boolean" },
    },
  };
  const required: Record<string, string[]> = {
    click: ["uid"],
    type_text: ["text"],
    press_key: ["key"],
  };
  return {
    type: "object",
    properties: common[tool] ?? {},
    ...(required[tool] ? { required: required[tool] } : {}),
    additionalProperties: true,
  };
}

function mapping(
  tool: string,
  capabilityId: string,
  title: string,
  requiresLease: boolean,
  tags: string[],
  effects: typeof READ_ONLY,
) {
  return {
    tool,
    capabilityId,
    title,
    version: "1.0.0",
    tags,
    aliases: [],
    effects,
    availability: RUNTIME_REQUIREMENTS,
    permissions: [{
      id: "chrome.remote_debugging",
      required: true,
      description: "Chrome must allow remote debugging for the current browser instance.",
    }],
    requiresLease,
    resourceTypes: requiresLease ? ["browser_page"] : [],
    defaultTimeoutMs: ["list_pages", "take_screenshot"].includes(tool) ? 60_000 : 30_000,
    maxTimeoutMs: 120_000,
  };
}

function executable(path: string): string {
  if (!isAbsolute(path)) throw new Error("DEVSPACE_CHROME_CLI_COMMAND must be absolute.");
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}

function looksLikeConnectionApprovalTimeout(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /timed? out|deadline|request timed out|transport closed|socket connection was closed/i.test(message);
}

function findPage(value: JsonValue, pageId: number): { origin?: string } | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const pages = value.pages;
    if (Array.isArray(pages)) {
      for (const page of pages) {
        if (typeof page === "number" && page === pageId) return {};
        if (page && typeof page === "object" && !Array.isArray(page)
          && (page.pageId === pageId || page.id === pageId) && typeof page.url === "string") {
          return { origin: safeOrigin(page.url) };
        }
      }
    }
    for (const child of Object.values(value)) {
      const found = findPage(child, pageId);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findPage(child, pageId);
      if (found) return found;
    }
  } else if (typeof value === "string") {
    for (const line of value.split("\n")) {
      const match = line.trim().match(/^(\d+):\s+(\S+)/);
      if (match && Number(match[1]) === pageId) return { origin: safeOrigin(match[2]!) };
    }
  }
  return undefined;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === "null" ? undefined : url.origin;
  } catch {
    return undefined;
  }
}
