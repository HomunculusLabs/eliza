/**
 * DefaultRuntimeOperationManager — the single use case for state-changing
 * lifecycle actions against the live runtime.
 *
 * Lifecycle:
 *   1. Caller (route layer) hands us an OperationIntent (already validated).
 *   2. We classify the intent into a ReloadTier.
 *   3. If an op is already active we reject with `rejected-busy`. If an
 *      idempotency key matches a record within retention we return
 *      `deduped`. Otherwise we accept synchronously and run the op
 *      asynchronously on the next microtask.
 *   4. Each phase mutation is appended to the repo. Accepted operations may
 *      retain a process-local compensation callback; failures restore state and
 *      can request one cold previous-runtime attempt without changing the failed
 *      operation outcome. The repository remains the single-flight gate.
 */

import crypto from "node:crypto";
import { type AgentRuntime, ElizaError, logger } from "@elizaos/core";
import type { ClassifyContext } from "./classifier.ts";
import type { HealthChecker } from "./health.ts";
import type {
  HealthCheckReport,
  OperationCompensation,
  OperationError,
  OperationErrorCode,
  OperationIntent,
  OperationPhase,
  ReloadStrategy,
  ReloadTier,
  RuntimeCredentialOverlay,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationManager,
  RuntimeOperationRepository,
  StartOperationOutcome,
  StartOperationRequest,
} from "./types.ts";

export type IntentClassifier = (
  intent: OperationIntent,
  ctx: ClassifyContext,
) => ReloadTier;

export interface DefaultRuntimeOperationManagerOptions {
  repository: RuntimeOperationRepository;
  /**
   * Resolves the *current* live runtime. Called per-operation so the
   * manager always sees the latest reference (cold ops swap it).
   */
  runtime: () => AgentRuntime | null;
  /**
   * Snapshots the live config slice the classifier needs. Called once per
   * `start()` so the classifier sees the state at submission time, not at
   * execution time (which may be after another op completes).
   */
  classifyContext: () => ClassifyContext;
  /**
   * Defaults to `() => "cold"` (conservative). Wire `defaultClassifier`
   * from `./classifier.js` to enable hot/warm tiering.
   */
  classifier?: IntentClassifier;
  healthChecker: HealthChecker;
  /**
   * Tier → strategy. Cold is the conservative baseline; warm/hot strategies
   * are registered by hosts that support lighter-weight reload paths.
   */
  strategies: Partial<Record<ReloadTier, ReloadStrategy>>;
}

const DEFAULT_CLASSIFIER: IntentClassifier = () => "cold";

function strategyErrorCode(err: unknown): OperationErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "vault-resolve-failed" ? code : "strategy-failed";
}

function requiresRedactedFailureDetail(intent: OperationIntent): boolean {
  return intent.kind === "provider-switch" && intent.provider === "pi";
}

function sanitizePiStrategyPhase(phase: OperationPhase): OperationPhase {
  return {
    name: phase.name,
    status: phase.status,
    ...(phase.startedAt === undefined ? {} : { startedAt: phase.startedAt }),
    ...(phase.finishedAt === undefined ? {} : { finishedAt: phase.finishedAt }),
    ...(phase.error ? { error: { message: "Runtime phase failed" } } : {}),
  };
}

export class DefaultRuntimeOperationManager implements RuntimeOperationManager {
  private readonly repository: RuntimeOperationRepository;
  private readonly runtime: () => AgentRuntime | null;
  private readonly classifyContext: () => ClassifyContext;
  private readonly classifier: IntentClassifier;
  private readonly healthChecker: HealthChecker;
  private readonly strategies: Partial<Record<ReloadTier, ReloadStrategy>>;
  /**
   * Serializes `executeOperation` invocations within a single process.
   * The repo's active-op slot is the cross-process gate.
   */
  private executionChain: Promise<void> = Promise.resolve();
  private startChain: Promise<void> = Promise.resolve();
  private readonly compensations = new Map<string, OperationCompensation>();
  private readonly runtimeCredentialOverlays = new Map<
    string,
    RuntimeCredentialOverlay
  >();

