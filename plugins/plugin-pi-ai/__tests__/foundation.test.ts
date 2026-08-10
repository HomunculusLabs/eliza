/**
 * Verifies the deterministic package shell, curated identities, static catalog,
 * and runtime-settings credential boundary without provider network access.
 */
import type { CredentialStore, Provider } from "@earendil-works/pi-ai";
import {
  AgentRuntime,
  type IAgentRuntime,
  TEXT_GENERATION_MODEL_TYPES,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  CURATED_PI_PROVIDERS,
  createPiPlugin,
  PI_AI_VERSION,
  PI_STATIC_CATALOG,
  RuntimeSettingsCredentialStore,
  validatePiProviderManifest,
} from "../index.js";
import packageJson from "../package.json";
import type { PiGatewayProvider } from "../providers/manifest.js";

function fakeProvider(id: "openai" | "anthropic"): Provider {
  return {
    id,
    name: id,
    auth: {
      apiKey: {
        name: `${id} API key`,
        async resolve() {
          return undefined;
        },
      },
    },
    getModels: () => [],
    stream() {
      throw new Error("Foundation tests do not invoke provider streams");
    },
    streamSimple() {
      throw new Error("Foundation tests do not invoke provider streams");
    },
  };
}

function testManifest(load: () => void): readonly PiGatewayProvider[] {
  return [
    {
      id: "openai",
      settingKey: "OPENAI_API_KEY",
      vaultProviderId: "openai",
      async loadProvider() {
        load();
        return fakeProvider("openai");
      },
    },
    {
      id: "anthropic",
      settingKey: "ANTHROPIC_API_KEY",
      vaultProviderId: "anthropic",
      async loadProvider() {
        load();
        return fakeProvider("anthropic");
      },
    },
  ];
}

function runtimeWithSettings(
  settings: Readonly<Record<string, string | null>>,
): IAgentRuntime {
  return {
    getSetting(key: string) {
      return settings[key] ?? null;
    },
  } as IAgentRuntime;
}

function recordingRuntime(
  label: string,
  settings: Readonly<Record<string, string | null>>,
  reads: string[],
): IAgentRuntime {
  return {
    getSetting(key: string) {
      reads.push(`${label}:${key}`);
      return settings[key] ?? null;
    },
  } as IAgentRuntime;
}

