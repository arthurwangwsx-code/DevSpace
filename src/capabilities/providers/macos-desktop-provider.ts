import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CapabilityError } from "../errors.js";
import { parseMcpProviderManifest, type McpProviderManifest } from "../mcp-provider-manifest.js";
import type {
  ProviderInvocation,
  ProviderInvocationContext,
  ProviderLease,
  ProviderOpenRequest,
} from "../provider.js";
import type { JsonObject, JsonValue, ProviderHealth } from "../types.js";
import { McpClientProvider } from "./mcp-client-provider.js";

const PROVIDER_ID = "desktop.macos.accessibility";
const LOCKED_REQUIREMENTS = {
  requiresAwake: true,
  requiresLoggedInSession: true,
  requiresUnlocked: true,
  requiresForegroundApp: false,
};
const STATUS_REQUIREMENTS = {
  requiresAwake: true,
  requiresLoggedInSession: false,
  requiresUnlocked: false,
  requiresForegroundApp: false,
};
const READ_ONLY = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const MUTATION = { readOnly: false, destructive: false, idempotent: false, openWorld: false };

export class MacosDesktopProvider extends McpClientProvider {
  private serial = Promise.resolve();

  override async health(signal: AbortSignal): Promise<ProviderHealth> {
    const transportHealth = await super.health(signal);
    if (transportHealth.state !== "ready") return transportHealth;
    const status = await this.callDownstreamTool("desktop_status", {}, signal);
    const unavailablePermissions = desktopUnavailablePermissions(status);
    if (unavailablePermissions.length === 0) return transportHealth;
    return {
      state: "degraded",
      since: transportHealth.since,
      reasonCode: "permission_required",
      unavailablePermissions,
      userAction: `Grant ${unavailablePermissions.join(" and ")} to the installed DevSpace desktop host.`,
    };
  }

  async open(request: ProviderOpenRequest, context: ProviderInvocationContext): Promise<ProviderLease> {
    if (request.resourceType !== "app_window") {
      throw new CapabilityError("invalid_arguments", "macOS desktop supports only app_window leases.");
    }
    const bundleId = request.selector.bundleId;
    if (typeof bundleId !== "string" || !/^[A-Za-z0-9.-]+$/.test(bundleId)) {
      throw new CapabilityError("invalid_arguments", "selector.bundleId must be a valid bundle identifier.");
    }
    const apps = await this.runSerialized(() => this.callDownstreamTool("desktop_list_apps", {}, context.signal));
    const app = findApp(apps, bundleId);
    if (!app) throw new CapabilityError("invalid_arguments", "The selected application is not running.");
    return {
      handle: { bundleId },
      display: { bundleId, ...(app.name ? { name: app.name } : {}) },
    };
  }

