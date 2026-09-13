import type { JsonValue } from "./types.js";

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|password|passwd|secret|token|api[_-]?key|session|credential)(?:$|[_-])/i;
const URL_PATTERN = /^https?:\/\//i;

export interface RedactionOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxStringLength?: number;
}

export function redactCapabilityValue(
  value: unknown,
  options: RedactionOptions = {},
): JsonValue {
  const limits = {
    maxDepth: options.maxDepth ?? 10,
    maxArrayItems: options.maxArrayItems ?? 50,
    maxObjectKeys: options.maxObjectKeys ?? 100,
    maxStringLength: options.maxStringLength ?? 2_000,
  };
  const seen = new WeakSet<object>();

  const visit = (entry: unknown, depth: number, key?: string): JsonValue => {
    if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (depth > limits.maxDepth) return "[MAX_DEPTH]";
    if (entry === null || typeof entry === "boolean") return entry;
    if (typeof entry === "number") return Number.isFinite(entry) ? entry : String(entry);
    if (typeof entry === "string") return redactString(entry, limits.maxStringLength);
    if (typeof entry === "bigint" || typeof entry === "symbol" || typeof entry === "function") {
      return String(entry);
    }
    if (entry === undefined) return null;

    if (typeof entry === "object") {
      if (seen.has(entry)) return "[CIRCULAR]";
      seen.add(entry);
      if (Array.isArray(entry)) {
        const values = entry
          .slice(0, limits.maxArrayItems)
          .map((item) => visit(item, depth + 1));
        if (entry.length > limits.maxArrayItems) values.push("[TRUNCATED]");
        return values;
      }

      const entries = Object.entries(entry as Record<string, unknown>);
      const output: Record<string, JsonValue> = {};
      for (const [childKey, childValue] of entries.slice(0, limits.maxObjectKeys)) {
        output[childKey] = visit(childValue, depth + 1, childKey);
      }
      if (entries.length > limits.maxObjectKeys) output._truncated = true;
      return output;
    }

    return String(entry);
  };

  return visit(value, 0);
}

function redactString(value: string, maxLength: number): string {
  let redacted = value;
  if (URL_PATTERN.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password) {
        parsed.username = "";
        parsed.password = "";
      }
      if (parsed.search) parsed.search = "?[REDACTED]";
      if (parsed.hash) parsed.hash = "#[REDACTED]";
      redacted = parsed.toString();
    } catch {
      redacted = value;
    }
  }
  return redacted.length <= maxLength
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxLength - 13))}[TRUNCATED]`;
}
