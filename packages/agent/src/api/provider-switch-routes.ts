/**
 * Mounts POST /api/provider/switch behind the authenticated API gate. Validated
 * provider changes persist secrets through the vault when supported, apply the
 * canonical connection config, and run through the idempotent runtime-operation
 * restart path. Pi is configuration-only until secure onboarding exists: it
 * rejects every submitted key and compensates a failed full restart by restoring
 * config/environment and attempting the previous runtime once.
 */
import type http from "node:http";
import { ElizaError, logger } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  normalizeFirstRunProviderId,
  PostProviderSwitchRequestSchema,
} from "@elizaos/shared";
import type { SecretsManager } from "@elizaos/vault";
import type { ElizaConfig } from "../config/config.ts";
import {
  defaultSecretsManager,
  type ProviderSwitchIntent,
  persistProviderApiKey,
  type RuntimeOperationManager,
} from "../runtime/operations/index.ts";
import {
  applyFirstRunConnectionConfig,
  createProviderSwitchConnection,
  type ProviderSwitchStateSnapshot,
  restoreProviderSwitchState,
  snapshotProviderSwitchState,
} from "./provider-switch-config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProviderSwitchRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  state: { config: ElizaConfig };
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  saveElizaConfig: (config: ElizaConfig) => void;
  scheduleRuntimeRestart: (reason: string) => void;
  runtimeOperationManager: RuntimeOperationManager;
  /**
   * Vault-backed secrets manager. Tests inject; production resolves to the
   * OS-keychain default. The route writes the API key here BEFORE
   * constructing the intent so the secret never lands on disk in plaintext
   * inside an operation record.
   */
  secretsManager?: SecretsManager;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