  override async invoke(request: ProviderInvocation, context: ProviderInvocationContext): Promise<JsonValue> {
    return this.runSerialized(async () => {
      let argumentsValue = request.arguments;
      if (request.descriptor.execution.requiresLease) {
        const bundleId = request.lease?.handle.bundleId;
        if (typeof bundleId !== "string") {
          throw new CapabilityError("lease_required", "A valid app_window lease is required.");
        }
        if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
          throw new CapabilityError("invalid_arguments", "Desktop arguments must be an object.");
        }
        const requestedBundleId = argumentsValue.bundleId;
        if (requestedBundleId !== undefined && requestedBundleId !== bundleId) {
          throw new CapabilityError("policy_denied", "Arguments cannot override the leased application.");
        }
        argumentsValue = { ...argumentsValue, bundleId };
      }
      try {
        return await super.invoke({ ...request, arguments: argumentsValue }, context);
      } catch (error) {
        if (error instanceof CapabilityError && error.code === "permission_required") {
          this.context?.reportFailure(error);
        }
        throw error;
      }
    });
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createMacosDesktopManifest(
  command: string,
  platform: NodeJS.Platform = process.platform,
): McpProviderManifest {
  if (platform !== "darwin") throw new Error("The macOS desktop provider requires macOS.");
  const resolved = desktopExecutable(command);
  return parseMcpProviderManifest({
    apiVersion: "devspace.capabilities/v1",
    kind: "McpProvider",
    metadata: { id: PROVIDER_ID, title: "macOS Accessibility Desktop Helper" },
    spec: {
      enabled: true,
      transport: { type: "stdio", command: resolved, args: [] },
      tools: [
        mapping("desktop_status", "desktop.macos.status", "读取桌面 Helper 权限状态", false, READ_ONLY, STATUS_REQUIREMENTS),
        mapping("desktop_list_apps", "desktop.macos.list_apps", "列出正在运行的 GUI 应用", false, READ_ONLY, LOCKED_REQUIREMENTS),
        mapping("desktop_snapshot_app", "desktop.macos.snapshot_app", "读取应用可访问性树", true, READ_ONLY, LOCKED_REQUIREMENTS),
        mapping("desktop_screenshot_app", "desktop.macos.screenshot_app", "截取应用的可见窗口", true, READ_ONLY, LOCKED_REQUIREMENTS),
        mapping("desktop_activate_app", "desktop.macos.activate_app", "激活应用窗口", true, MUTATION, LOCKED_REQUIREMENTS),
        mapping("desktop_click_point", "desktop.macos.click_point", "点击应用内坐标", true, MUTATION, LOCKED_REQUIREMENTS),
        mapping("desktop_type_text", "desktop.macos.type_text", "向应用安全焦点输入文本", true, MUTATION, LOCKED_REQUIREMENTS),
        mapping("desktop_press_key", "desktop.macos.press_key", "向应用发送允许的按键", true, MUTATION, LOCKED_REQUIREMENTS),
      ],
    },
  });
}

function mapping(
  tool: string,
  capabilityId: string,
  title: string,
  requiresLease: boolean,
  effects: typeof READ_ONLY,
  availability: typeof LOCKED_REQUIREMENTS,
) {
  return {
    tool,
    capabilityId,
    title,
    version: "1.0.0",
    tags: ["desktop", "macos", effects.readOnly ? "read" : "mutation"],
    aliases: [],
    effects,
    availability,
    permissions: permissionsFor(tool),
    requiresLease,
    resourceTypes: requiresLease ? ["app_window"] : [],
    defaultTimeoutMs: 15_000,
    maxTimeoutMs: 60_000,
  };
}

function permissionsFor(tool: string) {
  if (tool === "desktop_status" || tool === "desktop_list_apps") return [];
  if (tool === "desktop_screenshot_app") return [{
    id: "macos.screen-capture",
    required: true,
    description: "The stable DevSpace desktop helper must be trusted in macOS Screen Recording settings.",
  }];
  return [{
    id: "macos.accessibility",
    required: true,
    description: "The stable DevSpace desktop helper must be trusted in macOS Accessibility settings.",
  }];
}

function desktopExecutable(command: string): string {
  if (!isAbsolute(command)) throw new Error("Desktop helper command must be absolute.");
  accessSync(command, constants.X_OK);
  return realpathSync(command);
}

function findApp(value: JsonValue, bundleId: string): { name?: string } | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findApp(item, bundleId);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    if (value.bundleId === bundleId) {
      return { ...(typeof value.name === "string" ? { name: value.name } : {}) };
    }
    for (const item of Object.values(value)) {
      const found = findApp(item, bundleId);
      if (found) return found;
    }
  }
  return undefined;
}

function desktopUnavailablePermissions(value: JsonValue): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapabilityError("internal_error", "Desktop status returned an invalid result.");
  }
  const unavailable: string[] = [];
  if (value.accessibilityTrusted !== true) unavailable.push("macos.accessibility");
  if (value.screenCaptureGranted !== true) unavailable.push("macos.screen-capture");
  return unavailable;
}
