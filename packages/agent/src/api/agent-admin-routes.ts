/**
 * Mounts the destructive agent-admin HTTP routes on the shared route state:
 * POST /api/agent/restart re-initializes the runtime through the injected restart
 * handler and refreshes the reported status, and POST /api/agent/reset stops the
 * runtime, deletes the PGlite data directory (guarded to only ever remove a path
 * whose basename is `.elizadb`), clears persisted first-run config, and wipes
 * cloud plus canonical upstream provider vault entries so the next boot cannot
 * rehydrate reset credentials. Sits behind the authenticated dashboard gate.
 */
import path from "node:path";
import { createRuntimeAccountStoragePolicy } from "@elizaos/auth/account-storage";
import {
  type AgentRuntime,
  ElizaError,
  type RouteRequestMeta,
  type UUID,
} from "@elizaos/core";
import type { RouteHelpers } from "@elizaos/shared";
import {
  getDefaultStylePreset,
  normalizeCharacterLanguage,
} from "@elizaos/shared";
import type { Vault } from "@elizaos/vault";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import { resolveUserPath } from "../config/paths.ts";
import { getAgentHostBridge } from "../runtime/host-bridge.ts";
import { removeProviderApiKey } from "../runtime/operations/vault-bridge.ts";
import type { AutonomousConfigLike } from "../types/config-like.ts";
import { detectRuntimeModel } from "./agent-model.ts";
import { clearPersistedFirstRunConfig } from "./provider-switch-config.ts";
import { quiesceRuntimeBeforeReplacement } from "./runtime-replacement-ownership.ts";

type AgentStateStatus =
  | "not_started"
  | "starting"
  | "running"
  | "paused"
  | "stopped"
  | "restarting"
  | "error";

function clearResetRuntimeState(
  state: AgentAdminRouteState,
  config: AutonomousConfigLike,
): void {
  state.agentName = resolveDefaultAgentName(config);
  state.model = undefined;
  state.startedAt = undefined;
  state.chatRoomId = null;
  state.chatUserId = null;
  state.chatConnectionReady = null;
  state.chatConnectionPromise = null;
  state.conversations?.clear();
  state.activeConversationId = null;
  state.conversationRestorePromise = null;
}

function resolveDefaultAgentName(config: AutonomousConfigLike): string {
  const ui = config.ui as
    | { assistant?: { name?: string }; language?: string }
    | undefined;
  const agents = config.agents as
    | { list?: Array<{ name?: string }> }
    | undefined;
  const configuredName =
    ui?.assistant?.name?.trim() ?? agents?.list?.[0]?.name?.trim();
  if (configuredName) {
    return configuredName;
  }

  return getDefaultStylePreset(normalizeCharacterLanguage(ui?.language)).name;
}

export interface AgentAdminRouteState {
  runtime: AgentRuntime | null;
  config: AutonomousConfigLike;
  agentState: AgentStateStatus;
  agentName: string;
  model: string | undefined;
  startedAt: number | undefined;
  chatRoomId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: { userId: UUID; roomId: UUID; worldId: UUID } | null;
  chatConnectionPromise: Promise<void> | null;
  pendingRestartReasons: string[];
  conversations?: Map<string, unknown>;
  activeConversationId?: string | null;
  conversationRestorePromise?: Promise<void> | null;
}

export interface AgentAdminRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "json" | "error"> {
  state: AgentAdminRouteState;
  onRestart?: (() => Promise<AgentRuntime | null>) | undefined;
  onRuntimeSwapped?: () => void;
  onRuntimeActivated?: (
    previousRuntime: AgentRuntime | null,
    activeRuntime: AgentRuntime,
  ) => void | Promise<void>;
  resolveStateDir: () => string;
  stateDirExists: (resolvedState: string) => boolean;
  removeStateDir: (resolvedState: string) => void;
  logWarn: (message: string) => void;
  /** Testable reset boundaries; production uses the host implementations. */
  loadResetConfig?: typeof loadElizaConfig;
  saveResetConfig?: typeof saveElizaConfig;
  resetVault?: Pick<Vault, "remove">;
}

const RESET_CLOUD_VAULT_KEYS = [
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_ENABLED",
] as const;

export class ResetCredentialCleanupError extends ElizaError {
  constructor(readonly failedRefs: readonly string[]) {
    super("Canonical provider credential cleanup failed", {
      code: "RESET_PROVIDER_CREDENTIAL_CLEANUP_FAILED",
      context: { failedRefs: [...failedRefs] },
    });
  }
}

/** Apply reset's existing idempotent vault-removal policy to all host keys. */
export async function clearResetVaultCredentials(
  vault: Pick<Vault, "remove">,
  logWarn: (message: string) => void,
): Promise<void> {
  let cloudRemovalFailed = false;
  const failedProviderRefs: string[] = [];
  for (const key of RESET_CLOUD_VAULT_KEYS) {
    try {
      await vault.remove(key);
    } catch {
      // error-policy:J4 cloud cleanup retains its established best-effort
      // policy; storage errors are redacted because they may name secrets.
      cloudRemovalFailed = true;
    }
  }
  for (const normalizedProvider of ["openai", "anthropic"] as const) {
    try {
      await removeProviderApiKey({
        vault,
        normalizedProvider,
        caller: "agent-reset",
      });
    } catch {
      // error-policy:J1 continue independent removals, then fail the reset with
      // redacted canonical identities so the host cannot report healthy state.
      failedProviderRefs.push(`providers.${normalizedProvider}.api-key`);
    }
  }
  if (cloudRemovalFailed || failedProviderRefs.length > 0) {
    logWarn(
      "[eliza-api] Reset: one or more vault entries could not be removed",
    );
  }
  if (failedProviderRefs.length > 0) {
    throw new ResetCredentialCleanupError(failedProviderRefs);
  }
}

