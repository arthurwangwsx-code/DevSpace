import { createHash } from "node:crypto";
import type { ProviderRegistration } from "../provider.js";
import { loadMcpProviderManifests } from "../mcp-provider-manifest.js";
import { McpClientProvider } from "./mcp-client-provider.js";

export function loadMcpProviderRegistrations(
  configDir: string,
  environment: NodeJS.ProcessEnv = process.env,
): ProviderRegistration[] {
  return loadMcpProviderManifests(configDir).map(({ manifest }) => ({
    provider: new McpClientProvider(manifest, environment),
    kind: `mcp:${manifest.spec.transport.type}`,
    enabled: manifest.spec.enabled,
    manifestDigest: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("base64url"),
  }));
}
