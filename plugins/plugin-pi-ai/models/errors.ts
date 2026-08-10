/**
 * Maps Pi and upstream failures into redacted elizaOS errors while preserving
 * the structural HTTP seam used by generic model-provider fallback.
 */
import { ElizaError } from "@elizaos/core";

export type PiErrorCode =
  | "PI_INVALID_MODEL_ID"
  | "PI_UNKNOWN_PROVIDER"
  | "PI_MODEL_NOT_CONFIGURED"
  | "PI_CREDENTIAL_MISSING"
  | "PI_PROVIDER_AUTH_FAILED"
  | "PI_UNSUPPORTED_PARAMETER"
  | "PI_UNSUPPORTED_CAPABILITY"
  | "PI_INVALID_MESSAGE_SEQUENCE"
  | "PI_PROVIDER_RATE_LIMITED"
  | "PI_PROVIDER_UNAVAILABLE"
  | "PI_STREAM_TERMINATED"
  | "PI_EMPTY_RESULT"
  | "PI_CANCELLED"
  | "PI_DISPOSED";

export class PiTextError extends ElizaError {
  readonly status?: number;
  readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      code: PiErrorCode;
      cause?: unknown;
      context?: Record<string, unknown>;
      fallbackStatus?: number;
    },
  ) {
    super(message, {
      code: options.code,
      cause: options.cause,
      context: options.context,
      severity: "ephemeral",
    });
    this.status = options.fallbackStatus;
    this.statusCode = options.fallbackStatus;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStatus(error: unknown): number | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = objectValue(current);
    if (record === undefined) return undefined;
    const status = Number(record.statusCode ?? record.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599)
      return status;
    current = record.cause ?? record.error ?? record.lastError;
  }
  if (error instanceof Error) {
    const match = error.message.match(/\b([45]\d\d)\b/);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

function readRetryAfter(error: unknown): string | number | undefined {
  const record = objectValue(error);
  const headers = objectValue(record?.headers);
  const value = record?.retryAfter ?? headers?.["retry-after"];
  return typeof value === "string" || typeof value === "number"
    ? value
    : undefined;
}

function cancellationReason(signal?: AbortSignal): unknown {
  return signal?.aborted ? signal.reason : undefined;
}

export function cancelledPiError(args: {
  signal?: AbortSignal;
  disposed?: boolean;
  provider?: string;
  qualifiedModel?: string;
}): PiTextError {
  const disposed = args.disposed === true;
  return new PiTextError(
    disposed ? "Pi gateway was disposed" : "Pi text request was cancelled",
    {
      code: disposed ? "PI_DISPOSED" : "PI_CANCELLED",
      cause: cancellationReason(args.signal),
      context: {
        ...(args.provider === undefined ? {} : { provider: args.provider }),
        ...(args.qualifiedModel === undefined
          ? {}
          : { qualifiedModel: args.qualifiedModel }),
      },
    },
  );
}

export function mapPiError(
  error: unknown,
  args: {
    provider: string;
    qualifiedModel: string;
    committed: boolean;
    signal?: AbortSignal;
    disposed?: boolean;
  },
): PiTextError {
  if (args.signal?.aborted === true || args.disposed === true) {
    return cancelledPiError({ ...args });
  }
  if (error instanceof PiTextError) return error;

  const status = readStatus(error);
  const originalMessage =
    error instanceof Error && error.message.trim().length > 0
      ? error.message.trim()
      : "Upstream Pi provider request failed";
  const lower = originalMessage.toLowerCase();
  const context = {
    provider: args.provider,
    qualifiedModel: args.qualifiedModel,
    ...(status === undefined ? {} : { status }),
    ...(readRetryAfter(error) === undefined
      ? {}
      : { retryAfter: readRetryAfter(error) }),
    committed: args.committed,
  };

  if (args.committed) {
    return new PiTextError("Pi stream terminated after output was committed", {
      code: "PI_STREAM_TERMINATED",
      cause: error,
      context,
    });
  }
  if (
    status === 401 ||
    status === 403 ||
    /auth|api key|unauthoriz/.test(lower)
  ) {
    return new PiTextError("Pi upstream provider authentication failed", {
      code: "PI_PROVIDER_AUTH_FAILED",
      cause: error,
      context,
    });
  }
  if (
    status === 429 ||
    /rate.?limit|too many requests|overloaded/.test(lower)
  ) {
    return new PiTextError("Pi upstream provider rate limited the request", {
      code: "PI_PROVIDER_RATE_LIMITED",
      cause: error,
      context,
      fallbackStatus: 429,
    });
  }
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 529 ||
    /timeout|timed out|temporarily unavailable|service unavailable|econnreset|socket hang up|fetch failed|network error/.test(
      lower,
    )
  ) {
    return new PiTextError("Pi upstream provider is temporarily unavailable", {
      code: "PI_PROVIDER_UNAVAILABLE",
      cause: error,
      context,
      fallbackStatus: status ?? 503,
    });
  }
  return new PiTextError("Pi upstream provider request failed", {
    code: "PI_STREAM_TERMINATED",
    cause: error,
    context,
  });
}