function readIdempotencyKey(
  headers: http.IncomingHttpHeaders,
): string | undefined {
  // Node lowercases header names on IncomingMessage.headers.
  const raw = headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function handleProviderSwitchRoutes(
  ctx: ProviderSwitchRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  if (method === "POST" && pathname === "/api/provider/switch") {
    const rawBody = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawBody === null) return true;
    const rawProvider =
      typeof rawBody.provider === "string"
        ? normalizeFirstRunProviderId(rawBody.provider)
        : null;
    if (rawProvider === "pi" && Object.hasOwn(rawBody, "apiKey")) {
      error(
        res,
        "Secure Pi API-key onboarding is not available yet; omit apiKey and use a preconfigured runtime credential.",
        400,
      );
      return true;
    }
    const parsed = PostProviderSwitchRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsed.data;

    const normalizedProvider = normalizeFirstRunProviderId(body.provider);
    if (!normalizedProvider) {
      error(res, "Invalid provider", 400);
      return true;
    }

    const trimmedApiKey = body.apiKey;
    const requestedPrimaryModel =
      normalizedProvider === "pi" && typeof rawBody.primaryModel === "string"
        ? rawBody.primaryModel
        : body.primaryModel;

    try {
      let connection:
        | ReturnType<typeof createProviderSwitchConnection>
        | {
            kind: "cloud-managed";
            cloudProvider: "elizacloud";
            apiKey?: string;
          }
        | null;
      if (normalizedProvider === "elizacloud") {
        connection = {
          kind: "cloud-managed" as const,
          cloudProvider: "elizacloud" as const,
          apiKey: trimmedApiKey,
        };
      } else {
        connection = createProviderSwitchConnection({
          provider: normalizedProvider,
          apiKey: trimmedApiKey,
          primaryModel: requestedPrimaryModel,
        });
      }

      if (!connection) {
        error(res, "Invalid provider", 400);
        return true;
      }

      const intent: ProviderSwitchIntent = {
        kind: "provider-switch",
        provider: normalizedProvider,
        primaryModel: requestedPrimaryModel,
      };
      const idempotencyKey = readIdempotencyKey(req.headers);
      let piSnapshot: ProviderSwitchStateSnapshot | undefined;
      const restorePiState = async (): Promise<void> => {
        if (!piSnapshot) {
          throw new ElizaError("Pi provider-switch snapshot is unavailable", {
            code: "PI_SWITCH_SNAPSHOT_UNAVAILABLE",
            context: { provider: "pi" },
          });
        }
        restoreProviderSwitchState(state.config, piSnapshot);
        ctx.saveElizaConfig(state.config);
      };

      const outcome = await ctx.runtimeOperationManager.start({
        intent,
        idempotencyKey,
        ...(normalizedProvider === "pi"
          ? {
              compensation: {
                restore: restorePiState,
                restartPreviousRuntime: true,
              },
            }
          : {}),
        prepare: async () => {
          const config = state.config;
          if (normalizedProvider === "pi") {
            piSnapshot = snapshotProviderSwitchState(config);
          }
          let apiKeyRef: string | undefined;
          if (trimmedApiKey) {
            const secrets = ctx.secretsManager ?? defaultSecretsManager();
            try {
              apiKeyRef = await persistProviderApiKey({
                secrets,
                normalizedProvider,
                apiKey: trimmedApiKey,
                caller: "provider-switch-route",
              });
            } catch (vaultErr) {
              logger.error(
                `[api] Vault write failed for provider=${normalizedProvider}: ${vaultErr instanceof Error ? vaultErr.message : String(vaultErr)}`,
              );
              throw new Error("Vault write failed");
            }
          }

          if (normalizedProvider === "elizacloud" && trimmedApiKey) {
            const cloudBaseUrl = "https://www.elizacloud.ai";
            process.env.ANTHROPIC_BASE_URL = `${cloudBaseUrl}/api/v1`;
            process.env.ANTHROPIC_API_KEY = trimmedApiKey;
            process.env.OPENAI_BASE_URL = `${cloudBaseUrl}/api/v1`;
            process.env.OPENAI_API_KEY = trimmedApiKey;
          }

          try {
            await applyFirstRunConnectionConfig(config, connection);
            ctx.saveElizaConfig(config);
          } catch (cause) {
            // error-policy:J2 restore accepted-only state before adding
            // provider-switch context and rethrowing the original cause.
            if (normalizedProvider === "pi" && piSnapshot) {
              try {
                await restorePiState();
              } catch (restoreCause) {
                throw new ElizaError(
                  "Pi provider switch failed and its prior configuration could not be restored",
                  {
                    code: "PI_SWITCH_CONFIG_RESTORE_FAILED",
                    cause,
                    context: {
                      provider: "pi",
                      restoreError:
                        restoreCause instanceof Error
                          ? restoreCause.message
                          : String(restoreCause),
                    },
                  },
                );
              }
            }
            throw new ElizaError("Provider switch configuration failed", {
              code: "PROVIDER_SWITCH_CONFIG_FAILED",
              cause,
              context: { provider: normalizedProvider },
            });
          }

          return {
            ...intent,
            ...(apiKeyRef ? { apiKeyRef } : {}),
          };
        },
      });

      if (outcome.kind === "accepted") {
        logger.info(
          `[api] Provider switch accepted: provider=${normalizedProvider} op=${outcome.operation.id}`,
        );
        json(
          res,
          {
            success: true,
            provider: normalizedProvider,
            restarting: true,
            operationId: outcome.operation.id,
          },
          202,
        );
        return true;
      }

      if (outcome.kind === "deduped") {
        const op = outcome.operation;
        logger.info(
          `[api] Provider switch deduped: provider=${normalizedProvider} op=${op.id} status=${op.status}`,
        );
        json(res, {
          success: true,
          provider: normalizedProvider,
          restarting: op.status === "running" || op.status === "pending",
          operationId: op.id,
          deduped: true,
        });
        return true;
      }

      // outcome.kind === "rejected-busy"
      json(
        res,
        {
          error: "Provider switch already in progress",
          activeOperationId: outcome.activeOperationId,
        },
        409,
      );
      return true;
    } catch (err) {
      // error-policy:J1 authenticated HTTP boundary — expose typed validation
      // failures as structured client errors and redact all internal failures.
      logger.error(
        `[api] Provider switch failed: ${err instanceof Error ? err.stack : err}`,
      );
      if (err instanceof ElizaError) {
        const isClientError =
          err.code === "PI_QUALIFIED_MODEL_REQUIRED" ||
          err.code === "PI_SECURE_ONBOARDING_NOT_AVAILABLE";
        error(res, err.message, isClientError ? 400 : 500);
        return true;
      }
      error(
        res,
        err instanceof Error && err.message === "Vault write failed"
          ? "Vault write failed"
          : "Provider switch failed",
        500,
      );
    }
    return true;
  }

  return false;
}
