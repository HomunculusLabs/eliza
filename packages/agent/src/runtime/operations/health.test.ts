/**
 * Verifies health reports preserve safe failure categories under redaction and
 * apply configuration-owned capability policy before invoking provider checks.
 */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { HealthChecker } from "./health.ts";
import { providerSmokeCheck } from "./health-checks.ts";

describe("HealthChecker capability policy", () => {
  it("skips provider smoke only when text generation is explicitly not expected", async () => {
    const useModel = vi.fn(async () => {
      throw new Error("no provider should be invoked");
    });
    const checker = new HealthChecker();
    checker.register(providerSmokeCheck);

    const report = await checker.runForRuntime(
      { getSetting: () => "pi", useModel } as unknown as AgentRuntime,
      { expectedTextProvider: false },
    );

    expect(report).toEqual({
      passed: [],
      skipped: [
        {
          name: "provider-smoke",
          reason: "text provider is not expected by this configuration",
        },
      ],
      failed: [],
      ok: true,
    });
    expect(useModel).not.toHaveBeenCalled();
  });

  it("retains a safe provider category while redacting arbitrary failure detail", async () => {
    const secretBearingError = Object.assign(
      new Error("upstream detail must not persist"),
      { code: "PI_CREDENTIAL_MISSING" },
    );
    const checker = new HealthChecker();
    checker.register(providerSmokeCheck);

    const report = await checker.runForRuntime(
      {
        getSetting: () => "pi",
        useModel: vi.fn(async () => {
          throw secretBearingError;
        }),
      } as unknown as AgentRuntime,
      { expectedTextProvider: true, redactFailureDetail: true },
    );

    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "provider-smoke",
        code: "provider-credential-missing",
        reason: "Runtime health check failed",
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(secretBearingError.message);
  });

  it("pins provider smoke to the selected runtime provider", async () => {
    const useModel = vi.fn(
      async (_modelType: string, _params: unknown, provider?: string) => {
        if (provider === "pi") {
          throw new Error("selected provider is unavailable");
        }
        return "backup-provider-response";
      },
    );
    const checker = new HealthChecker();
    checker.register(providerSmokeCheck);

    const report = await checker.runForRuntime(
      {
        getSetting: () => "pi",
        useModel,
      } as unknown as AgentRuntime,
      { expectedTextProvider: true },
    );

    expect(useModel).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ prompt: "ping" }),
      "pi",
    );
    expect(report.ok).toBe(false);
    expect(report.failed).toEqual([
      expect.objectContaining({
        name: "provider-smoke",
        code: "provider-unreachable",
      }),
    ]);
  });
});