  constructor(opts: DefaultRuntimeOperationManagerOptions) {
    this.repository = opts.repository;
    this.runtime = opts.runtime;
    this.classifyContext = opts.classifyContext;
    this.classifier = opts.classifier ?? DEFAULT_CLASSIFIER;
    this.healthChecker = opts.healthChecker;
    this.strategies = opts.strategies;
  }

  async start(req: StartOperationRequest): Promise<StartOperationOutcome> {
    let outcome: StartOperationOutcome | undefined;
    const run = this.startChain.then(async () => {
      outcome = await this.startLocked(req);
    });
    this.startChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
    if (!outcome) {
      throw new Error("[runtime-ops] start did not produce an outcome");
    }
    return outcome;
  }

  private async startLocked(
    req: StartOperationRequest,
  ): Promise<StartOperationOutcome> {
    if (req.idempotencyKey) {
      const existing = await this.repository.findByIdempotencyKey(
        req.idempotencyKey,
      );
      if (existing) {
        logger.info(
          `[runtime-ops] Idempotent hit for key=${req.idempotencyKey} → ${existing.id}`,
        );
        return { kind: "deduped", operation: existing };
      }
    }

    const active = await this.repository.findActive();
    if (active) {
      logger.info(
        `[runtime-ops] Rejected new op: active operation in flight ${active.id}`,
      );
      return { kind: "rejected-busy", activeOperationId: active.id };
    }

    // Snapshot the classify context BEFORE prepare() runs: prepare() mutates
    // the live config to the target provider, so reading currentProvider after
    // it would always equal the target, so every provider-switch would
    // classify as "hot" and an unloaded provider plugin (e.g. switching
    // elizacloud -> cerebras, or onboarding a first provider) would miss the
    // cold restart that loads it, leaving the runtime with no provider.
    const ctxBeforePrepare = this.classifyContext();
    const prepareResult = req.prepare ? await req.prepare() : undefined;
    const preparedIntent =
      prepareResult === undefined ? req.intent : prepareResult;
    const tier = this.classifier(preparedIntent, ctxBeforePrepare);
    const now = Date.now();
    const op: RuntimeOperation = {
      id: crypto.randomUUID(),
      kind: preparedIntent.kind,
      intent: preparedIntent,
      tier,
      idempotencyKey: req.idempotencyKey,
      status: "pending",
      phases: [],
      startedAt: now,
    };

    try {
      await this.repository.create(op);
    } catch (cause) {
      // error-policy:J2 restore accepted-only mutations, then add operation
      // persistence context while preserving the original cause.
      let restoreError: string | undefined;
      if (req.compensation) {
        try {
          await req.compensation.restore();
        } catch (restoreCause) {
          // error-policy:J1 operation boundary — preserve the persistence
          // failure and attach the failed restoration as secondary context.
          restoreError =
            restoreCause instanceof Error
              ? restoreCause.message
              : String(restoreCause);
        }
      }
      throw new ElizaError("Runtime operation could not be persisted", {
        code: "RUNTIME_OPERATION_PERSIST_FAILED",
        cause,
        context: {
          kind: preparedIntent.kind,
          tier,
          ...(restoreError ? { restoreError } : {}),
        },
      });
    }
    if (req.compensation) {
      this.compensations.set(op.id, req.compensation);
    }
    if (
      req.runtimeCredentialOverlay &&
      requiresRedactedFailureDetail(preparedIntent)
    ) {
      this.runtimeCredentialOverlays.set(op.id, req.runtimeCredentialOverlay);
    }
    logger.info(
      `[runtime-ops] Accepted op ${op.id} kind=${op.kind} tier=${op.tier}`,
    );

    // Schedule async; do NOT await. The route caller returns 202
    // immediately and the client polls /events for status.
    this.scheduleExecution(op.id);

    return { kind: "accepted", operation: op };
  }

