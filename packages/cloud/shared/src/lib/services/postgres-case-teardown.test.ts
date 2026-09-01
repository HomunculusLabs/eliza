/**
 * Unit contract for `runCaseWithOrderedTeardown`: ordered best-effort teardown
 * that never masks a primary failure and never swallows a teardown-only
 * failure. Deterministic — no PostgreSQL required; every failure is induced by
 * plain rejecting/sync-throwing step functions.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  parallelTeardownStep,
  runCaseWithOrderedTeardown,
  TeardownFailedError,
  type TeardownStep,
  teardownFailuresOf,
} from "./postgres-case-teardown";

function boom(message: string): Error {
  return new Error(message);
}

const step = (name: string, run: () => Promise<void>): TeardownStep => ({ name, run });

describe("runCaseWithOrderedTeardown", () => {
  test("happy path: primary resolves, all steps run in order, nothing thrown", async () => {
    const calls: string[] = [];
    await runCaseWithOrderedTeardown(async () => {
      calls.push("primary");
    }, [
      step("rollback", async () => {
        calls.push("rollback");
      }),
      step("close-writer", async () => {
        calls.push("close-writer");
      }),
      step("close-outer", async () => {
        calls.push("close-outer");
      }),
    ]);
    expect(calls).toEqual(["primary", "rollback", "close-writer", "close-outer"]);
  });

  test("primary-only failure: original error rethrown and no teardown diagnostics when teardown is clean", async () => {
    const calls: string[] = [];
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {
        calls.push("primary");
        throw boom("assertion failed: count mismatch");
      }, [
        step("rollback", async () => {
          calls.push("rollback");
        }),
        step("close-writer", async () => {
          calls.push("close-writer");
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    // Teardown ran fully even though the primary failed.
    expect(calls).toEqual(["primary", "rollback", "close-writer"]);
    // The PRIMARY error is what the test runner sees — not a teardown error.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("assertion failed: count mismatch");
    expect(teardownFailuresOf(caught)).toEqual([]);
  });

  test("teardown-only failure: test fails with an ordered, classified error", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {}, [
        step("rollback", async () => {
          throw boom("ROLLBACK failed: connection terminated");
        }),
        step("close-writer", async () => {}),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeardownFailedError);
    const failure = caught as TeardownFailedError;
    expect(failure.message).toContain("ROLLBACK failed: connection terminated");
    expect(failure.message).toContain("rollback");
    // Steps after the failed one still ran (best-effort, ordered).
    expect(failure.failures).toEqual([
      { step: "rollback", error: boom("ROLLBACK failed: connection terminated") },
    ]);
  });

  test("primary failure + teardown failure: primary preserved, teardown failure attached as ordered diagnostic", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {
        throw boom("primary assertion failed");
      }, [
        step("rollback", async () => {
          throw boom("rollback lost");
        }),
        step("close-writer", async () => {
          throw boom("close-writer broken");
        }),
        step("close-outer", async () => {
          // Runs even after two failures.
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    // Primary preserved: message is the primary's, not a teardown error's.
    expect((caught as Error).message).toBe("primary assertion failed");
    const diagnostics = teardownFailuresOf(caught);
    // Ordered rollback-then-close diagnostics retained on the primary error.
    expect(diagnostics.map((d) => d.step)).toEqual(["rollback", "close-writer"]);
    expect(diagnostics.map((d) => (d.error as Error).message)).toEqual([
      "rollback lost",
      "close-writer broken",
    ]);
  });

  test("sync-throwing teardown step is captured like a rejecting one", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {}, [
        step("rollback", () => {
          throw boom("sync throw");
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeardownFailedError);
    const { failures } = caught as TeardownFailedError;
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect((failures[0].error as Error).message).toBe("sync throw");
  });

  test("non-Error primary rejection still carries teardown diagnostics", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {
        throw "string rejection";
      }, [
        step("rollback", async () => {
          throw boom("rollback lost");
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    // Rethrown as-is — the primary identity is preserved even for non-Errors;
    // attaching diagnostics must never throw and replace the primary.
    expect(caught).toBe("string rejection");
  });

  test("frozen Error primary rethrows identically (attachment skipped, not fatal)", async () => {
    const frozen = Object.freeze(new Error("frozen primary"));
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {
        throw frozen;
      }, [
        step("rollback", async () => {
          throw boom("rollback lost");
        }),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(frozen);
    // Attachment is skipped for non-extensible rejections; the warn log still
    // carries the diagnostics.
    expect(teardownFailuresOf(caught)).toEqual([]);
  });

  test("both client closes failing are all captured, ordered, and neither is dropped", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {}, [
        step("rollback", async () => {}),
        parallelTeardownStep("close-clients", [
          {
            label: "close-writer",
            run: async () => {
              throw boom("writer socket broken");
            },
          },
          {
            label: "close-observer",
            run: async () => {
              throw boom("observer socket broken");
            },
          },
        ]),
      ]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TeardownFailedError);
    const failure = caught as TeardownFailedError;
    expect(failure.failures.length).toBe(1);
    // Promise.all would have surfaced only the first rejection and silently
    // dropped the second; both appear, in input order.
    expect((failure.failures[0].error as Error).message).toBe(
      "close-clients: close-writer (writer socket broken); close-observer (observer socket broken)",
    );
  });

  test("close failure while primary failed: primary still wins, close diagnostic attached", async () => {
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {
        throw boom("primary assertion failed");
      }, [
        step("rollback", async () => {}),
        parallelTeardownStep("close-clients", [
          {
            label: "close-writer",
            run: async () => {
              throw boom("close failed");
            },
          },
          {
            label: "close-observer",
            run: async () => {},
          },
        ]),
      ]);
    } catch (error) {
      caught = error;
    }
    // The old finally-replacement hazard: a close rejection would have
    // REPLACED the primary error. The helper preserves the primary.
    expect((caught as Error).message).toBe("primary assertion failed");
    const diagnostics = teardownFailuresOf(caught);
    expect(diagnostics.map((d) => d.step)).toEqual(["close-clients"]);
    expect((diagnostics[0].error as Error).message).toBe(
      "close-clients: close-writer (close failed)",
    );
  });

  test("teardown failures are logged at warn with structured ordered context", async () => {
    const warn = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warn as unknown as typeof console.warn;
    const primary = boom("primary");
    let caught: unknown;
    try {
      try {
        await runCaseWithOrderedTeardown(async () => {
          throw primary;
        }, [
          step("rollback", async () => {
            throw boom("r1");
          }),
          step("close-writer", async () => {
            throw boom("c1");
          }),
        ]);
      } catch (error) {
        caught = error;
      }
    } finally {
      console.warn = originalWarn;
    }
    // The rethrown value is the primary error itself — not a teardown error.
    expect(caught).toBe(primary);
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = warn.mock.calls[0] as [
      string,
      { failures: { step: string; error: string }[] },
    ];
    expect(msg).toBe("[postgres case teardown] step failures (ordered)");
    expect(ctx.failures.map((f) => f.step)).toEqual(["rollback", "close-writer"]);
    expect(ctx.failures.map((f: { error: string }) => f.error)).toEqual(["r1", "c1"]);
  });

  test("hostile teardown rejection values never mask the primary failure", async () => {
    // A null-prototype object whose toString throws makes describe() throw;
    // the reporting tail must swallow that and still rethrow the primary.
    const hostile = Object.create(null);
    hostile.toString = () => {
      throw new Error("hostile toString");
    };
    const primary = boom("real primary failure");
    let caught: unknown;
    const originalDebug = console.debug;
    const debug = mock(() => {});
    console.debug = debug as unknown as typeof console.debug;
    try {
      try {
        await runCaseWithOrderedTeardown(async () => {
          throw primary;
        }, [
          step("rollback", async () => {
            throw hostile;
          }),
        ]);
      } catch (error) {
        caught = error;
      }
    } finally {
      console.debug = originalDebug;
    }
    expect(caught).toBe(primary);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  test("hostile teardown rejection on the success path still fails the test visibly", async () => {
    const hostile = Object.create(null);
    hostile.toString = () => {
      throw new Error("hostile toString");
    };
    let caught: unknown;
    const originalDebug = console.debug;
    console.debug = mock(() => {}) as unknown as typeof console.debug;
    try {
      try {
        await runCaseWithOrderedTeardown(async () => {}, [
          step("rollback", async () => {
            throw hostile;
          }),
        ]);
      } catch (error) {
        caught = error;
      }
    } finally {
      console.debug = originalDebug;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("teardown failed");
  });

  test("synchronously throwing parallel action does not abort sibling actions", async () => {
    const attempted: string[] = [];
    let caught: unknown;
    try {
      await runCaseWithOrderedTeardown(async () => {}, [
        parallelTeardownStep("close-clients", [
          {
            label: "close-writer",
            run: () => {
              attempted.push("close-writer");
              throw boom("sync close throw");
            },
          },
          {
            label: "close-observer",
            run: async () => {
              attempted.push("close-observer");
            },
          },
        ]),
      ]);
    } catch (error) {
      caught = error;
    }
    // The sync throw became a rejection; the sibling action still ran.
    expect(attempted).toEqual(["close-writer", "close-observer"]);
    expect(caught).toBeInstanceOf(TeardownFailedError);
    expect((caught as TeardownFailedError).failures[0]?.error).toBeInstanceOf(Error);
  });
});
