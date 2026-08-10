/**
 * Runtime settings projection for values plugins read through
 * `runtime.getSetting()`. The projection is intentionally pure so cold boot and
 * hot reload can share it without reintroducing drift between startup paths.
 */
import { ElizaError } from "@elizaos/core";
import { resolveServiceRoutingInConfig } from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import {
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.ts";
import { resolveLlmTextRuntimeSettings } from "./model-resolution.ts";
import type {
  ProviderCredentialSettingKey,
  RuntimeCredentialOverlay,
} from "./operations/types.ts";
import { isVaultRef } from "./operations/vault-bridge.ts";

export const HOST_PROVIDER_CREDENTIAL_SETTING_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const satisfies readonly ProviderCredentialSettingKey[];

const PI_CREDENTIAL_REF_BY_SETTING = {
  OPENAI_API_KEY: "providers.openai.api-key",
  ANTHROPIC_API_KEY: "providers.anthropic.api-key",
} as const satisfies Record<ProviderCredentialSettingKey, string>;

export function createRuntimeCredentialOverlay(
  settingKey: ProviderCredentialSettingKey,
  value: string,
): RuntimeCredentialOverlay {
  return Object.freeze({ settingKey, read: () => value });
}

export function resolvePiRuntimeCredentialSettingKey(
  config: ElizaConfig,
): ProviderCredentialSettingKey | undefined {
  const route = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  if (route?.transport !== "direct" || route.backend !== "pi") {
    return undefined;
  }
  if (route.primaryModel?.startsWith("openai/")) return "OPENAI_API_KEY";
  if (route.primaryModel?.startsWith("anthropic/")) return "ANTHROPIC_API_KEY";
  return undefined;
}

function configCredentialValues(
  config: ElizaConfig,
  settingKey: ProviderCredentialSettingKey,
): unknown[] {
  const env = config.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const vars =
    env?.vars && typeof env.vars === "object" && !Array.isArray(env.vars)
      ? env.vars
      : undefined;
  return [env?.[settingKey], vars?.[settingKey]].filter(
    (value) => value !== undefined,
  );
}

function resolvePiRuntimeCredentialSettings(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
  overlay: RuntimeCredentialOverlay | undefined,
): Record<string, string> {
  const selectedKey = resolvePiRuntimeCredentialSettingKey(config);
  if (!selectedKey) return {};

  for (const settingKey of HOST_PROVIDER_CREDENTIAL_SETTING_KEYS) {
    for (const value of configCredentialValues(config, settingKey)) {
      if (typeof value === "string" && value.trim() && !isVaultRef(value)) {
        throw new ElizaError(
          "Pi provider credentials cannot be read from persisted config.",
          {
            code: "PI_PLAINTEXT_CREDENTIAL_FORBIDDEN",
            context: { provider: "pi", settingKey },
          },
        );
      }
    }
  }

  const selectedValues = configCredentialValues(config, selectedKey);
  const selectedVaultRefs = selectedValues.filter(
    (value): value is string => typeof value === "string" && isVaultRef(value),
  );
  const expectedRef = PI_CREDENTIAL_REF_BY_SETTING[selectedKey];
  if (selectedVaultRefs.some((value) => value !== `vault://${expectedRef}`)) {
    throw new ElizaError(
      "Pi credential reference does not match the qualified model provider.",
      {
        code: "PI_CREDENTIAL_REFERENCE_MISMATCH",
        context: { provider: "pi", settingKey: selectedKey },
      },
    );
  }

  if (overlay) {
    if (overlay.settingKey !== selectedKey) {
      throw new ElizaError(
        "Pi runtime credential does not match the qualified model provider.",
        {
          code: "PI_CREDENTIAL_PROVIDER_MISMATCH",
          context: {
            provider: "pi",
            expectedSettingKey: selectedKey,
            actualSettingKey: overlay.settingKey,
          },
        },
      );
    }
    const value = overlay.read();
    return value.trim() ? { [selectedKey]: value } : {};
  }

  // A persisted vault reference is authoritative and fail-closed: without its
  // resolved overlay, do not fall back to a stale process-global credential.
  if (selectedVaultRefs.length > 0) return {};
  const hostValue = env[selectedKey];
  return typeof hostValue === "string" && hostValue.trim()
    ? { [selectedKey]: hostValue }
    : {};
}

function collectHostProviderCredentialSettings(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const key of HOST_PROVIDER_CREDENTIAL_SETTING_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      settings[key] = value;
    }
  }
  return settings;
}

export interface RuntimeSettingsProjectionOptions {
  preferredProviderId?: string;
  brainProviderName?: string;
  embeddingProviderName?: string;
  visionModeSetting?: string;
  managedSkillsDir?: string;
  bundledSkillsDir?: string | null;
  workspaceSkillsDir?: string | null;
  walletSettings?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  /**
   * Connector secrets resolved from `vault://` refs at boot
   * (see `resolveConnectorVaultOverlay` in eliza.ts). Delivered ONLY into the
   * runtime settings map — never process.env — so `runtime.getSetting()` hands
   * plugins the plaintext while the environment stays clean.
   */
  connectorSecretsOverlay?: Record<string, string>;
  /** Opaque selected-provider credential supplied only to this runtime. */
  runtimeCredentialOverlay?: RuntimeCredentialOverlay;
}

/**
 * Returns true if the given env var key is safe to forward to runtime.settings.
 * Blocks blockchain private keys, secrets, passwords, tokens, credentials,
 * mnemonics, and seed phrases while allowing API keys that plugins need.
 */