describe("Pi package foundation", () => {
  it("pins the audited Pi release exactly", () => {
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("0.84.1");
    expect(PI_AI_VERSION).toBe("0.84.1");
  });

  it("exports a frozen provider-qualified static catalog", () => {
    expect(PI_STATIC_CATALOG).toHaveLength(6);
    expect(Object.isFrozen(PI_STATIC_CATALOG)).toBe(true);
    expect(
      PI_STATIC_CATALOG.every(
        (entry) => entry.qualifiedId === `${entry.provider}/${entry.modelId}`,
      ),
    ).toBe(true);
    expect(new Set(PI_STATIC_CATALOG.map((entry) => entry.provider))).toEqual(
      new Set(["openai", "anthropic"]),
    );
    const tiered = PI_STATIC_CATALOG.find(
      (entry) => entry.qualifiedId === "openai/gpt-5.4",
    );
    expect(tiered?.costPerMillionTokens.tiers?.[0]).toEqual({
      inputTokensAbove: 272_000,
      input: 5,
      output: 22.5,
      cacheRead: 0.5,
      cacheWrite: 0,
    });
  });

  it("accepts only canonical OpenAI and Anthropic credential identities", () => {
    expect(validatePiProviderManifest(CURATED_PI_PROVIDERS)).toHaveLength(2);
    expect(() =>
      validatePiProviderManifest([
        {
          ...CURATED_PI_PROVIDERS[0],
          settingKey: "ANTHROPIC_API_KEY",
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "PI_INVALID_PROVIDER_MANIFEST" }),
    );
  });

  it("reads only injected runtime settings and exposes no secret in list output", async () => {
    const store = new RuntimeSettingsCredentialStore(
      runtimeWithSettings({ OPENAI_API_KEY: "runtime-openai-key" }),
      CURATED_PI_PROVIDERS,
    );

    await expect(store.read("openai")).resolves.toEqual({
      type: "api_key",
      key: "runtime-openai-key",
    });
    await expect(store.read("anthropic")).resolves.toBeUndefined();
    await expect(store.read("unknown")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([
      { providerId: "openai", type: "api_key" },
    ]);

    const blank = new RuntimeSettingsCredentialStore(
      runtimeWithSettings({ OPENAI_API_KEY: "   " }),
      CURATED_PI_PROVIDERS,
    );
    await expect(blank.read("openai")).resolves.toBeUndefined();
  });

  it("reads only the selected upstream setting from each injected runtime", async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-openai-decoy";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-decoy";
    try {
      const reads: string[] = [];
      const first = new RuntimeSettingsCredentialStore(
        recordingRuntime(
          "runtime-one",
          { OPENAI_API_KEY: "runtime-one-openai" },
          reads,
        ),
        CURATED_PI_PROVIDERS,
      );
      const second = new RuntimeSettingsCredentialStore(
        recordingRuntime(
          "runtime-two",
          { ANTHROPIC_API_KEY: "runtime-two-anthropic" },
          reads,
        ),
        CURATED_PI_PROVIDERS,
      );

      await expect(first.read("openai")).resolves.toEqual({
        type: "api_key",
        key: "runtime-one-openai",
      });
      await expect(second.read("anthropic")).resolves.toEqual({
        type: "api_key",
        key: "runtime-two-anthropic",
      });
      expect(reads).toEqual([
        "runtime-one:OPENAI_API_KEY",
        "runtime-two:ANTHROPIC_API_KEY",
      ]);
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  });

  it("denies all Pi credential mutation and honors cancellation", async () => {
    const store: CredentialStore = new RuntimeSettingsCredentialStore(
      runtimeWithSettings({ OPENAI_API_KEY: "runtime-openai-key" }),
      CURATED_PI_PROVIDERS,
    );
    await expect(
      store.modify("openai", async () => undefined),
    ).rejects.toMatchObject({ code: "PI_CREDENTIAL_STORE_READ_ONLY" });
    await expect(store.delete("openai")).rejects.toMatchObject({
      code: "PI_CREDENTIAL_STORE_READ_ONLY",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      store.read("openai", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps provider clients and credential stores scoped per runtime", async () => {
    const load = vi.fn();
    const createStore = vi.fn(
      (runtime: IAgentRuntime): CredentialStore =>
        new RuntimeSettingsCredentialStore(runtime, CURATED_PI_PROVIDERS),
    );
    const plugin = createPiPlugin({
      providerManifest: testManifest(load),
      credentialStoreFactory: createStore,
    });
    const first = new AgentRuntime({
      logLevel: "fatal",
      settings: { OPENAI_API_KEY: "first" },
    });
    const second = new AgentRuntime({
      logLevel: "fatal",
      settings: { ANTHROPIC_API_KEY: "second" },
    });

    expect(Object.keys(plugin.models ?? {}).sort()).toEqual(
      [...TEXT_GENERATION_MODEL_TYPES].sort(),
    );
    expect(load).not.toHaveBeenCalled();
    await expect(plugin.init?.({}, first)).rejects.toMatchObject({
      code: "PI_MODEL_NOT_CONFIGURED",
    });
    expect(load).not.toHaveBeenCalled();
    const configured = {
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
    };
    await plugin.init?.(configured, first);
    await plugin.init?.(configured, second);
    expect(load).toHaveBeenCalledTimes(4);
    expect(createStore).toHaveBeenCalledTimes(2);
    await expect(plugin.init?.(configured, first)).rejects.toMatchObject({
      code: "PI_ALREADY_INITIALIZED",
    });

    expect(() =>
      plugin.applyConfig?.({ ELIZA_LLM_TEXT_BACKEND: "pi" }, first),
    ).toThrowError(
      expect.objectContaining({ code: "PI_MODEL_NOT_CONFIGURED" }),
    );
    plugin.applyConfig?.(
      { ...configured, ELIZA_LLM_TEXT_BACKEND: "pi" },
      first,
    );
    await plugin.dispose?.(first);
    await plugin.dispose?.(second);
  });
});
