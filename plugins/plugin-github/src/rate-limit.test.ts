/**
 * Pins the GitHub rate-limit wire-format translation: `inspectRateLimit`
 * classifies a caught request error as rate-limited only on GitHub's actual
 * signal (HTTP 403 or 429 + `x-ratelimit-remaining: 0`), converts the
 * `x-ratelimit-reset` epoch-seconds header to milliseconds, and tolerates
 * header-case and missing-header variance. The consumers are the GITHUB_PR
 * list/review handler and the notification triage handler, which surface
 * "retry at <time>" instead of a generic failure only when this translation
 * holds. Realistic harness: plain error objects shaped like the Octokit
 * `HttpError`s those handlers catch — no mocks of the module under test.
 */
import { describe, expect, it } from "vitest";
import {
  errorMessage,
  formatRateLimitMessage,
  type GitHubHttpError,
  inspectRateLimit,
} from "./rate-limit.js";

/**
 * Shape of an Octokit `HttpError` after it crosses a JSON boundary: numeric
 * `status`, `response.headers` with canonical casing, `message`. These are
 * real wire shapes seen from GitHub REST, not invented ones.
 */
function githubError(overrides: Partial<GitHubHttpError>): GitHubHttpError {
  return {
    status: 403,
    message: "API rate limit exceeded",
    response: {
      headers: {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1893456000",
      },
    },
    ...overrides,
  };
}

describe("inspectRateLimit — rate-limited detection", () => {
  it("classifies 403 with remaining 0 as rate-limited and converts reset epoch-seconds to ms", () => {
    const details = inspectRateLimit(githubError({}));
    expect(details.isRateLimited).toBe(true);
    expect(details.remaining).toBe(0);
    expect(details.resetAtMs).toBe(1_893_456_000_000);
  });

  it("does not classify a 403 permission error (remaining > 0) as rate-limited", () => {
    const err = githubError({
      message: "Resource not accessible by integration",
      response: {
        headers: {
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": "1893456000",
        },
      },
    });
    const details = inspectRateLimit(err);
    expect(details.isRateLimited).toBe(false);
    // The raw counters are still surfaced for diagnostics even when the
    // verdict is "not rate-limited".
    expect(details.remaining).toBe(4999);
    expect(details.resetAtMs).toBe(1_893_456_000_000);
  });

  it("classifies a 429 with remaining 0 as rate-limited — GitHub documents exhaustion as 403 OR 429", () => {
    const err = githubError({
      status: 429,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1893456000",
        },
      },
    });
    // Per GitHub's REST docs: "If you exceed your primary rate limit, you
    // will receive a 403 or 429 response, and the x-ratelimit-remaining
    // header will be 0." Keying on 403 alone silently degraded 429-shaped
    // exhaustion into a generic failure.
    const details = inspectRateLimit(err);
    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(1_893_456_000_000);
  });

  it("requires both signals: 403 without the remaining header is not rate-limited", () => {
    const err = githubError({
      response: { headers: { "x-ratelimit-reset": "1893456000" } },
    });
    const details = inspectRateLimit(err);
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBeNull();
  });

  it("reads lowercase header names (Octokit normalizes to lowercase)", () => {
    const err = githubError({
      response: {
        headers: {
          "x-ratelimit-remaining": 0,
          "x-ratelimit-reset": 1893456000,
        },
      },
    });
    const details = inspectRateLimit(err);
    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(1_893_456_000_000);
  });

  it("reads mixed-case header names", () => {
    const err = githubError({
      response: {
        headers: {
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1893456000",
        },
      },
    });
    const details = inspectRateLimit(err);
    expect(details.isRateLimited).toBe(true);
    expect(details.resetAtMs).toBe(1_893_456_000_000);
  });
});

describe("inspectRateLimit — malformed and absent input", () => {
  it("returns null counters when headers are absent entirely", () => {
    const details = inspectRateLimit({ status: 403, response: {} });
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBeNull();
    expect(details.resetAtMs).toBeNull();
  });

  it("returns null counters for a non-object error value", () => {
    const details = inspectRateLimit("just a string");
    expect(details.isRateLimited).toBe(false);
    expect(details.remaining).toBeNull();
    expect(details.resetAtMs).toBeNull();
  });

  it("treats a non-numeric remaining header as absent", () => {
    const err = githubError({
      response: {
        headers: {
          "x-ratelimit-remaining": "many",
          "x-ratelimit-reset": "soon",
        },
      },
    });
    const details = inspectRateLimit(err);
    expect(details.remaining).toBeNull();
    expect(details.resetAtMs).toBeNull();
    expect(details.isRateLimited).toBe(false);
  });
});

describe("formatRateLimitMessage — user-facing verdicts", () => {
  it("names the reset time when rate-limited with a reset timestamp", () => {
    const message = formatRateLimitMessage({
      isRateLimited: true,
      remaining: 0,
      resetAtMs: 1_893_456_000_000,
    });
    expect(message).toBe(
      "GitHub rate limit exhausted; resets at 2030-01-01T00:00:00.000Z",
    );
  });

  it("says exhausted without a time when reset is unknown", () => {
    const message = formatRateLimitMessage({
      isRateLimited: true,
      remaining: 0,
      resetAtMs: null,
    });
    expect(message).toBe("GitHub rate limit exhausted");
  });

  it("keeps the generic message when the failure is not a rate limit", () => {
    const message = formatRateLimitMessage({
      isRateLimited: false,
      remaining: 4999,
      resetAtMs: 1_893_456_000_000,
    });
    expect(message).toBe("GitHub request failed");
  });
});

describe("errorMessage — error normalization", () => {
  it("extracts the message from an Error instance", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("passes a bare string through", () => {
    expect(errorMessage("network down")).toBe("network down");
  });

  it("reads the message field of an error-shaped object", () => {
    expect(errorMessage({ message: "shaped" })).toBe("shaped");
  });

  it("falls back for a shapeless non-error value", () => {
    expect(errorMessage(42)).toBe("42");
    // Non-object values are stringified (`toErrorLike` wraps them); only an
    // object without a message field reaches the "unknown error" fallback.
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage({ status: 500 })).toBe("unknown error");
  });
});
