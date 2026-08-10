/**
 * Runtime settings projection coverage for cold boot and hot reload. The test
 * pins the persisted config fields plugins read through `runtime.getSetting()`,
 * especially connector credentials and the runtime-scoped OpenAI/Anthropic
 * credential projection used by the Pi gateway after a runtime rebuild.
 */
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  formatVaultRef,
  resolveConfigEnvForProcess,
  type VaultLike,
} from "./operations/vault-bridge.ts";
import {
  buildRuntimeSettingsProjection,
  createRuntimeCredentialOverlay,
} from "./runtime-settings.ts";
import { applySandboxConnectorOwnership } from "./sandbox-character.ts";

const ENV_KEYS = ["SECRET_SALT", "EMBEDDING_PROVIDER"] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SECRET_SALT = "salt-runtime";
  process.env.EMBEDDING_PROVIDER = "local";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("buildRuntimeSettingsProjection", () => {
  it("folds only supported host provider credentials", () => {
    const settings = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: {
        OPENAI_API_KEY: "host-openai",
        ANTHROPIC_API_KEY: "host-anthropic",
        GOOGLE_GENERATIVE_AI_API_KEY: "host-google",
      },
    });

    expect(settings.OPENAI_API_KEY).toBe("host-openai");
    expect(settings.ANTHROPIC_API_KEY).toBe("host-anthropic");
    expect(settings.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
  });

  it("keeps manual runtime config ahead of host-folded credentials", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        env: { vars: { OPENAI_API_KEY: "manual-openai" } },
      } as ElizaConfig,
      { env: { OPENAI_API_KEY: "host-openai" } },
    );

    expect(settings.OPENAI_API_KEY).toBe("manual-openai");
  });

  it("projects a resolved provider vault ref and drops unresolved sentinels", async () => {
    const vaultValues = new Map([
      ["providers.openai.api-key", "vault-projected-openai"],
    ]);
    const vault: VaultLike = {
      async has(key) {
        return vaultValues.has(key);
      },
      async get(key) {
        const value = vaultValues.get(key);
        if (value === undefined) throw new Error("missing test vault value");
        return value;
      },
    };
    const config = {
      env: {
        vars: {
          OPENAI_API_KEY: formatVaultRef("providers.openai.api-key"),
          ANTHROPIC_API_KEY: formatVaultRef("providers.anthropic.api-key"),
        },
      },
    } as ElizaConfig;
    const { resolved, missing } = await resolveConfigEnvForProcess(
      config.env?.vars,
      vault,
    );

    expect(missing).toEqual(["providers.anthropic.api-key"]);
    const settings = buildRuntimeSettingsProjection(config, { env: resolved });
    expect(settings.OPENAI_API_KEY).toBe("vault-projected-openai");
    expect(settings.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(settings)).not.toContain(
      formatVaultRef("providers.anthropic.api-key"),
    );
  });

  it.each([
    ["openai", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const)(
    "reconstructs the exact %s vault value through runtime.getSetting after restart",
    async (provider, environmentKey) => {
      const apiKeyRef = `providers.${provider}.api-key`;
      const apiKey = `${provider}-restart-secret`;
      const persistedConfig = JSON.stringify({
        serviceRouting: {
          llmText: {
            backend: "pi",
            transport: "direct",
            primaryModel: `${provider}/test-model`,
          },
        },
        env: {
          [environmentKey]: formatVaultRef(apiKeyRef),
          vars: { [environmentKey]: formatVaultRef(apiKeyRef) },
        },
      } satisfies ElizaConfig);
      expect(persistedConfig).not.toContain(apiKey);

      const restartedConfig = JSON.parse(persistedConfig) as ElizaConfig;
      const vault: VaultLike = {
        async has(key) {
          return key === apiKeyRef;
        },
        async get(key) {
          if (key !== apiKeyRef) throw new Error("unexpected test vault key");
          return apiKey;
        },
      };
      const topLevel = await resolveConfigEnvForProcess(
        restartedConfig.env as Record<string, unknown>,
        vault,
      );
      const nested = await resolveConfigEnvForProcess(
        restartedConfig.env?.vars,
        vault,
      );
      const resolvedValue =
        topLevel.resolved[environmentKey] ?? nested.resolved[environmentKey];
      if (!resolvedValue)
        throw new Error("selected vault value was not resolved");
      const runtimeCredentialOverlay = createRuntimeCredentialOverlay(
        environmentKey,
        resolvedValue,
      );
      const settings = buildRuntimeSettingsProjection(restartedConfig, {
        env: {
          OPENAI_API_KEY: "ambient-openai-decoy",
          ANTHROPIC_API_KEY: "ambient-anthropic-decoy",
        },
        runtimeCredentialOverlay,
      });
      const restartedRuntime = new AgentRuntime({
        logLevel: "fatal",
        settings,
      });

      expect(restartedRuntime.getSetting(environmentKey)).toBe(apiKey);
      expect(
        restartedRuntime.getSetting(
          environmentKey === "OPENAI_API_KEY"
            ? "ANTHROPIC_API_KEY"
            : "OPENAI_API_KEY",
        ),
      ).toBeNull();
      expect(JSON.stringify(restartedConfig)).not.toContain(apiKey);
      expect(JSON.stringify(runtimeCredentialOverlay)).not.toContain(apiKey);
      expect(topLevel.missing).toEqual([]);
      expect(nested.missing).toEqual([]);
    },
  );

  it("projects only the qualified Pi host credential when no vault ref exists", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        serviceRouting: {
          llmText: {
            backend: "pi",
            transport: "direct",
            primaryModel: "openai/gpt-5.4-mini",
          },
        },
      } as ElizaConfig,
      {
        env: {
          OPENAI_API_KEY: "selected-host-openai",
          ANTHROPIC_API_KEY: "stale-host-anthropic",
        },
      },
    );

    expect(settings.OPENAI_API_KEY).toBe("selected-host-openai");
    expect(settings.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("rejects persisted plaintext only for canonical Pi runtime config", () => {
    const piConfig = {
      serviceRouting: {
        llmText: {
          backend: "pi",
          transport: "direct",
          primaryModel: "openai/gpt-5.4-mini",
        },
      },
      env: { vars: { ANTHROPIC_API_KEY: "stale-persisted-secret" } },
    } as ElizaConfig;

    expect(() =>
      buildRuntimeSettingsProjection(piConfig, {
        env: { OPENAI_API_KEY: "legitimate-host-key" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "PI_PLAINTEXT_CREDENTIAL_FORBIDDEN" }),
    );

    const direct = buildRuntimeSettingsProjection(
      {
        serviceRouting: {
          llmText: {
            backend: "openai",
            transport: "direct",
            primaryModel: "gpt-5.4-mini",
          },
        },
        env: { vars: { OPENAI_API_KEY: "direct-config-key" } },
      } as ElizaConfig,
      { env: { OPENAI_API_KEY: "host-key" } },
    );
    expect(direct.OPENAI_API_KEY).toBe("direct-config-key");
  });

  it("does not fall back to ambient credentials for an unresolved Pi vault ref", () => {
    const settings = buildRuntimeSettingsProjection(
      {
        serviceRouting: {
          llmText: {
            backend: "pi",
            transport: "direct",
            primaryModel: "anthropic/claude-sonnet-4-6",
          },
        },
        env: {
          ANTHROPIC_API_KEY: "vault://providers.anthropic.api-key",
          vars: {
            ANTHROPIC_API_KEY: "vault://providers.anthropic.api-key",
          },
        },
      } as ElizaConfig,
      { env: { ANTHROPIC_API_KEY: "stale-ambient-key" } },
    );
    expect(settings.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("builds isolated credential projections for separate runtimes", () => {
    const first = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { OPENAI_API_KEY: "runtime-one" },
    });
    const second = buildRuntimeSettingsProjection({} as ElizaConfig, {
      env: { ANTHROPIC_API_KEY: "runtime-two" },
    });

    expect(first).toMatchObject({ OPENAI_API_KEY: "runtime-one" });
    expect(first.ANTHROPIC_API_KEY).toBeUndefined();
    expect(second).toMatchObject({ ANTHROPIC_API_KEY: "runtime-two" });
    expect(second.OPENAI_API_KEY).toBeUndefined();
  });

  it("cannot restore gateway-owned credentials from legacy or env config", () => {
    const config = {
      channels: {
        discord: { token: "legacy-discord-token" },
        telegram: { botToken: "legacy-telegram-token" },
      },
      env: {
        DISCORD_API_TOKEN: "env-discord-token",
        vars: { TELEGRAM_BOT_TOKEN: "vars-telegram-token" },
      },
    } as unknown as ElizaConfig;
    const env: NodeJS.ProcessEnv = {
      ELIZA_CLOUD_PROVISIONED: "1",
      DISCORD_API_TOKEN: "projected-discord-token",
      DISCORD_BOT_TOKEN: "projected-discord-token",
      TELEGRAM_BOT_TOKEN: "projected-telegram-token",
    };

    applySandboxConnectorOwnership(env, config);
    const settings = buildRuntimeSettingsProjection(config, { env });

    expect(env.DISCORD_API_TOKEN).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(settings.DISCORD_API_TOKEN).toBeUndefined();
    expect(settings.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(settings.TELEGRAM_BOT_TOKEN).toBeUndefined();
  });

  it("projects connector config and startup-only settings for runtime rebuilds", () => {
    const config = {
      env: {
        vars: {
          OPENAI_API_KEY: "openai-key",
          EVM_PRIVATE_KEY: "blocked-wallet-secret",
          GENERIC_PASSWORD: "blocked-password",
        },
      },
      connectors: {
        discord: {
          token: "discord-token",
          botToken: "discord-bot-token",
          applicationId: "discord-app",
        },
        telegram: {
          botToken: "telegram-token",
        },
        whatsapp: {
          authDir: "/tmp/whatsapp-auth",
          allowFrom: ["+15551234567"],
          groupAllowFrom: ["family"],
        },
      },
      agents: {
        defaults: {
          adminEntityId: " owner-entity ",
          ownerContacts: {
            imessage: { platform: "imessage", handle: "+15550001111" },
          },
        },
      },
      roles: {
        connectorAdmins: { imessage: ["owner-entity"] },
      },
      skills: {
        allowBundled: ["calendar"],
        denyBundled: ["browser"],
        load: { extraDirs: ["/custom/skills"] },
      },
      features: { vision: false },
    } as ElizaConfig;

    const settings = buildRuntimeSettingsProjection(config, {
      preferredProviderId: "openai",
      brainProviderName: "openai",
      embeddingProviderName: "openai",
      visionModeSetting: "OFF",
      managedSkillsDir: "/state/skills",
      bundledSkillsDir: "/bundled/skills",
      workspaceSkillsDir: "/workspace/skills",
      walletSettings: {
        SOLANA_RPC_URL: "https://solana.example/rpc",
        SOLANA_NO_ACTIONS: "true",
        SOLANA_PUBLIC_KEY: "solana-public",
        WALLET_PUBLIC_KEY: "solana-public",
      },
    });

    expect(settings).toMatchObject({
      VALIDATION_LEVEL: "fast",
      ENCRYPTION_SALT: "salt-runtime",
      EMBEDDING_PROVIDER: "local",
      OPENAI_API_KEY: "openai-key",
      DISCORD_API_TOKEN: "discord-token",
      DISCORD_BOT_TOKEN: "discord-token",
      DISCORD_APPLICATION_ID: "discord-app",
      TELEGRAM_BOT_TOKEN: "telegram-token",
      WHATSAPP_AUTH_DIR: "/tmp/whatsapp-auth",
      WHATSAPP_ALLOW_FROM: "+15551234567",
      WHATSAPP_GROUP_ALLOW_FROM: "family",
      MODEL_PROVIDER: "openai",
      ELIZA_BRAIN_PROVIDER: "openai",
      ELIZA_EMBEDDING_PROVIDER: "openai",
      VISION_MODE: "OFF",
      SOLANA_RPC_URL: "https://solana.example/rpc",
      SOLANA_NO_ACTIONS: "true",
      SOLANA_PUBLIC_KEY: "solana-public",
      WALLET_PUBLIC_KEY: "solana-public",
      ELIZA_ADMIN_ENTITY_ID: "owner-entity",
      ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify({
        imessage: ["owner-entity"],
      }),
      SKILLS_ALLOWLIST: "calendar",
      SKILLS_DENYLIST: "browser",
      SKILLS_DIR: "/state/skills",
      BUNDLED_SKILLS_DIRS: "/bundled/skills",
      WORKSPACE_SKILLS_DIR: "/workspace/skills",
      EXTRA_SKILLS_DIRS: "/custom/skills",
      DISABLE_IMAGE_DESCRIPTION: "true",
    });
    expect(settings.ELIZA_OWNER_CONTACTS_JSON).toBe(
      JSON.stringify({
        imessage: { platform: "imessage", handle: "+15550001111" },
      }),
    );
    expect(settings.EVM_PRIVATE_KEY).toBeUndefined();
    expect(settings.GENERIC_PASSWORD).toBeUndefined();
  });

  it("projects explicit canonical routing omissions as disabled capabilities", () => {
    const settings = buildRuntimeSettingsProjection({
      serviceRouting: {
        llmText: {
          backend: "pi",
          transport: "direct",
          primaryModel: "openai/gpt-5.4-mini",
          smallModel: "openai/gpt-5.4-mini",
          largeModel: "anthropic/claude-sonnet-4-5",
        },
      },
    } as ElizaConfig);

    expect(settings).toMatchObject({
      ELIZA_CANONICAL_LLM_TEXT_ENABLED: "true",
      ELIZA_CANONICAL_EMBEDDINGS_ENABLED: "false",
      ELIZA_LLM_TEXT_BACKEND: "pi",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_LARGE_MODEL: "anthropic/claude-sonnet-4-5",
    });
  });

  it("preserves legacy plugin capabilities when canonical routing is absent", () => {
    const settings = buildRuntimeSettingsProjection({} as ElizaConfig);

    expect(settings.ELIZA_CANONICAL_LLM_TEXT_ENABLED).toBeUndefined();
    expect(settings.ELIZA_CANONICAL_EMBEDDINGS_ENABLED).toBeUndefined();
  });
});
