/**
 * Built-in health checks used by the runtime-operations health gate.
 *
 * Each check is a small, self-contained `HealthCheck`. The `HealthChecker`
 * (in `health.ts`) runs them in parallel with per-check timeouts; required
 * checks block promotion of a new/re-initialised runtime.
 *
 * Conventions:
 *   - No shared mutable state across checks.
 *   - Logger only (`[runtime-ops:health-checks]`).
 *   - Treat optional/missing runtime surface as "not applicable, ok".
 *   - Treat real failures (DB ping false, provider unreachable) as failures.
 */

import { type AgentRuntime, logger, ModelType } from "@elizaos/core";
import { isInsufficientCreditsError } from "../../api/credit-detection.ts";
import { probeRuntimeDatabaseLiveness } from "../../api/database-liveness.ts";
import type {
  HealthCheck,
  HealthCheckFailureCode,
  HealthCheckResult,
} from "./types.ts";

const LOG_PREFIX = "[runtime-ops:health-checks]";

// ---------------------------------------------------------------------------
// Runtime guards — keep us off `any` while accommodating partial typings.
// ---------------------------------------------------------------------------

interface ServiceRegistryLike {
  getRegisteredServiceTypes?: () => readonly string[];
  getServiceRegistrationStatus?: (
    serviceType: string,
  ) => "pending" | "registering" | "registered" | "failed" | "unknown";
}

function asServiceRegistry(runtime: AgentRuntime): ServiceRegistryLike {
  return runtime as AgentRuntime & ServiceRegistryLike;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function providerFailureCode(
  err: unknown,
): Extract<HealthCheckFailureCode, `provider-${string}`> {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "PI_CREDENTIAL_MISSING") {
    return "provider-credential-missing";
  }
  if (
    code === "PI_MODEL_NOT_CONFIGURED" ||
    code === "PI_INVALID_MODEL_ID" ||
    code === "PI_UNKNOWN_PROVIDER"
  ) {
    return "provider-configuration-invalid";
  }
  const message = describeError(err);
  if (message.includes("[trajectory-strict]")) {
    return "provider-policy-rejected";
  }
  return "provider-unreachable";
}

// ---------------------------------------------------------------------------
// runtimeReadyCheck — character + agentId populated.
// ---------------------------------------------------------------------------

export const runtimeReadyCheck: HealthCheck = {
  name: "runtime-ready",
  required: true,
  timeoutMs: 1000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    if (!runtime || typeof runtime !== "object") {
      return {
        ok: false,
        code: "runtime-invalid",
        reason: "runtime is not an object",
      };
    }
    const agentId = runtime.agentId;
    if (typeof agentId !== "string" || agentId.length === 0) {
      return {
        ok: false,
        code: "runtime-invalid",
        reason: "runtime.agentId is empty",
      };
    }
    const character = runtime.character;
    if (!character || typeof character !== "object") {
      return {
        ok: false,
        code: "runtime-invalid",
        reason: "runtime.character is missing",
      };
    }
    const name =
      typeof character.name === "string" ? character.name.trim() : "";
    if (name.length === 0) {
      return {
        ok: false,
        code: "runtime-invalid",
        reason: "runtime.character.name is empty",
      };
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// essentialServicesCheck — no registered service is in a failed state.
// ---------------------------------------------------------------------------

export const essentialServicesCheck: HealthCheck = {
  name: "essential-services",
  required: true,
  timeoutMs: 2000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    const reg = asServiceRegistry(runtime);
    if (typeof reg.getRegisteredServiceTypes !== "function") {
      // Older runtime build without the enumeration API. Cannot enforce
      // anything reliably — silent pass beats a wrong fail.
      logger.debug(
        `${LOG_PREFIX} runtime.getRegisteredServiceTypes unavailable; skipping`,
      );
      return { ok: true };
    }

    const types = reg.getRegisteredServiceTypes();
    if (!Array.isArray(types) || types.length === 0) {
      return { ok: true };
    }

    if (typeof reg.getServiceRegistrationStatus !== "function") {
      return { ok: true };
    }

    for (const type of types) {
      const status = reg.getServiceRegistrationStatus(type);
      if (status === "failed") {
        return {
          ok: false,
          code: "service-failed",
          reason: `service ${type} is in failed state`,
        };
      }
    }
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// dbConnectionCheck — adapter.isReady() returns true (when adapter exists).
// ---------------------------------------------------------------------------

export const dbConnectionCheck: HealthCheck = {
  name: "db-connection",
  required: true,
  timeoutMs: 1500,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    const liveness = await probeRuntimeDatabaseLiveness(runtime);
    if (liveness.ok) return { ok: true };
    if (liveness.status === "unknown") return { ok: true };
    return {
      ok: false,
      code: "database-unavailable",
      reason: `${liveness.status}: ${liveness.message ?? "database probe failed"}`,
    };
  },
};

// ---------------------------------------------------------------------------
// providerSmokeCheck — minimal useModel call to confirm the provider
// pipeline is wired and reachable.
// ---------------------------------------------------------------------------

export const providerSmokeCheck: HealthCheck = {
  name: "provider-smoke",
  capability: "text-generation",
  required: true,
  timeoutMs: 5000,
  async run(runtime: AgentRuntime): Promise<HealthCheckResult> {
    if (typeof runtime.useModel !== "function") {
      // Older / stripped runtime — no model surface to probe.
      return { ok: true };
    }
    try {
      const configuredProvider = runtime.getSetting("ELIZA_BRAIN_PROVIDER");
      const expectedProvider =
        typeof configuredProvider === "string" &&
        configuredProvider.trim().length > 0
          ? configuredProvider.trim()
          : undefined;
      // Tiny, deterministic prompt with a hard 1-token cap. Empty completions
      // still count as "model responded" — we only need transport health.
      await runtime.useModel(
        ModelType.TEXT_SMALL,
        {
          prompt: "ping",
          maxTokens: 1,
          temperature: 0,
        },
        expectedProvider,
      );
      return { ok: true };
    } catch (err) {
      if (isInsufficientCreditsError(err)) {
        return {
          ok: false,
          code: "provider-quota-exhausted",
          reason: "provider quota exhausted",
          cause: err,
        };
      }
      const name = err instanceof Error ? err.name : "";
      // The AI SDK throws AI_NoOutputGeneratedError when the model returned
      // zero tokens. That's still a healthy transport: the request reached
      // the provider, the provider replied, just with no text. Treat as ok.
      if (name === "AI_NoOutputGeneratedError") {
        return { ok: true };
      }
      return {
        ok: false,
        code: providerFailureCode(err),
        reason: `provider unreachable: ${describeError(err)}`,
        cause: err,
      };
    }
  },
};

/**
 * The full set of built-in checks pre-registered by the default checker.
 * Order is not significant — checks run in parallel.
 */
export const builtInHealthChecks: readonly HealthCheck[] = [
  runtimeReadyCheck,
  essentialServicesCheck,
  dbConnectionCheck,
  providerSmokeCheck,
];
