/**
 * HealthChecker — the runtime-operations health gate.
 *
 * Hot/warm strategies call `runForRuntime(newRuntime)` after applying their
 * change. Cold hosts invoke it against an initialized candidate before
 * publication. Promotion is allowed only when every REQUIRED check passes.
 * Optional checks surface in `failed[]` but never flip `ok` to false.
 *
 * Execution model:
 *   - All registered checks run in parallel (Promise.allSettled).
 *   - Each check's `run(runtime)` is wrapped in a Promise.race against a
 *     per-check timeout sentinel (`check.timeoutMs`).
 *   - One slow optional check cannot block required checks from finishing.
 *
 * Logging prefix: `[runtime-ops:health]`.
 */

import { type AgentRuntime, logger } from "@elizaos/core";
import { builtInHealthChecks, describeError } from "./health-checks.ts";
import type {
  HealthCheck,
  HealthCheckFailureCode,
  HealthCheckReport,
  HealthCheckResult,
} from "./types.ts";

const LOG_PREFIX = "[runtime-ops:health]";

interface CheckOutcome {
  name: string;
  required: boolean;
  durationMs: number;
  result: HealthCheckResult;
}

export interface HealthCheckRunOptions {
  /** Replace arbitrary check reasons before they reach logs or operation JSON. */
  redactFailureDetail?: boolean;
  /** Whether the configuration being validated promises a text provider. */
  expectedTextProvider?: boolean;
}

export class HealthChecker {
  private readonly checks = new Map<string, HealthCheck>();

  register(check: HealthCheck): void {
    if (!check || typeof check.name !== "string" || check.name.length === 0) {
      throw new Error(`${LOG_PREFIX} register: check.name is required`);
    }
    if (typeof check.run !== "function") {
      throw new Error(
        `${LOG_PREFIX} register: check.run must be a function (${check.name})`,
      );
    }
    if (typeof check.timeoutMs !== "number" || check.timeoutMs <= 0) {
      throw new Error(
        `${LOG_PREFIX} register: check.timeoutMs must be > 0 (${check.name})`,
      );
    }
    this.checks.set(check.name, check);
  }

  unregister(name: string): void {
    this.checks.delete(name);
  }

  /** Internal — exposed for tests so they can assert deterministic state. */
  list(): readonly HealthCheck[] {
    return Array.from(this.checks.values());
  }

  async runForRuntime(
    runtime: AgentRuntime,
    options: HealthCheckRunOptions = {},
  ): Promise<HealthCheckReport> {
    const skipped: { name: string; reason: string }[] = [];
    const registered = Array.from(this.checks.values()).filter((check) => {
      if (
        check.capability === "text-generation" &&
        options.expectedTextProvider === false
      ) {
        skipped.push({
          name: check.name,
          reason: "text provider is not expected by this configuration",
        });
        return false;
      }
      return true;
    });
    if (registered.length === 0) {
      return { passed: [], skipped, failed: [], ok: true };
    }

    const settled = await Promise.allSettled(
      registered.map((check) => runOne(check, runtime)),
    );

    const passed: { name: string; durationMs: number }[] = [];
    const failed: {
      name: string;
      required: boolean;
      code?: HealthCheckFailureCode;
      reason: string;
      durationMs: number;
    }[] = [];

    settled.forEach((res, idx) => {
      const check = registered[idx];
      if (res.status === "fulfilled") {
        const { name, required, durationMs, result } = res.value;
        if (result.ok === true) {
          passed.push({ name, durationMs });
        } else {
          failed.push({
            name,
            required,
            ...(result.code ? { code: result.code } : {}),
            reason: options.redactFailureDetail
              ? "Runtime health check failed"
              : result.reason,
            durationMs,
          });
        }
      } else {
        // Should never hit — runOne catches everything — but fail safe.
        failed.push({
          name: check.name,
          required: check.required,
          reason: options.redactFailureDetail
            ? "Runtime health check failed"
            : `internal: ${describeError(res.reason)}`,
          durationMs: 0,
        });
      }
    });

    const ok = failed.every((f) => f.required === false);

    if (failed.length > 0) {
      logger.warn(
        `${LOG_PREFIX} report ok=${ok} passed=${passed.length} failed=${failed.length}`,
      );
      for (const f of failed) {
        logger.warn(
          `${LOG_PREFIX} failed name=${f.name} required=${f.required} reason=${f.reason} durationMs=${f.durationMs}`,
        );
      }
    } else {
      logger.debug(
        `${LOG_PREFIX} report ok=true passed=${passed.length} failed=0`,
      );
    }

    return { passed, skipped, failed, ok };
  }
}

async function runOne(
  check: HealthCheck,
  runtime: AgentRuntime,
): Promise<CheckOutcome> {
  const startedAt = Date.now();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<HealthCheckResult>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve({
        ok: false,
        reason: `timeout after ${check.timeoutMs}ms`,
      });
    }, check.timeoutMs);
  });

  try {
    const result = await Promise.race<HealthCheckResult>([
      Promise.resolve()
        .then(() => check.run(runtime))
        .catch(
          (err): HealthCheckResult => ({
            ok: false,
            reason: `threw: ${describeError(err)}`,
            cause: err,
          }),
        ),
      timeoutPromise,
    ]);

    return {
      name: check.name,
      required: check.required,
      durationMs: Date.now() - startedAt,
      result,
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Default singleton. Lazy, swappable in tests.
// ---------------------------------------------------------------------------

let cachedDefault: HealthChecker | null = null;

/**
 * Lazy per-process singleton, pre-registered with the four built-in checks.
 * Tests can construct their own `HealthChecker` directly.
 */
export function getDefaultHealthChecker(): HealthChecker {
  if (!cachedDefault) {
    const checker = new HealthChecker();
    for (const check of builtInHealthChecks) {
      checker.register(check);
    }
    cachedDefault = checker;
  }
  return cachedDefault;
}
