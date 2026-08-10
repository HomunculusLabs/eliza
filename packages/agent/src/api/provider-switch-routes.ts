/**
 * Mounts POST /api/provider/switch behind the authenticated API gate. Validated
 * provider changes persist secrets through the vault when supported, apply the
 * canonical connection config, and run through the idempotent runtime-operation
 * restart path. Pi key submission persists only the selected upstream vault
 * reference and carries plaintext only in an opaque operation-local runtime
 * overlay. Failed restarts restore secret/config state and attempt the previous
 * runtime exactly once without mutating process-global credentials.
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
  type ProviderApiKeySnapshot,
  type ProviderSwitchIntent,
  persistProviderApiKey,
  type RuntimeOperationManager,
  restoreProviderApiKey,
  snapshotProviderApiKey,
} from "../runtime/operations/index.ts";
import { createRuntimeCredentialOverlay } from "../runtime/runtime-settings.ts";
import {
  applyFirstRunConnectionConfig,
  applyPiProviderApiKeyReference,
  createProviderSwitchConnection,
  PI_CREDENTIAL_TARGETS,
  type ProviderSwitchStateSnapshot,
  resolvePiCredentialProvider,
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
   * OS-keychain default. Accepted-only preparation writes the API key before
   * returning the persisted intent, so operation records never carry plaintext.
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
    if (
      rawProvider === "pi" &&
      Object.hasOwn(rawBody, "apiKey") &&
      (typeof rawBody.apiKey !== "string" || rawBody.apiKey.trim().length === 0)
    ) {
      error(res, "Pi API key must be a non-empty string.", 400);
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
          credentialProvider: body.credentialProvider,
        });
      }

      if (!connection) {
        error(res, "Invalid provider", 400);
        return true;
      }

      const piCredentialProvider =
        normalizedProvider === "pi" && requestedPrimaryModel
          ? resolvePiCredentialProvider(requestedPrimaryModel)
          : undefined;
      const intent: ProviderSwitchIntent = {
        kind: "provider-switch",
        provider: normalizedProvider,
        primaryModel: requestedPrimaryModel,
        ...(piCredentialProvider
          ? { credentialProvider: piCredentialProvider }
          : {}),
      };
      const idempotencyKey = readIdempotencyKey(req.headers);
      const runtimeCredentialOverlay =
        piCredentialProvider && trimmedApiKey
          ? createRuntimeCredentialOverlay(
              PI_CREDENTIAL_TARGETS[piCredentialProvider].environmentKey,
              trimmedApiKey,
            )
          : undefined;
      let piSnapshot: ProviderSwitchStateSnapshot | undefined;
      let piVaultSnapshot: ProviderApiKeySnapshot | undefined;
      let piSecrets: SecretsManager | undefined;
      const restorePiState = async (): Promise<void> => {
        if (!piSnapshot) {
          throw new ElizaError("Pi provider-switch snapshot is unavailable", {
            code: "PI_SWITCH_SNAPSHOT_UNAVAILABLE",
            context: { provider: "pi" },
          });
        }

        const failedSteps: string[] = [];
        if (piVaultSnapshot && piSecrets) {
          try {
            await restoreProviderApiKey({
              vault: piSecrets.vault,
              snapshot: piVaultSnapshot,
              caller: "provider-switch-compensation",
            });
          } catch {
            // error-policy:J1 compensation continues restoring config/env and
            // reports only the failed redacted step to the operation boundary.
            failedSteps.push("vault");
          }
        }
        try {
          restoreProviderSwitchState(state.config, piSnapshot);
          ctx.saveElizaConfig(state.config);
        } catch {
          // error-policy:J1 config/env restoration errors are reduced to a
          // redacted step name because config may contain unrelated secrets.
          failedSteps.push("config-environment");
        }
        if (failedSteps.length > 0) {
          throw new ElizaError("Pi provider-switch compensation failed", {
            code: "PI_SWITCH_COMPENSATION_FAILED",
            context: { provider: "pi", failedSteps },
          });
        }
      };

      const outcome = await ctx.runtimeOperationManager.start({
        intent,
        idempotencyKey,
        ...(runtimeCredentialOverlay ? { runtimeCredentialOverlay } : {}),
        ...(normalizedProvider === "pi"
          ? {
              compensation: {
                restore: restorePiState,
                restartPreviousRuntime: true,
              },
            }
          : {}),
        prepare: async () => {
          if (normalizedProvider === "pi") {
            piSnapshot = snapshotProviderSwitchState(state.config);
            const nextConfig = structuredClone(state.config);
            let apiKeyRef: string | undefined;
            try {
              if (trimmedApiKey) {
                if (!piCredentialProvider) {
                  throw new ElizaError(
                    "Pi credential provider could not be resolved",
                    {
                      code: "PI_CREDENTIAL_PROVIDER_MISSING",
                      context: { provider: "pi" },
                    },
                  );
                }
                piSecrets = ctx.secretsManager ?? defaultSecretsManager();
                piVaultSnapshot = await snapshotProviderApiKey({
                  vault: piSecrets.vault,
                  normalizedProvider: piCredentialProvider,
                  caller: "provider-switch-route:snapshot",
                });
                apiKeyRef = await persistProviderApiKey({
                  secrets: piSecrets,
                  normalizedProvider: piCredentialProvider,
                  apiKey: trimmedApiKey,
                  caller: "provider-switch-route",
                });
                const expectedRef =
                  PI_CREDENTIAL_TARGETS[piCredentialProvider].apiKeyRef;
                if (apiKeyRef !== expectedRef) {
                  throw new ElizaError(
                    "Pi credential reference does not match its upstream",
                    {
                      code: "PI_CREDENTIAL_REFERENCE_MISMATCH",
                      context: {
                        credentialProvider: piCredentialProvider,
                        apiKeyRef,
                      },
                    },
                  );
                }
              }

              await applyFirstRunConnectionConfig(nextConfig, connection);
              if (apiKeyRef && trimmedApiKey && piCredentialProvider) {
                applyPiProviderApiKeyReference(
                  nextConfig,
                  piCredentialProvider,
                  apiKeyRef,
                );
              }
              ctx.saveElizaConfig(nextConfig);
              state.config = nextConfig;
            } catch {
              // error-policy:J1 accepted-only preparation restores every
              // process-local mutation and surfaces no secret-bearing cause.
              try {
                await restorePiState();
              } catch {
                throw new ElizaError(
                  "Pi provider switch preparation and compensation failed",
                  {
                    code: "PI_SWITCH_PREPARE_COMPENSATION_FAILED",
                    context: { provider: "pi" },
                  },
                );
              }
              throw new ElizaError("Pi provider switch preparation failed", {
                code: "PI_SWITCH_PREPARE_FAILED",
                context: { provider: "pi" },
              });
            }

            return {
              ...intent,
              ...(apiKeyRef ? { apiKeyRef } : {}),
            };
          }

          const config = state.config;
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
            } catch {
              // error-policy:J1 the HTTP boundary receives a fixed failure;
              // vault backend errors are not logged because they may echo input.
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
            // error-policy:J2 non-Pi provider switching retains its existing
            // context-adding failure contract.
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
        const dedupedFailure =
          op.status === "failed" ||
          op.status === "restart_required" ||
          op.status === "rolled-back";
        json(
          res,
          {
            success: !dedupedFailure,
            provider: normalizedProvider,
            status: op.status,
            restarting: op.status === "running" || op.status === "pending",
            operationId: op.id,
            deduped: true,
          },
          dedupedFailure ? 500 : undefined,
        );
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
        `[api] Provider switch failed: provider=${normalizedProvider} code=${
          err instanceof ElizaError ? err.code : "untyped"
        }`,
      );
      if (err instanceof ElizaError) {
        const isClientError =
          err.code === "PI_QUALIFIED_MODEL_REQUIRED" ||
          err.code === "PI_CREDENTIAL_PROVIDER_MISMATCH" ||
          err.code === "PI_CREDENTIAL_MISSING" ||
          err.code === "CREDENTIAL_PROVIDER_REQUIRES_PI";
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