  async get(id: string): Promise<RuntimeOperation | null> {
    return this.repository.get(id);
  }

  async list(opts?: RuntimeOperationListOptions): Promise<RuntimeOperation[]> {
    return this.repository.list(opts);
  }

  async findActive(): Promise<RuntimeOperation | null> {
    return this.repository.findActive();
  }

  private scheduleExecution(id: string): void {
    this.executionChain = this.executionChain.then(() =>
      this.executeOperation(id)
        .catch(async (err) => {
          // error-policy:J1 repository failures after accepted preparation must
          // still compensate state and attempt the single previous-runtime
          // restart. Phase/status persistence is best-effort in this path.
          const piTransaction = this.runtimeCredentialOverlays.has(id);
          const message = piTransaction
            ? "Runtime operation persistence failed"
            : err instanceof Error
              ? err.message
              : String(err);
          if (this.compensations.has(id)) {
            const reportPhase = async (
              phase: OperationPhase,
            ): Promise<void> => {
              try {
                await this.repository.appendPhase(
                  id,
                  piTransaction ? sanitizePiStrategyPhase(phase) : phase,
                );
              } catch {
                // error-policy:J6 recovery must continue when diagnostic
                // persistence is the failing subsystem.
                logger.warn(
                  `[runtime-ops] Recovery phase could not be persisted for op ${id}`,
                );
              }
            };
            try {
              await this.failOperationWithCompensation(
                id,
                { message, code: "strategy-failed" },
                this.runtime(),
                reportPhase,
                piTransaction,
              );
            } catch {
              // error-policy:J1 compensation already ran before the terminal
              // status write; there is no further safe mutation to attempt.
              logger.warn(
                `[runtime-ops] Recovery status could not be persisted for op ${id}`,
              );
            }
          }
          logger.error(
            `[runtime-ops] Unhandled error executing op ${id}: ${message}`,
          );
        })
        .finally(() => {
          this.compensations.delete(id);
          this.runtimeCredentialOverlays.delete(id);
        }),
    );
  }

