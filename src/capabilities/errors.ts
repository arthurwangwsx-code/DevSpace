import type { JsonObject } from "./types.js";

export const CAPABILITY_ERROR_CODES = [
  "capability_not_found",
  "provider_unavailable",
  "permission_required",
  "temporarily_unavailable",
  "invalid_arguments",
  "policy_denied",
  "lease_required",
  "lease_expired",
  "timeout",
  "cancelled",
  "conflict",
  "rate_limited",
  "output_too_large",
  "internal_error",
] as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[number];

const HTTP_STATUS_BY_CODE: Record<CapabilityErrorCode, number> = {
  capability_not_found: 404,
  provider_unavailable: 503,
  permission_required: 403,
  temporarily_unavailable: 503,
  invalid_arguments: 400,
  policy_denied: 403,
  lease_required: 409,
  lease_expired: 410,
  timeout: 504,
  cancelled: 409,
  conflict: 409,
  rate_limited: 429,
  output_too_large: 413,
  internal_error: 500,
};

const RETRYABLE_CODES = new Set<CapabilityErrorCode>([
  "provider_unavailable",
  "temporarily_unavailable",
  "timeout",
  "rate_limited",
]);

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly retryable: boolean;
  readonly details?: JsonObject;
  readonly httpStatus: number;

  constructor(
    code: CapabilityErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: JsonObject;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "CapabilityError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.details = options.details;
    this.httpStatus = HTTP_STATUS_BY_CODE[code];
  }
}

export function normalizeCapabilityError(error: unknown): CapabilityError {
  if (error instanceof CapabilityError) return error;
  return new CapabilityError("internal_error", "The capability request failed.", {
    cause: error,
  });
}

export function capabilityErrorEnvelope(error: unknown, requestId: string): {
  error: {
    code: CapabilityErrorCode;
    message: string;
    retryable: boolean;
    details?: JsonObject;
  };
  meta: { requestId: string };
} {
  const normalized = normalizeCapabilityError(error);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
      ...(normalized.details ? { details: normalized.details } : {}),
    },
    meta: { requestId },
  };
}
