import { CapabilityError } from "./errors.js";
import { parseCapabilityDescriptor } from "./descriptor-schema.js";
import { searchCapabilityCandidates, type CapabilitySearchResult } from "./search.js";
import type { SqliteCapabilityCatalogStore } from "./catalog-store.js";
import type {
  CapabilityDescriptor,
  CapabilityListQuery,
  CapabilitySearchQuery,
  CapabilitySummary,
  JsonValue,
  ProviderHealth,
} from "./types.js";

export interface CapabilityBinding {
  invoke(argumentsValue: JsonValue, signal: AbortSignal): Promise<JsonValue>;
}

export interface DiscoveredCapability {
  descriptor: CapabilityDescriptor;
  binding: CapabilityBinding;
  aliases?: string[];
}

interface RegistryEntry extends DiscoveredCapability {
  persistedOnly: boolean;
}

export interface CapabilityPage {
  items: CapabilitySummary[];
  nextCursor?: string;
  catalogRevision: number;
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly providerHealth = new Map<string, ProviderHealth>();
  private revisionValue = 0;

  constructor(private readonly store?: SqliteCapabilityCatalogStore) {
    const persisted = store?.loadCatalog();
    if (persisted) {
      this.revisionValue = persisted.revision;
      for (const descriptor of persisted.descriptors) {
        this.entries.set(descriptor.id, {
          descriptor,
          binding: unavailableBinding,
          persistedOnly: true,
        });
      }
    }
  }

  get revision(): number {
    return this.revisionValue;
  }

  replaceProviderCatalog(input: {
    providerId: string;
    kind: string;
    enabled?: boolean;
    health: ProviderHealth;
    capabilities: DiscoveredCapability[];
    manifestDigest?: string;
  }): number {
    const parsed = input.capabilities.map((capability) => ({
      ...capability,
      descriptor: parseCapabilityDescriptor(capability.descriptor),
    }));
    const ids = new Set<string>();
    for (const capability of parsed) {
      if (capability.descriptor.providerId !== input.providerId) {
        throw new CapabilityError(
          "conflict",
          `Capability ${capability.descriptor.id} belongs to a different provider.`,
        );
      }
      if (ids.has(capability.descriptor.id)) {
        throw new CapabilityError(
          "conflict",
          `Provider ${input.providerId} returned duplicate capability ${capability.descriptor.id}.`,
        );
      }
      ids.add(capability.descriptor.id);
      const existing = this.entries.get(capability.descriptor.id);
      if (existing && existing.descriptor.providerId !== input.providerId) {
        throw new CapabilityError(
          "conflict",
          `Capability ${capability.descriptor.id} is already owned by ${existing.descriptor.providerId}.`,
        );
      }
    }

    const revision = this.store?.replaceProviderCatalog({
      providerId: input.providerId,
      kind: input.kind,
      enabled: input.enabled ?? true,
      health: input.health,
      descriptors: parsed.map(({ descriptor }) => descriptor),
      manifestDigest: input.manifestDigest,
    }) ?? this.revisionValue + 1;

    for (const [id, entry] of this.entries) {
      if (entry.descriptor.providerId === input.providerId) this.entries.delete(id);
    }
    for (const capability of parsed) {
      this.entries.set(capability.descriptor.id, { ...capability, persistedOnly: false });
    }
    this.providerHealth.set(input.providerId, input.health);
    this.revisionValue = revision;
    return revision;
  }

  setProviderHealth(providerId: string, health: ProviderHealth): void {
    this.providerHealth.set(providerId, health);
  }

  getDescriptor(capabilityId: string): CapabilityDescriptor | undefined {
    return this.entries.get(capabilityId)?.descriptor;
  }

  getBinding(capabilityId: string): CapabilityBinding {
    const entry = this.entries.get(capabilityId);
    if (!entry) {
      throw new CapabilityError("capability_not_found", `Unknown capability: ${capabilityId}`);
    }
    if (entry.persistedOnly) {
      throw new CapabilityError("provider_unavailable", "The provider has not been restored yet.");
    }
    return entry.binding;
  }