  private async executeOperation(id: string): Promise<void> {
    const op = await this.repository.get(id);
    if (!op) {
      logger.warn(`[runtime-ops] executeOperation: op ${id} not found`);
      return;
    }

    await this.repository.update(id, { status: "running" });

    // Validation gate (the route layer already validated; this records the
    // gate boundary so the phase log is complete).
    const validateAt = Date.now();
    await this.repository.appendPhase(id, {
      name: "validate",
      status: "succeeded",
      startedAt: validateAt,
      finishedAt: validateAt,
    });

    const redactFailureDetail = requiresRedactedFailureDetail(op.intent);
    const reportPhase = (phase: OperationPhase): Promise<void> =>
      this.repository.appendPhase(
        id,
        redactFailureDetail ? sanitizePiStrategyPhase(phase) : phase,
      );
    const strategy = this.strategies[op.tier];
    if (!strategy) {
      await this.failOperationWithCompensation(
        id,
        {
          message: `No strategy registered for tier=${op.tier}`,
          code: "no-strategy-for-tier",
        },
        null,
        reportPhase,
        redactFailureDetail,
      );
      return;
    }

    const runtime = this.runtime();
    if (!runtime) {
      await this.failOperationWithCompensation(
        id,
        {
          message: "No live runtime available to apply operation",
          code: "no-runtime",
        },
        null,
        reportPhase,
        redactFailureDetail,
      );
      return;
    }

    const runtimeCredentialOverlay = this.runtimeCredentialOverlays.get(id);
    let newRuntime: AgentRuntime;
    try {
      newRuntime = await strategy.apply({
        runtime,
        intent: op.intent,
        ...(runtimeCredentialOverlay ? { runtimeCredentialOverlay } : {}),
        reportPhase,
      });
    } catch (err) {
      // error-policy:J1 Pi restart construction can observe submitted
      // credentials, so its operation record and logs retain only a fixed error.
      const message = redactFailureDetail
        ? "Runtime restart failed"
        : err instanceof Error
          ? err.message
          : String(err);
      logger.warn(`[runtime-ops] Strategy failed for op ${id}: ${message}`);
      await this.failOperationWithCompensation(
        id,
        { message, code: strategyErrorCode(err) },
        this.runtime(),
        reportPhase,
        redactFailureDetail,
      );
      return;
    }

    // Health-check gate.
    const healthStart = Date.now();
    await this.repository.appendPhase(id, {
      name: "health-check",
      status: "running",
      startedAt: healthStart,
    });

    let report: HealthCheckReport;
    try {
      report = await this.healthChecker.runForRuntime(newRuntime, {
        redactFailureDetail,
      });
    } catch (cause) {
      // error-policy:J1 operation boundary — Pi health failures may originate
      // after credential projection, so persist/log only fixed failure text.
      const detail = redactFailureDetail
        ? "Runtime health check failed"
        : cause instanceof Error
          ? cause.message
          : String(cause);
      await this.repository.updateLastPhase(id, {
        status: "failed",
        finishedAt: Date.now(),
        error: { message: detail },
      });
      logger.warn(`[runtime-ops] Health checker threw for op ${id}: ${detail}`);
      await this.failOperationWithCompensation(
        id,
        {
          message: redactFailureDetail
            ? detail
            : `Health check failed: ${detail}`,
          code: "health-check-failed",
        },
        newRuntime,
        reportPhase,
        redactFailureDetail,
      );
      return;
    }
    const healthEnd = Date.now();

    if (!report.ok) {
      await this.repository.updateLastPhase(id, {
        status: "failed",
        finishedAt: healthEnd,
        detail: redactFailureDetail
          ? {
              passed: report.passed,
              failed: report.failed.map(({ name, required, durationMs }) => ({
                name,
                required,
                durationMs,
                reason: "Runtime health check failed",
              })),
            }
          : {
              passed: report.passed,
              failed: report.failed,
            },
      });
      // The cold strategy has already swapped the runtime by the time we
      // observe a failed health check. Surface the failure; restoring the
      // previous runtime requires a two-phase restart contract with the API
      // server restart closure.
      logger.warn(`[runtime-ops] Health check failed for op ${id}`);
      await this.failOperationWithCompensation(
        id,
        {
          message: "Required health checks failed",
          code: "health-check-failed",
        },
        newRuntime,
        reportPhase,
        redactFailureDetail,
      );
      return;
    }

    await this.repository.updateLastPhase(id, {
      status: "succeeded",
      finishedAt: healthEnd,
      detail: {
        passed: report.passed,
        failed: report.failed,
      },
    });

    await this.repository.update(id, {
      status: "succeeded",
      finishedAt: Date.now(),
    });
    this.compensations.delete(id);
    this.runtimeCredentialOverlays.delete(id);
    logger.info(`[runtime-ops] Operation ${id} succeeded`);
  }

