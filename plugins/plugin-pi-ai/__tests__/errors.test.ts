/**
 * Table-driven error taxonomy coverage proves only transient pre-commit
 * failures enter the generic runtime fallback seam.
 */
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { isModelProviderFallbackError } from "../../../packages/core/src/services/message/fallback-reply.js";
import { mapPiError } from "../models/errors.js";

function mapped(
  error: unknown,
  overrides: Partial<Parameters<typeof mapPiError>[1]> = {},
) {
  return mapPiError(error, {
    provider: "openai",
    qualifiedModel: "openai/gpt-5.4-mini",
    committed: false,
    ...overrides,
  });
}

describe("Pi error fallback taxonomy", () => {
  it.each([
    [429, "PI_PROVIDER_RATE_LIMITED"],
    [500, "PI_PROVIDER_UNAVAILABLE"],
    [502, "PI_PROVIDER_UNAVAILABLE"],
    [503, "PI_PROVIDER_UNAVAILABLE"],
    [504, "PI_PROVIDER_UNAVAILABLE"],
    [529, "PI_PROVIDER_UNAVAILABLE"],
  ] as const)(
    "classifies pre-commit HTTP %s as fallback eligible",
    (status, code) => {
      const cause = Object.assign(new Error(`HTTP ${status}`), {
        status,
        headers: { "retry-after": "7" },
      });
      const error = mapped(cause);
      expect(error).toMatchObject({ code, cause });
      expect(error.context).toMatchObject({
        provider: "openai",
        qualifiedModel: "openai/gpt-5.4-mini",
        status,
        retryAfter: "7",
        committed: false,
      });
      expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
        true,
      );
    },
  );

  it.each([
    [401, "PI_PROVIDER_AUTH_FAILED"],
    [403, "PI_PROVIDER_AUTH_FAILED"],
    [400, "PI_STREAM_TERMINATED"],
    [404, "PI_STREAM_TERMINATED"],
  ] as const)("keeps pre-commit HTTP %s out of fallback", (status, code) => {
    const error = mapped(
      Object.assign(new Error(`HTTP ${status}`), { status }),
    );
    expect(error).toMatchObject({ code });
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      false,
    );
  });

  it.each([
    "request timed out",
    "ECONNRESET before headers",
    "socket hang up",
    "temporarily unavailable",
  ])("classifies confirmed no-output transport failures: %s", (message) => {
    const error = mapped(new Error(message));
    expect(error).toMatchObject({ code: "PI_PROVIDER_UNAVAILABLE" });
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      true,
    );
  });

  it("turns every committed transient failure into a non-fallback stream error", () => {
    const cause = Object.assign(new Error("HTTP 503 unavailable"), {
      status: 503,
    });
    const error = mapped(cause, { committed: true });
    expect(error).toMatchObject({ code: "PI_STREAM_TERMINATED", cause });
    expect(error.context).toMatchObject({ status: 503, committed: true });
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      false,
    );
  });

  it("never falls back for caller cancellation or lifecycle disposal", () => {
    const controller = new AbortController();
    controller.abort(new Error("caller stopped"));
    const cancelled = mapped(new Error("HTTP 503"), {
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ code: "PI_CANCELLED" });
    expect(isModelProviderFallbackError(cancelled, ModelType.TEXT_SMALL)).toBe(
      false,
    );

    const disposed = mapped(new Error("HTTP 503"), { disposed: true });
    expect(disposed).toMatchObject({ code: "PI_DISPOSED" });
    expect(isModelProviderFallbackError(disposed, ModelType.TEXT_SMALL)).toBe(
      false,
    );
  });

  it("preserves structural diagnostics without copying request-bearing error bodies", () => {
    const cause = Object.assign(new Error("secret request body"), {
      statusCode: 429,
      retryAfter: 3,
      request: { headers: { authorization: "Bearer secret" } },
    });
    const error = mapped(cause);
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({
      provider: "openai",
      qualifiedModel: "openai/gpt-5.4-mini",
      status: 429,
      retryAfter: 3,
      committed: false,
    });
    expect(JSON.stringify(error.context)).not.toContain("secret");
  });
});
