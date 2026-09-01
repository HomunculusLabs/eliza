/**
 * Ordered best-effort teardown runner for real-PostgreSQL integration cases.
 *
 * Integration cases that open dedicated `pg` clients wrap their primary
 * assertions in `runCaseWithOrderedTeardown`: the primary body runs first and
 * every teardown step (rollback, then each client close) runs afterwards in the
 * declared order, even when an earlier step fails. A failed teardown step is
 * logged at warn and retained as an ordered diagnostic — it never masks the
 * primary failure, and a teardown-only failure still fails the case so a lost
 * `ROLLBACK` cannot vanish silently. The unit contract lives in
 * `postgres-case-teardown.test.ts`; consumers are the real-PostgreSQL
 * integration suites (e.g. the capacity recount proofs).
 */

/** A single ordered teardown action with a stable diagnostic name. */
export interface TeardownStep {
  readonly name: string;
  readonly run: () => Promise<void>;
}

/** One teardown step failure, in execution order. */
export interface TeardownFailure {
  readonly step: string;
  readonly error: unknown;
}

/** Thrown when the primary body succeeded but teardown steps failed. */
export class TeardownFailedError extends Error {
  readonly failures: readonly TeardownFailure[];

  constructor(failures: readonly TeardownFailure[]) {
    super(`teardown failed: ${failures.map((f) => `${f.step} (${describe(f.error)})`).join("; ")}`);
    this.name = "TeardownFailedError";
    this.failures = failures;
  }
}

const teardownFailuresKey = Symbol("teardownFailures");

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One logical teardown step whose independent actions run in parallel.
 *
 * Every action is attempted even when another rejects; failures are collected
 * in input order and reported as a single step failure, so neither a
 * `Promise.all` first-rejection (drops the second) nor sequencing (a hung
 * first close delays the second) loses or delays the rest. Use for closing
 * independent clients after rollback.
 */
export function parallelTeardownStep(
  name: string,
  actions: readonly { readonly label: string; readonly run: () => Promise<void> }[],
): TeardownStep {
  return {
    name,
    run: async () => {
      // Promise.resolve().then() wraps each action so a synchronously throwing
      // run() becomes a rejection instead of aborting the map loop — every
      // action is attempted even when another throws or rejects.
      const results = await Promise.allSettled(
        actions.map((action) => Promise.resolve().then(action.run)),
      );
      const failed = results
        .map((result, index) => ({ result, label: actions[index]!.label }))
        .filter((entry) => entry.result.status === "rejected")
        .map((entry) => ({
          label: entry.label,
          reason: (entry.result as PromiseRejectedResult).reason,
        }));
      if (failed.length > 0) {
        throw new Error(
          `${name}: ${failed.map((f) => `${f.label} (${describe(f.reason)})`).join("; ")}`,
        );
      }
    },
  };
}

/**
 * Ordered teardown failures attached to a rethrown primary error, if any were
 * recorded (empty array when teardown was clean).
 */
export function teardownFailuresOf(error: unknown): readonly TeardownFailure[] {
  if (error !== null && typeof error === "object") {
    const attached = (error as { [teardownFailuresKey]?: readonly TeardownFailure[] })[
      teardownFailuresKey
    ];
    if (attached) return attached;
  }
  return [];
}

/**
 * Run `primary`, then run every teardown step in order regardless of the
 * primary outcome. Behavior:
 *
 * - primary failure → the ORIGINAL error is rethrown unchanged; teardown
 *   failures are attached via `teardownFailuresOf(error)` and logged at warn.
 * - primary success + teardown failure → `TeardownFailedError` lists the
 *   failures in execution order.
 * - all clean → resolves normally.
 */
export async function runCaseWithOrderedTeardown(
  primary: () => Promise<void>,
  teardown: readonly TeardownStep[],
): Promise<void> {
  let primaryError: unknown;
  let primarySucceeded = false;
  try {
    await primary();
    primarySucceeded = true;
  } catch (error) {
    primaryError = error;
  }

  const failures: TeardownFailure[] = [];
  for (const step of teardown) {
    try {
      await step.run();
    } catch (error) {
      // error-policy:J6 teardown-only failure is logged at warn and retained as
      // an ordered diagnostic; it never masks the primary failure.
      failures.push({ step: step.name, error });
    }
  }

  // The report-and-attach tail must never displace the primary error. A
  // hostile rejection value (null-prototype object with a throwing
  // `toString`, a Proxy whose `defineProperty` trap throws) can make describe
  // or the property attachment throw; this entire tail is best-effort.
  // error-policy:J6 diagnostic reporting failure is logged at debug and
  // swallowed — the primary (or TeardownFailedError) outcome must survive.
  let reported = false;
  try {
    if (failures.length > 0) {
      console.warn("[postgres case teardown] step failures (ordered)", {
        failures: failures.map((f) => ({
          step: f.step,
          error: describe(f.error),
          stack: f.error instanceof Error ? f.error.stack : undefined,
        })),
      });
    }
    if (!primarySucceeded) {
      // Attach only when the rejection can safely carry the property:
      // primitives cannot, and a frozen/sealed Error must still rethrow with
      // its identity intact — an attachment failure here would mask the
      // primary error, the exact bug class this helper exists to eliminate.
      // The warn log above always carries the diagnostics regardless.
      if (
        primaryError !== null &&
        typeof primaryError === "object" &&
        Object.isExtensible(primaryError)
      ) {
        Object.defineProperty(primaryError, teardownFailuresKey, {
          value: failures,
          configurable: true,
          enumerable: false,
          writable: false,
        });
      }
    }
    reported = true;
  } catch (reportError) {
    console.debug("[postgres case teardown] diagnostic reporting failed", {
      reportError: describe(reportError),
    });
  }
  if (!reported && failures.length > 0 && primarySucceeded) {
    // Reporting failed on the teardown-only path: still surface that teardown
    // failed. Deliberately not TeardownFailedError — its constructor formats
    // each failure and the same hostile value would throw again.
    throw new Error(
      `postgres case teardown failed (${failures.length} step(s)); diagnostics unavailable — see the debug log`,
    );
  }
  if (!reported && failures.length > 0 && !primarySucceeded) {
    // Reporting failed on the primary-failure path: the primary wins; the
    // step failure details are only in the debug log above.
    throw primaryError;
  }
  if (!primarySucceeded) {
    throw primaryError;
  }
  if (failures.length > 0) {
    throw new TeardownFailedError(failures);
  }
}