function resolveResetPgliteDataDir(
  config: ReturnType<typeof loadElizaConfig>,
  stateDir: string,
): string {
  const explicitDataDir = process.env.PGLITE_DATA_DIR?.trim();
  if (explicitDataDir) {
    return resolveUserPath(explicitDataDir);
  }

  const configuredDataDir = config.database?.pglite?.dataDir?.trim();
  if (configuredDataDir) {
    return resolveUserPath(configuredDataDir);
  }

  const workspaceDir =
    config.agents?.defaults?.workspace ?? `${stateDir}/workspace`;
  return path.join(resolveUserPath(workspaceDir), ".elizadb");
}

export async function handleAgentAdminRoutes(
  ctx: AgentAdminRouteContext,
): Promise<boolean> {
  const {
    res,
    method,
    pathname,
    state,
    onRestart,
    onRuntimeSwapped,
    onRuntimeActivated,
    json,
    error,
    resolveStateDir,
    stateDirExists,
    removeStateDir,
    logWarn,
    loadResetConfig = loadElizaConfig,
    saveResetConfig = saveElizaConfig,
    resetVault,
  } = ctx;

  if (method === "POST" && pathname === "/api/agent/restart") {
    if (!onRestart) {
      error(
        res,
        "Restart is not supported in this mode (no restart handler registered)",
        501,
      );
      return true;
    }

    if (state.agentState === "restarting") {
      error(res, "A restart is already in progress", 409);
      return true;
    }

    const previousState = state.agentState;
    state.agentState = "restarting";
    try {
      const previousRuntime = state.runtime;
      const newRuntime = await onRestart();
      if (newRuntime) {
        await quiesceRuntimeBeforeReplacement(previousRuntime, newRuntime);
        state.runtime = newRuntime;
        state.chatConnectionReady = null;
        state.chatConnectionPromise = null;
        state.agentState = "running";
        state.agentName =
          newRuntime.character.name ?? resolveDefaultAgentName(state.config);
        state.model = detectRuntimeModel(newRuntime);
        state.startedAt = Date.now();
        state.pendingRestartReasons = [];
        onRuntimeSwapped?.();
        await onRuntimeActivated?.(previousRuntime, newRuntime);
        json(res, {
          ok: true,
          pendingRestart: false,
          status: {
            state: state.agentState,
            agentName: state.agentName,
            model: state.model,
            startedAt: state.startedAt,
          },
        });
      } else {
        state.agentState = previousState;
        error(
          res,
          "Restart handler returned null — runtime failed to re-initialize",
          500,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.agentState = previousState;
      error(res, `Restart failed: ${message}`, 500);
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/agent/reset") {
    let resetConfig: ReturnType<typeof loadElizaConfig> | undefined;
    try {
      if (state.runtime) {
        await state.runtime.stop({ fast: true });
        state.runtime = null;
      }

      const stateDir = resolveStateDir();
      const config = loadResetConfig();
      resetConfig = config;
      const dataDir = resolveResetPgliteDataDir(config, stateDir);
      if (path.basename(dataDir) !== ".elizadb") {
        logWarn(
          `[eliza-api] Refusing to delete unexpected PGlite dir during reset: "${dataDir}"`,
        );
      } else if (stateDirExists(dataDir)) {
        removeStateDir(dataDir);
      }

      clearPersistedFirstRunConfig(
        config,
        createRuntimeAccountStoragePolicy(stateDir),
      );
      saveResetConfig(config);
      // Publish the sanitized config before vault cleanup. If cleanup fails,
      // no subsequent restart can discover the retained key through config.
      state.config = config;
      // The runtime and database are already gone. Clear their in-memory
      // handles even if canonical vault cleanup subsequently fails.
      clearResetRuntimeState(state, config);

      // Wipe cloud and canonical upstream provider keys so the next boot
      // cannot rehydrate either cloud login or a reset Pi credential. Removal
      // remains idempotent/best-effort under the established reset policy.
      let vault: Pick<Vault, "remove">;
      try {
        vault = resetVault ?? getAgentHostBridge().sharedVault();
      } catch {
        // error-policy:J1 an unavailable vault means neither canonical
        // upstream reference can be proven removed.
        throw new ResetCredentialCleanupError([
          "providers.openai.api-key",
          "providers.anthropic.api-key",
        ]);
      }
      await clearResetVaultCredentials(vault, logWarn);

      state.agentState = "stopped";
      state.config = config;
      state.pendingRestartReasons = [];

      json(res, { ok: true });
    } catch (err) {
      if (err instanceof ResetCredentialCleanupError) {
        state.agentState = "error";
        state.model = undefined;
        state.startedAt = undefined;
        if (resetConfig) state.config = resetConfig;
        state.pendingRestartReasons = [
          "Reset incomplete: canonical provider credential cleanup failed",
        ];
        logWarn(
          `[eliza-api] Reset incomplete; retry required for ${err.failedRefs.join(", ")}`,
        );
        error(
          res,
          "Reset incomplete: canonical provider credentials could not be removed; retry reset before restarting.",
          500,
        );
        return true;
      }
      const message = err instanceof Error ? err.message : String(err);
      error(res, `Reset failed: ${message}`, 500);
    }
    return true;
  }

  return false;
}