  list(
    query: CapabilityListQuery = {},
    canDiscover: (descriptor: CapabilityDescriptor) => boolean = () => true,
  ): CapabilityPage {
    const limit = boundedLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    if (cursor && cursor.revision !== this.revisionValue) {
      throw new CapabilityError("conflict", "The capability catalog changed; restart pagination.");
    }
    const items = [...this.entries.values()]
      .filter(({ descriptor }) => canDiscover(descriptor))
      .filter(({ descriptor }) => !query.providerId || descriptor.providerId === query.providerId)
      .filter(({ descriptor }) => !query.tag || descriptor.tags.includes(query.tag))
      .map((entry) => this.toSummary(entry))
      .filter((summary) => !query.availableOnly || summary.availability.state === "ready")
      .filter((summary) => !cursor || summary.id > cursor.lastId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const pageItems = items.slice(0, limit);
    const hasMore = items.length > limit;
    return {
      items: pageItems,
      ...(hasMore && pageItems.length > 0
        ? { nextCursor: encodeCursor(this.revisionValue, pageItems.at(-1)!.id) }
        : {}),
      catalogRevision: this.revisionValue,
    };
  }

  search(
    query: CapabilitySearchQuery,
    canDiscover: (descriptor: CapabilityDescriptor) => boolean = () => true,
  ): { items: CapabilitySearchResult[]; catalogRevision: number } {
    const providerIds = new Set(query.providerIds ?? []);
    const requiredTags = new Set(query.tags ?? []);
    const candidates = [...this.entries.values()]
      .filter(({ descriptor }) => canDiscover(descriptor))
      .filter(({ descriptor }) => providerIds.size === 0 || providerIds.has(descriptor.providerId))
      .filter(({ descriptor }) => [...requiredTags].every((tag) => descriptor.tags.includes(tag)))
      .map((entry) => ({ summary: this.toSummary(entry), aliases: entry.aliases }))
      .filter(({ summary }) => !query.availableOnly || summary.availability.state === "ready");
    return {
      items: searchCapabilityCandidates(candidates, query.query, boundedLimit(query.limit)),
      catalogRevision: this.revisionValue,
    };
  }

  private toSummary(entry: RegistryEntry): CapabilitySummary {
    const health = this.providerHealth.get(entry.descriptor.providerId);
    let state: CapabilitySummary["availability"]["state"] = "unavailable";
    if (entry.persistedOnly) state = "unavailable";
    else if (health?.state === "ready") state = "ready";
    else if (health?.state === "needs_user_action") state = "permission_required";
    else if (health?.state === "starting" || health?.state === "backoff") {
      state = "temporarily_unavailable";
    }
    return {
      id: entry.descriptor.id,
      version: entry.descriptor.version,
      providerId: entry.descriptor.providerId,
      title: entry.descriptor.title,
      description: entry.descriptor.description,
      tags: [...entry.descriptor.tags],
      effects: { ...entry.descriptor.effects },
      availability: {
        state,
        ...(health?.reasonCode ? { reasonCode: health.reasonCode } : {}),
      },
    };
  }
}

const unavailableBinding: CapabilityBinding = {
  async invoke(): Promise<JsonValue> {
    throw new CapabilityError("provider_unavailable", "The provider is unavailable.");
  },
};

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new CapabilityError("invalid_arguments", "limit must be an integer from 1 to 200.");
  }
  return limit;
}

function encodeCursor(revision: number, lastId: string): string {
  return Buffer.from(JSON.stringify({ revision, lastId }), "utf8").toString("base64url");
}

function decodeCursor(value: string): { revision: number; lastId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    const { revision, lastId } = parsed as Record<string, unknown>;
    if (!Number.isInteger(revision) || typeof lastId !== "string") throw new Error("invalid fields");
    return { revision: revision as number, lastId };
  } catch (error) {
    throw new CapabilityError("invalid_arguments", "Invalid capability cursor.", { cause: error });
  }
}