  private async failOperationWithCompensation(
    id: string,
    error: OperationError,
    runtime: AgentRuntime | null,
    reportPhase: (phase: OperationPhase) => Promise<void>,
    piTransaction: boolean,
  ): Promise<void> {
    const compensation = this.compensations.get(id);
    this.compensations.delete(id);
    this.runtimeCredentialOverlays.delete(id);
    if (!compensation) {
      await this.failOperation(id, error);
      return;
    }

    let restorationFailed = false;
    const restoreStartedAt = Date.now();
    try {
      await compensation.restore();
      await reportPhase({
        name: "restore-config",
        status: "succeeded",
        startedAt: restoreStartedAt,
        finishedAt: Date.now(),
      });
    } catch (cause) {
      // error-policy:J1 Pi restoration can cross vault/config boundaries, so
      // retain only fixed text. Non-Pi operations preserve the PR2 detail.
      restorationFailed = true;
      const message = piTransaction
        ? "Configuration restoration failed"
        : cause instanceof Error
          ? cause.message
          : String(cause);
      await reportPhase({
        name: "restore-config",
        status: "failed",
        startedAt: restoreStartedAt,
        finishedAt: Date.now(),
        error: { message },
      });
      if (!piTransaction) {
        await this.failOperation(id, {
          ...error,
          cause: `Configuration restoration failed: ${message}`,
        });
        return;
      }
    }

    let rollbackFailed = false;
    if (compensation.restartPreviousRuntime) {
      const coldStrategy = this.strategies.cold;
      if (!runtime || !coldStrategy) {
        rollbackFailed = true;
        const message = !runtime
          ? "No runtime available for previous-runtime restart"
          : "No cold strategy registered for previous-runtime restart";
        const now = Date.now();
        await reportPhase({
          name: "rollback-restart",
          status: "failed",
          startedAt: now,
          finishedAt: now,
          error: { message },
        });
      } else {
        let rollbackFailureReported = false;
        try {
          const rollbackRuntime = await coldStrategy.apply({
            runtime,
            intent: {
              kind: "restart",
              reason: "restore previous runtime after failed operation",
            },
            reportPhase: (phase) => {
              if (phase.status === "failed") rollbackFailureReported = true;
              return reportPhase({ ...phase, name: "rollback-restart" });
            },
          });
          rollbackFailed = rollbackFailureReported;
          if (piTransaction && !rollbackFailed) {
            try {
              const rollbackHealth = await this.healthChecker.runForRuntime(
                rollbackRuntime,
                { redactFailureDetail: true },
              );
              rollbackFailed = !rollbackHealth.ok;
            } catch {
              // error-policy:J1 rollback health errors can originate after
              // credential projection and are reduced to fixed text.
              rollbackFailed = true;
            }
            if (rollbackFailed) {
              const now = Date.now();
              await reportPhase({
                name: "rollback-restart",
                status: "failed",
                startedAt: now,
                finishedAt: now,
                error: { message: "Previous-runtime health check failed" },
              });
            }
          }
        } catch (cause) {
          // error-policy:J1 Pi recovery may touch credentials; non-Pi retains
          // the existing PR2 diagnostic detail and terminal failed status.
          rollbackFailed = true;
          const message = piTransaction
            ? "Previous-runtime restart failed"
            : cause instanceof Error
              ? cause.message
              : String(cause);
          if (!rollbackFailureReported) {
            const now = Date.now();
            await reportPhase({
              name: "rollback-restart",
              status: "failed",
              startedAt: now,
              finishedAt: now,
              error: { message },
            });
          }
          logger.warn(
            `[runtime-ops] Previous-runtime restart failed for op ${id}: ${message}`,
          );
        }
      }
    }

    // Pi recovery is fail-closed: restoration and the single rollback restart
    // are independent attempts, and either failure requires operator restart.
    const restartRequired =
      piTransaction && (restorationFailed || rollbackFailed);
    const recoveryCause = piTransaction
      ? restorationFailed
        ? rollbackFailed
          ? "Configuration restoration and previous runtime restart failed"
          : "Configuration restoration failed"
        : rollbackFailed
          ? "Previous runtime restart failed"
          : undefined
      : undefined;
    await this.failOperation(
      id,
      recoveryCause ? { ...error, cause: recoveryCause } : error,
      restartRequired ? "restart_required" : "failed",
    );
  }

  private async failOperation(
    id: string,
    error: OperationError,
    status: "failed" | "restart_required" = "failed",
  ): Promise<void> {
    await this.repository.update(id, {
      status,
      finishedAt: Date.now(),
      error,
    });
    logger.warn(
      `[runtime-ops] Operation ${id} failed: ${error.code ?? "unknown"} — ${error.message}`,
    );
  }
}
