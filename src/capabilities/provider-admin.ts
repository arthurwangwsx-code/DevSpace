import type { CapabilityConfig } from "../config.js";
import { CapabilityError } from "./errors.js";
import {
  archiveMcpProviderManifest,
  loadMcpProviderManifests,
  parseMcpProviderManifest,
  restoreArchivedMcpProviderManifest,
  setMcpProviderEnabled,
  writeMcpProviderManifest,
} from "./mcp-provider-manifest.js";
import { createMcpProviderRegistration } from "./providers/mcp-provider-loader.js";
import type { CapabilityRuntime } from "./runtime.js";
import type { CapabilityPrincipal, JsonValue } from "./types.js";

export type ProviderAdminAction = "enable" | "disable" | "reload";

export class CapabilityProviderAdmin {
  private operation = Promise.resolve();

  constructor(
    private readonly runtime: CapabilityRuntime,
    private readonly config: CapabilityConfig,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  list(principal: CapabilityPrincipal): JsonValue {
    this.requireAdmin(principal);
    return jsonValue({
      enabled: this.config.adminApiEnabled,
      providers: loadMcpProviderManifests(this.config.configDir).map(({ manifest }) => ({
        id: manifest.metadata.id,
        title: manifest.metadata.title,
        enabled: manifest.spec.enabled,
        transport: manifest.spec.transport.type,
        capabilityCount: this.runtime.registry.capabilityCountForProvider(manifest.metadata.id),
        runtime: this.runtime.supervisor.list().find(({ id }) => id === manifest.metadata.id)?.health,
      })),
    });
  }

  install(principal: CapabilityPrincipal, value: unknown): Promise<JsonValue> {
    return this.serial(async () => {
      this.requireAdmin(principal);
      const manifest = parseMcpProviderManifest(value);
      const path = writeMcpProviderManifest(manifest, this.config.configDir);
      try {
        await this.runtime.installProvider(
          principal,
          createMcpProviderRegistration(manifest, this.environment),
        );
      } catch (error) {
        try { archiveMcpProviderManifest(manifest.metadata.id, this.config.configDir); } catch {}
        throw error;
      }
      return this.result(manifest.metadata.id, { installed: true, path });
    });
  }

  action(
    principal: CapabilityPrincipal,
    providerId: string,
    action: ProviderAdminAction,
  ): Promise<JsonValue> {
    return this.serial(async () => {
      this.requireAdmin(principal);
      const loaded = this.configured(providerId);
      const manifest = loaded.manifest;
      if (action === "reload") {
        await this.runtime.reloadProvider(
          principal,
          createMcpProviderRegistration(manifest, this.environment),
        );
        return this.result(providerId, { reloaded: true });
      }
      const enabled = action === "enable";
      const previous = manifest.spec.enabled;
      setMcpProviderEnabled(providerId, enabled, this.config.configDir);
      try {
        await this.runtime.setProviderEnabled(principal, providerId, enabled);
      } catch (error) {
        setMcpProviderEnabled(providerId, previous, this.config.configDir);
        throw error;
      }
      return this.result(providerId, { enabled });
    });
  }

  remove(principal: CapabilityPrincipal, providerId: string): Promise<JsonValue> {
    return this.serial(async () => {
      this.requireAdmin(principal);
      this.configured(providerId);
      const archived = archiveMcpProviderManifest(providerId, this.config.configDir);
      try {
        await this.runtime.removeProvider(principal, providerId);
      } catch (error) {
        restoreArchivedMcpProviderManifest(archived.path, archived.archivedPath);
        throw error;
      }
      return jsonValue({
        providerId,
        removed: true,
        recoverable: true,
        archivedPath: archived.archivedPath,
        catalogRevision: this.runtime.registry.revision,
      });
    });
  }

  private result(providerId: string, extra: Record<string, JsonValue>): JsonValue {
    return jsonValue({
      providerId,
      ...extra,
      health: this.runtime.supervisor.getHealth(providerId),
      capabilityCount: this.runtime.registry.capabilityCountForProvider(providerId),
      catalogRevision: this.runtime.registry.revision,
    });
  }

  private configured(providerId: string) {
    const loaded = loadMcpProviderManifests(this.config.configDir)
      .find(({ manifest }) => manifest.metadata.id === providerId);
    if (!loaded) throw new CapabilityError("capability_not_found", `Unknown configured provider: ${providerId}`);
    return loaded;
  }

  private requireAdmin(principal: CapabilityPrincipal): void {
    if (!this.config.adminApiEnabled) {
      throw new CapabilityError("policy_denied", "Dynamic Provider administration is disabled by the local operator.");
    }
    if (this.config.enforcePolicy && !principal.scopes.includes("capabilities:admin")) {
      throw new CapabilityError("policy_denied", "The principal lacks capabilities:admin.");
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