export function isEnvKeyAllowedForForwarding(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper === "ALLOW_NO_DATABASE") return false;
  if (upper.includes("PRIVATE_KEY")) return false;
  if (upper.startsWith("EVM_") || upper.startsWith("SOLANA_")) return false;
  if (/(SECRET|PASSWORD|CREDENTIAL|MNEMONIC|SEED_PHRASE)/i.test(key)) {
    return false;
  }
  if (/(ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN)$/i.test(key)) {
    return false;
  }
  if (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  ) {
    return false;
  }
  return true;
}

export function buildRuntimeSettingsProjection(
  config: ElizaConfig,
  options: RuntimeSettingsProjectionOptions = {},
): Record<string, string> {
  const env = options.env ?? process.env;
  const hasCanonicalRouting = Object.hasOwn(config, "serviceRouting");
  const canonicalRouting = hasCanonicalRouting
    ? resolveServiceRoutingInConfig(config as Record<string, unknown>)
    : undefined;
  const settings: Record<string, string> = {
    VALIDATION_LEVEL: "fast",
    ...(env.SECRET_SALT ? { ENCRYPTION_SALT: env.SECRET_SALT } : {}),
    // The host explicitly folds only the supported upstream API keys. Plugins
    // still read them through runtime.getSetting(), never process.env.
    ...collectHostProviderCredentialSettings(env),
    ...Object.fromEntries(
      Object.entries(collectConfigEnvVars(config)).filter(
        ([key, value]) =>
          isEnvKeyAllowedForForwarding(key) && !isVaultRef(value),
      ),
    ),
    ...(typeof env.EMBEDDING_PROVIDER === "string" &&
    env.EMBEDDING_PROVIDER.trim().length > 0
      ? { EMBEDDING_PROVIDER: env.EMBEDDING_PROVIDER.trim().toLowerCase() }
      : {}),
    // Drop unresolved `vault://` sentinels so a plugin never receives the ref
    // literal as a credential; the resolved overlay below supplies the real
    // value for refs the vault could serve (fail-closed for the rest).
    ...Object.fromEntries(
      Object.entries(collectConnectorEnvVars(config)).filter(
        ([, value]) => !isVaultRef(value),
      ),
    ),
    ...(options.connectorSecretsOverlay ?? {}),
    ...resolveLlmTextRuntimeSettings(config),
    ...(options.preferredProviderId
      ? { MODEL_PROVIDER: options.preferredProviderId }
      : {}),
    ...(options.brainProviderName
      ? { ELIZA_BRAIN_PROVIDER: options.brainProviderName }
      : {}),
    ...(options.embeddingProviderName
      ? { ELIZA_EMBEDDING_PROVIDER: options.embeddingProviderName }
      : {}),
    ...(hasCanonicalRouting
      ? {
          ELIZA_CANONICAL_LLM_TEXT_ENABLED: String(
            Boolean(canonicalRouting?.llmText),
          ),
          ELIZA_CANONICAL_EMBEDDINGS_ENABLED: String(
            Boolean(canonicalRouting?.embeddings),
          ),
        }
      : {}),
    ...(options.visionModeSetting
      ? { VISION_MODE: options.visionModeSetting }
      : {}),
    ...(options.walletSettings ?? {}),
    ...(typeof config.agents?.defaults?.adminEntityId === "string" &&
    config.agents.defaults.adminEntityId.trim().length > 0
      ? { ELIZA_ADMIN_ENTITY_ID: config.agents.defaults.adminEntityId.trim() }
      : {}),
    ...(config.agents?.defaults?.ownerContacts
      ? {
          ELIZA_OWNER_CONTACTS_JSON: JSON.stringify(
            config.agents.defaults.ownerContacts,
          ),
        }
      : {}),
    ...(config.agents?.defaults?.inboxTriage
      ? {
          ELIZA_INBOX_TRIAGE_CONFIG_JSON: JSON.stringify(
            config.agents.defaults.inboxTriage,
          ),
        }
      : {}),
    ...(config.roles?.connectorAdmins
      ? {
          ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify(
            config.roles.connectorAdmins,
          ),
        }
      : {}),
    ...(config.skills?.allowBundled
      ? { SKILLS_ALLOWLIST: config.skills.allowBundled.join(",") }
      : {}),
    ...(config.skills?.denyBundled
      ? { SKILLS_DENYLIST: config.skills.denyBundled.join(",") }
      : {}),
    ...(options.managedSkillsDir
      ? { SKILLS_DIR: options.managedSkillsDir }
      : {}),
    ...(options.bundledSkillsDir
      ? { BUNDLED_SKILLS_DIRS: options.bundledSkillsDir }
      : {}),
    ...(options.workspaceSkillsDir
      ? { WORKSPACE_SKILLS_DIR: options.workspaceSkillsDir }
      : {}),
    ...(config.skills?.load?.extraDirs?.length
      ? { EXTRA_SKILLS_DIRS: config.skills.load.extraDirs.join(",") }
      : {}),
    ...(config.features?.vision === false
      ? { DISABLE_IMAGE_DESCRIPTION: "true" }
      : {}),
  };

  const selectedPiKey = resolvePiRuntimeCredentialSettingKey(config);
  if (selectedPiKey) {
    for (const settingKey of HOST_PROVIDER_CREDENTIAL_SETTING_KEYS) {
      delete settings[settingKey];
    }
    Object.assign(
      settings,
      resolvePiRuntimeCredentialSettings(
        config,
        env,
        options.runtimeCredentialOverlay,
      ),
    );
  }
  return settings;
}
