/**
 * @module rate-limit
 * @description Helpers for detecting GitHub rate-limit errors and surfacing
 * them as structured results instead of raw exceptions.
 */

export interface GitHubHttpError {
  status?: number;
  response?: {
    headers?: Record<string, string | number | undefined>;
  };
  message?: string;
}

export interface RateLimitDetails {
  isRateLimited: boolean;
  resetAtMs: number | null;
  remaining: number | null;
}

function toErrorLike(value: unknown): GitHubHttpError {
  if (typeof value !== "object" || value === null) {
    return { message: String(value) };
  }
  return value as GitHubHttpError;
}

function headerNumber(
  headers: Record<string, string | number | undefined> | undefined,
  name: string,
): number | null {
  if (!headers) {
    return null;
  }
  // Case-insensitive: HTTP/1.1 transports may deliver canonical casing
  // (`X-RateLimit-Remaining`) while HTTP/2 and Octokit normalize to
  // lowercase. A casing miss would silently drop the reset timestamp.
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  );
  if (!entry) {
    return null;
  }
  const raw = entry[1];
  if (raw === undefined) {
    return null;
  }
  const num = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(num) ? num : null;
}

/** GitHub documents primary rate-limit exhaustion as 403 OR 429. */
function isRateLimitStatus(status: number | undefined): boolean {
  return status === 403 || status === 429;
}

export function inspectRateLimit(err: unknown): RateLimitDetails {
  const e = toErrorLike(err);
  const headers = e.response?.headers;
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const resetSeconds = headerNumber(headers, "x-ratelimit-reset");
  const isRateLimited = isRateLimitStatus(e.status) && remaining === 0;
  return {
    isRateLimited,
    remaining,
    resetAtMs: resetSeconds === null ? null : resetSeconds * 1000,
  };
}

export function formatRateLimitMessage(details: RateLimitDetails): string {
  if (!details.isRateLimited) {
    return "GitHub request failed";
  }
  if (details.resetAtMs === null) {
    return "GitHub rate limit exhausted";
  }
  const reset = new Date(details.resetAtMs).toISOString();
  return `GitHub rate limit exhausted; resets at ${reset}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  const e = toErrorLike(err);
  return e.message ?? "unknown error";
}
