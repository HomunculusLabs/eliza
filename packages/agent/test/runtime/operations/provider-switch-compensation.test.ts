/**
 * Verifies Pi provider switches use cold restart and compensate an accepted
 * config mutation when that restart fails. The real operation manager and
 * filesystem repository run against deterministic fake runtimes/strategies.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentRuntime, logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyOperation,
  defaultClassifier,
} from "../../../src/runtime/operations/classifier.ts";
import { HealthChecker } from "../../../src/runtime/operations/health.ts";
import { providerSmokeCheck } from "../../../src/runtime/operations/health-checks.ts";
import { DefaultRuntimeOperationManager } from "../../../src/runtime/operations/manager.ts";
import { FilesystemRuntimeOperationRepository } from "../../../src/runtime/operations/repository.ts";
import type { ReloadStrategy } from "../../../src/runtime/operations/types.ts";
import { createRuntimeCredentialOverlay } from "../../../src/runtime/runtime-settings.ts";

let stateDir: string;
let repository: FilesystemRuntimeOperationRepository;

async function waitForStatus(
  manager: DefaultRuntimeOperationManager,
  operationId: string,
  expected: "failed" | "restart_required" | "succeeded",
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await manager.get(operationId))?.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect((await manager.get(operationId))?.status).toBe(expected);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "pi-switch-compensation-"));
  repository = new FilesystemRuntimeOperationRepository(stateDir, {
    retentionMs: 60_000,
    maxRecords: 20,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    const submittedSecret = "pi-submitted-secret-must-not-leak";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        strategyInputs.push(context.runtime);
        events.push(`restart-${restartAttempts}`);
        if (restartAttempts === 1) {
          currentRuntime = survivingRuntime;
          throw new Error(`target runtime restart failed: ${submittedSecret}`);
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

    await waitForStatus(manager, outcome.operation.id, "failed");

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
      message: "Runtime restart failed",
    });
    const persisted = readFileSync(
      join(stateDir, "runtime-operations", `${outcome.operation.id}.json`),
      "utf8",
    );
    expect(persisted).not.toContain(submittedSecret);
    expect(JSON.stringify(operation)).not.toContain(submittedSecret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(submittedSecret);
    warn.mockRestore();
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
    const submittedSecret = "pi-health-secret-must-not-leak";
    vi.spyOn(healthChecker, "runForRuntime").mockRejectedValueOnce(
      new Error(`health infrastructure failed: ${submittedSecret}`),
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

    await waitForStatus(manager, outcome.operation.id, "failed");

    const operation = await manager.get(outcome.operation.id);
    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, newRuntime]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(operation?.error).toMatchObject({
      code: "health-check-failed",
      message: "Runtime health check failed",
    });
    expect(JSON.stringify(operation)).not.toContain(submittedSecret);
    expect(
      readFileSync(
        join(stateDir, "runtime-operations", `${outcome.operation.id}.json`),
        "utf8",
      ),
    ).not.toContain(submittedSecret);
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
    const submittedSecret = "pi-health-report-secret-must-not-leak";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    healthChecker.register({
      name: "required-provider",
      required: true,
      timeoutMs: 100,
      run: async () => ({
        ok: false,
        reason: `provider unavailable: ${submittedSecret}`,
      }),
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

    await waitForStatus(manager, outcome.operation.id, "restart_required");

    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, newRuntime]);
    const operation = await manager.get(outcome.operation.id);
    expect(operation?.error).toMatchObject({
      code: "health-check-failed",
      message: "Required health checks failed",
    });
    expect(JSON.stringify(operation)).not.toContain(submittedSecret);
    expect(
      readFileSync(
        join(stateDir, "runtime-operations", `${outcome.operation.id}.json`),
        "utf8",
      ),
    ).not.toContain(submittedSecret);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(submittedSecret);
    warn.mockRestore();
  });

  it("rejects an unhealthy cold candidate without restarting the surviving runtime", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const candidateRuntime = {
      marker: "candidate",
    } as unknown as AgentRuntime;
    let currentRuntime = oldRuntime;
    let restartAttempts = 0;
    let published = false;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        await context.validateCandidate?.(candidateRuntime);
        currentRuntime = candidateRuntime;
        published = true;
        return candidateRuntime;
      },
    };
    const healthChecker = new HealthChecker();
    healthChecker.register({
      name: "candidate-health",
      required: true,
      timeoutMs: 100,
      run: async () => ({
        ok: false,
        code: "provider-credential-missing",
        reason: "credential detail must be redacted",
      }),
    });
    const restore = vi.fn(async () => {});
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => currentRuntime,
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
        restore,
        restartPreviousRuntime: true,
        previousRuntimeExpectedTextProvider: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await waitForStatus(manager, outcome.operation.id, "failed");

    const operation = await manager.get(outcome.operation.id);
    expect(restartAttempts).toBe(1);
    expect(published).toBe(false);
    expect(currentRuntime).toBe(oldRuntime);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(operation?.status).toBe("failed");
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "health-check",
          status: "failed",
          detail: expect.objectContaining({
            failed: [
              expect.objectContaining({
                code: "provider-credential-missing",
                reason: "Runtime health check failed",
              }),
            ],
          }),
        }),
      ]),
    );
    expect(operation?.phases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "rollback-restart" }),
      ]),
    );
    expect(JSON.stringify(operation)).not.toContain(
      "credential detail must be redacted",
    );
  });

  it("treats a post-validation swap failure as a strategy failure", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const candidateRuntime = {
      marker: "candidate",
    } as unknown as AgentRuntime;
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
        if (restartAttempts === 1) {
          await context.validateCandidate?.(candidateRuntime);
          throw new Error("swap failed after candidate validation");
        }
        await context.reportPhase({
          name: "cold-restart",
          status: "succeeded",
          startedAt: restartAttempts,
          finishedAt: restartAttempts,
        });
        return recoveredRuntime;
      },
    };
    const restore = vi.fn(async () => {});
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => oldRuntime,
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
        restore,
        restartPreviousRuntime: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await waitForStatus(manager, outcome.operation.id, "failed");

    const operation = await manager.get(outcome.operation.id);
    expect(restartAttempts).toBe(2);
    expect(strategyInputs).toEqual([oldRuntime, oldRuntime]);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(operation?.error).toMatchObject({
      code: "strategy-failed",
      message: "Runtime restart failed",
    });
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "health-check", status: "succeeded" }),
        expect.objectContaining({
          name: "rollback-restart",
          status: "succeeded",
        }),
      ]),
    );
  });

  it("does not require provider smoke for a provider-less restored configuration", async () => {
    const oldRuntime = { marker: "old" } as unknown as AgentRuntime;
    const targetUseModel = vi.fn(async () => "target-ok");
    const rollbackUseModel = vi.fn(async () => {
      throw new Error("rollback intentionally has no text provider");
    });
    const targetRuntime = {
      marker: "target",
      getSetting: () => "pi",
      useModel: targetUseModel,
    } as unknown as AgentRuntime;
    const rollbackRuntime = {
      marker: "rollback",
      useModel: rollbackUseModel,
    } as unknown as AgentRuntime;
    let restartAttempts = 0;
    const coldStrategy: ReloadStrategy = {
      tier: "cold",
      apply: async (context) => {
        restartAttempts += 1;
        await context.reportPhase({
          name: "cold-restart",
          status: "succeeded",
          startedAt: restartAttempts,
          finishedAt: restartAttempts,
        });
        return restartAttempts === 1 ? targetRuntime : rollbackRuntime;
      },
    };
    const healthChecker = new HealthChecker();
    healthChecker.register(providerSmokeCheck);
    healthChecker.register({
      name: "target-only-failure",
      required: true,
      timeoutMs: 100,
      run: async (runtime) =>
        runtime === targetRuntime
          ? { ok: false, reason: "force compensation" }
          : { ok: true },
    });
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => oldRuntime,
      classifyContext: () => ({ currentProvider: undefined }),
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
        previousRuntimeExpectedTextProvider: false,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;

    await waitForStatus(manager, outcome.operation.id, "failed");

    expect(restartAttempts).toBe(2);
    expect(targetUseModel).toHaveBeenCalledTimes(1);
    expect(rollbackUseModel).not.toHaveBeenCalled();
    expect((await manager.get(outcome.operation.id))?.status).toBe("failed");
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

  it("never reruns accepted-only secret preparation for an idempotent duplicate", async () => {
    const runtime = {} as AgentRuntime;
    const prepare = vi.fn(async () => ({
      kind: "provider-switch" as const,
      provider: "pi",
      primaryModel: "openai/gpt-5.4-mini",
      credentialProvider: "openai" as const,
      apiKeyRef: "providers.openai.api-key",
    }));
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        cold: {
          tier: "cold",
          apply: async () => runtime,
        },
      },
    });
    const request = {
      intent: {
        kind: "provider-switch" as const,
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
        credentialProvider: "openai" as const,
      },
      idempotencyKey: "pi-secret-write-once",
      prepare,
    };

    const first = await manager.start(request);
    expect(first.kind).toBe("accepted");
    if (first.kind !== "accepted") return;
    await waitForStatus(manager, first.operation.id, "succeeded");
    const duplicate = await manager.start(request);

    expect(duplicate.kind).toBe("deduped");
    expect(prepare).toHaveBeenCalledOnce();
    if (duplicate.kind === "deduped") {
      expect(duplicate.operation.id).toBe(first.operation.id);
      expect(duplicate.operation.intent).toMatchObject({
        apiKeyRef: "providers.openai.api-key",
      });
    }
  });

  it("compensates and clears Pi execution state after repository failure", async () => {
    const runtime = {} as AgentRuntime;
    const repositorySecret = "repository-secret-must-not-log";
    vi.spyOn(repository, "appendPhase").mockRejectedValueOnce(
      new Error(repositorySecret),
    );
    const restore = vi.fn(async () => {});
    let restartAttempts = 0;
    const errorLog = vi.spyOn(logger, "error").mockImplementation(() => {});
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        cold: {
          tier: "cold",
          apply: async (context) => {
            restartAttempts += 1;
            await context.reportPhase({
              name: "cold-restart",
              status: "succeeded",
            });
            return runtime;
          },
        },
      },
    });
    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      runtimeCredentialOverlay: createRuntimeCredentialOverlay(
        "OPENAI_API_KEY",
        "operation-secret",
      ),
      compensation: { restore, restartPreviousRuntime: true },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    await waitForStatus(manager, outcome.operation.id, "failed");

    expect(restore).toHaveBeenCalledOnce();
    expect(restartAttempts).toBe(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(repositorySecret);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "operation-secret",
    );
  });

  it("sanitizes Pi strategy phases from both target and rollback attempts", async () => {
    const runtime = {} as AgentRuntime;
    const phaseSecret = "phase-secret-must-not-persist";
    let attempts = 0;
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        cold: {
          tier: "cold",
          apply: async (context) => {
            attempts += 1;
            await context.reportPhase({
              name: "cold-restart",
              status: "failed",
              detail: { credential: phaseSecret },
              error: { message: phaseSecret, cause: phaseSecret },
            });
            if (attempts === 1) throw new Error(phaseSecret);
            return runtime;
          },
        },
      },
    });

    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: { restore: async () => {}, restartPreviousRuntime: true },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    await waitForStatus(manager, outcome.operation.id, "restart_required");

    const operation = await manager.get(outcome.operation.id);
    const persisted = readFileSync(
      join(stateDir, "runtime-operations", `${outcome.operation.id}.json`),
      "utf8",
    );
    expect(attempts).toBe(2);
    expect(JSON.stringify(operation)).not.toContain(phaseSecret);
    expect(persisted).not.toContain(phaseSecret);
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "cold-restart",
          error: { message: "Runtime phase failed" },
        }),
        expect.objectContaining({
          name: "rollback-restart",
          error: { message: "Runtime phase failed" },
        }),
      ]),
    );
  });

  it.each(["vault", "config"])(
    "attempts one rollback and requires restart when %s restoration fails",
    async (boundary) => {
      const runtime = {} as AgentRuntime;
      let attempts = 0;
      const manager = new DefaultRuntimeOperationManager({
        repository,
        runtime: () => runtime,
        classifyContext: () => ({ currentProvider: "openai" }),
        classifier: defaultClassifier,
        healthChecker: new HealthChecker(),
        strategies: {
          cold: {
            tier: "cold",
            apply: async (context) => {
              attempts += 1;
              if (attempts === 1) throw new Error("target failed");
              await context.reportPhase({
                name: "cold-restart",
                status: "succeeded",
              });
              return runtime;
            },
          },
        },
      });
      const outcome = await manager.start({
        intent: {
          kind: "provider-switch",
          provider: "pi",
          primaryModel: "openai/gpt-5.4-mini",
        },
        compensation: {
          restore: async () => {
            throw new Error(`${boundary} backend echoed plaintext`);
          },
          restartPreviousRuntime: true,
        },
      });
      expect(outcome.kind).toBe("accepted");
      if (outcome.kind !== "accepted") return;
      await waitForStatus(manager, outcome.operation.id, "restart_required");

      const operation = await manager.get(outcome.operation.id);
      expect(attempts).toBe(2);
      expect(operation?.error?.cause).toBe("Configuration restoration failed");
      expect(JSON.stringify(operation)).not.toContain(
        "backend echoed plaintext",
      );
      expect(operation?.phases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "restore-config", status: "failed" }),
          expect.objectContaining({
            name: "rollback-restart",
            status: "succeeded",
          }),
        ]),
      );
    },
  );

  it("requires restart after combined restoration and rollback failure", async () => {
    const runtime = {} as AgentRuntime;
    let attempts = 0;
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        cold: {
          tier: "cold",
          apply: async () => {
            attempts += 1;
            throw new Error(`restart failure ${attempts}`);
          },
        },
      },
    });
    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: {
        restore: async () => {
          throw new Error("restore failure secret");
        },
        restartPreviousRuntime: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    await waitForStatus(manager, outcome.operation.id, "restart_required");

    const operation = await manager.get(outcome.operation.id);
    expect(attempts).toBe(2);
    expect(operation?.error?.cause).toBe(
      "Configuration restoration and previous runtime restart failed",
    );
    expect(JSON.stringify(operation)).not.toContain("restore failure secret");
  });

  it("preserves PR2 failure detail and skips rollback for non-Pi restoration failure", async () => {
    const runtime = {} as AgentRuntime;
    let attempts = 0;
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "pi" }),
      classifier: defaultClassifier,
      healthChecker: new HealthChecker(),
      strategies: {
        cold: {
          tier: "cold",
          apply: async (context) => {
            attempts += 1;
            await context.reportPhase({
              name: "cold-restart",
              status: "failed",
              detail: { legacy: "non-pi-detail" },
              error: { message: "non-pi-phase-error" },
            });
            throw new Error("non-pi-strategy-error");
          },
        },
      },
    });
    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "openai" },
      compensation: {
        restore: async () => {
          throw new Error("non-pi-restore-error");
        },
        restartPreviousRuntime: true,
      },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    await waitForStatus(manager, outcome.operation.id, "failed");

    const operation = await manager.get(outcome.operation.id);
    expect(attempts).toBe(1);
    expect(operation?.status).toBe("failed");
    expect(operation?.error).toMatchObject({
      message: "non-pi-strategy-error",
      cause: "Configuration restoration failed: non-pi-restore-error",
    });
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "cold-restart",
          detail: { legacy: "non-pi-detail" },
          error: { message: "non-pi-phase-error" },
        }),
      ]),
    );
  });

  it("requires restart when the recovered previous runtime is unhealthy", async () => {
    const runtime = {} as AgentRuntime;
    let attempts = 0;
    const healthChecker = new HealthChecker();
    healthChecker.register({
      name: "required-provider",
      required: true,
      timeoutMs: 100,
      run: async () => ({ ok: false, reason: "credential-bearing failure" }),
    });
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "openai" }),
      classifier: defaultClassifier,
      healthChecker,
      strategies: {
        cold: {
          tier: "cold",
          apply: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error("target failed");
            return runtime;
          },
        },
      },
    });
    const outcome = await manager.start({
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
      },
      compensation: { restore: async () => {}, restartPreviousRuntime: true },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    await waitForStatus(manager, outcome.operation.id, "restart_required");

    const operation = await manager.get(outcome.operation.id);
    expect(attempts).toBe(2);
    expect(operation?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollback-restart",
          status: "failed",
          error: { message: "Runtime phase failed" },
        }),
      ]),
    );
    expect(JSON.stringify(operation)).not.toContain(
      "credential-bearing failure",
    );
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

    await waitForStatus(manager, outcome.operation.id, "restart_required");

    expect(restartAttempts).toBe(2);
    expect((await manager.get(outcome.operation.id))?.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "rollback-restart",
          status: "failed",
          error: { message: "Runtime phase failed" },
        }),
      ]),
    );
  });
});
