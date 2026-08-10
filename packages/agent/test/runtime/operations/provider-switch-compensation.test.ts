/**
 * Verifies Pi provider switches use cold restart and compensate an accepted
 * config mutation when that restart fails. The real operation manager and
 * filesystem repository run against deterministic fake runtimes/strategies.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyOperation,
  defaultClassifier,
} from "../../../src/runtime/operations/classifier.ts";
import { HealthChecker } from "../../../src/runtime/operations/health.ts";
import { DefaultRuntimeOperationManager } from "../../../src/runtime/operations/manager.ts";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.ts";
import type { ReloadStrategy } from "../../../src/runtime/operations/types.ts";

let stateDir: string;
let repository: FilesystemRuntimeOperationRepository;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pi-switch-compensation-"));
  repository = new FilesystemRuntimeOperationRepository(stateDir, {
    retentionMs: 60_000,
    maxRecords: 20,
  });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("Pi provider-switch restart policy", () => {
  it("classifies every switch to, from, or within Pi as cold", () => {
    expect(
      classifyOperation(
        { kind: "provider-switch", provider: "pi" },
        { currentProvider: "openai" },
      ),
    ).toBe("cold");
    expect(
      classifyOperation(
        { kind: "provider-switch", provider: "openai" },
        { currentProvider: "pi" },
      ),
    ).toBe("cold");
    expect(
      classifyOperation(
        {
          kind: "provider-switch",
          provider: "pi",
          primaryModel: "anthropic/claude-sonnet-4-5",
        },
        { currentProvider: "pi" },
      ),
    ).toBe("cold");
  });

  it("restarts from the actual surviving runtime after an initial strategy failure", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const survivingRuntime = {
      marker: "surviving",
    } as unknown as AgentRuntime;
    let currentRuntime = oldRuntime;
    const strategyInputs: AgentRuntime[] = [];
    const events: string[] = [];
    let restartAttempts = 0;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        strategyInputs.push(context.runtime);
        events.push(`restart-${restartAttempts}`);
        if (restartAttempts === 1) {
          currentRuntime = survivingRuntime;
          throw new Error("target runtime restart failed");
        }
        await context.reportPhase({
          name: "cold-restart",
          status: "succeeded",
          startedAt: 2,
          finishedAt: 3,
        });
        return survivingRuntime;
      },
    };
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => currentRuntime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: { cold: coldStrategy },
    });

    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      prepare: async () => {
        events.push("prepare-target-config");
        return undefined;
      },
      compensation: {
        restore: async () => {
          events.push("restore-previous-config");
        },
        restartPreviousRuntime: true,
      },
    });

    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await vi.waitFor(async () => {
      expect((await manager.get(outcome.operation.id))?.status).toBe("failed");
    });

    const operation = await manager.get(outcome.operation.id);
    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, survivingRuntime]);
    expect(events).toEqual([
      "prepare-target-config",
      "restart-1",
      "restore-previous-config",
      "restart-2",
    ]);
    expect(operation?.tier).toBe("cold");
    expect(operation?.status).toBe("failed");
    expect(operation?.error).toMatchObject({
      code: "strategy-failed",
      message: "target runtime restart failed",
    });
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "restore-config",
          status: "succeeded",
        }),
        expect.objectContaining({
          name: "rollback-restart",
          status: "succeeded",
        }),
      ]),
    );
  });

  it("uses the newly returned runtime for rollback after a thrown health gate", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const newRuntime = { marker: "new" } as unknown as AgentRuntime;
    const recoveredRuntime = {
      marker: "recovered",
    } as unknown as AgentRuntime;
    const strategyInputs: AgentRuntime[] = [];
    let restartAttempts = 0;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        strategyInputs.push(context.runtime);
        await context.reportPhase({
          name: "cold-restart",
          status: "succeeded",
          startedAt: restartAttempts,
          finishedAt: restartAttempts,
        });
        return restartAttempts === 1 ? newRuntime : recoveredRuntime;
      },
    };
    const healthChecker = new HealthChecker();
    vi.spyOn(healthChecker, "runForRuntime").mockRejectedValueOnce(
      new Error("health infrastructure failed"),
    );
    const restore = vi.fn(async () => {});
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => oldRuntime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker,
      strategies: { cold: coldStrategy },
    });

    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: { restore, restartPreviousRuntime: true },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await vi.waitFor(async () => {
      expect((await manager.get(outcome.operation.id))?.status).toBe("failed");
    });

    const operation = await manager.get(outcome.operation.id);
    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, newRuntime]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(operation?.error).toMatchObject({
      code: "health-check-failed",
      message: "Health check failed: health infrastructure failed",
    });
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "health-check", status: "failed" }),
        expect.objectContaining({
          name: "restore-config",
          status: "succeeded",
        }),
        expect.objectContaining({
          name: "rollback-restart",
          status: "succeeded",
        }),
      ]),
    );
  });

  it("uses the newly returned runtime after a negative health report", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const newRuntime = { marker: "new" } as unknown as AgentRuntime;
    const strategyInputs: AgentRuntime[] = [];
    let restartAttempts = 0;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        strategyInputs.push(context.runtime);
        await context.reportPhase({
          name: "cold-restart",
          status: "succeeded",
          startedAt: restartAttempts,
          finishedAt: restartAttempts,
        });
        return newRuntime;
      },
    };
    const healthChecker = new HealthChecker();
    healthChecker.register({
      name: "required-provider",
      required: true,
      timeoutMs: 100,
      run: async () => ({ ok: false, reason: "provider unavailable" }),
    });
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => oldRuntime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker,
      strategies: { cold: coldStrategy },
    });

    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: {
        restore: async () => {},
        restartPreviousRuntime: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await vi.waitFor(async () => {
      expect((await manager.get(outcome.operation.id))?.status).toBe("failed");
    });

    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, newRuntime]);
    expect((await manager.get(outcome.operation.id))?.error).toMatchObject({
      code: "health-check-failed",
      message: "Required health checks failed",
    });
  });

  it("preserves a persistence failure when restoring unaccepted config also fails", async () => {
    const persistenceError = new Error("operation store unavailable");
    vi.spyOn(repository, "create").mockRejectedValueOnce(persistenceError);
    const restore = vi.fn(async () => {
      throw new Error("config restore unavailable");
    });
    const runtime = {} as AgentRuntime;
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {},
    });

    await expect(
      manager.start({
        intent: {
          kind: "provider-switch",
          provider: "pi",
          primaryModel: "openai/gpt-5.4-mini",
        },
        compensation: { restore, restartPreviousRuntime: true },
      }),
    ).rejects.toMatchObject({
      code: "RUNTIME_OPERATION_PERSIST_FAILED",
      cause: persistenceError,
      context: {
        restoreError: "config restore unavailable",
      },
    });
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it("records a terminal rollback phase when recovery throws before reporting", async () => {
    const runtime = {} as AgentRuntime;
    let restartAttempts = 0;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async () => {
        restartAttempts += 1;
        throw new Error(
          restartAttempts === 1 ? "target restart failed" : "rollback failed",
        );
      },
    };
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: { cold: coldStrategy },
    });

    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: {
        restore: async () => {},
        restartPreviousRuntime: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await vi.waitFor(async () => {
      expect((await manager.get(outcome.operation.id))?.status).toBe("failed");
    });

    expect(restartAttempts).toBe(2);
    expect((await manager.get(outcome.operation.id))?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollback-restart",
          status: "failed",
          error: { message: "rollback failed" },
        }),
      ]),
    );
  });
});
