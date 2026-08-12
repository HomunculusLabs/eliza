/**
 * Exercises the real cold-strategy-to-AgentRuntime construction boundary for
 * Pi credential overlays without booting provider networks or a database.
 */
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiPlugin } from "../../../../../plugins/plugin-pi-ai/index.ts";
import { applyPiProviderApiKeyReference } from "../../../src/api/provider-switch-config.ts";
import type { ElizaConfig } from "../../../src/config/config.ts";
import { preparePreferredProviderPluginForBoot } from "../../../src/runtime/boot-pipeline.ts";
import { createColdStrategy } from "../../../src/runtime/operations/cold-strategy.ts";
import { providerSmokeCheck } from "../../../src/runtime/operations/health-checks.ts";
import type { RuntimeCredentialOverlay } from "../../../src/runtime/operations/types.ts";
import {
  buildRuntimeSettingsProjection,
  createRuntimeCredentialOverlay,
} from "../../../src/runtime/runtime-settings.ts";

const ENV_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;
let originalEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  originalEnvironment = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  process.env.OPENAI_API_KEY = "ambient-openai-decoy";
  process.env.ANTHROPIC_API_KEY = "ambient-anthropic-decoy";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function piOpenAiConfig(): ElizaConfig {
  const config = {
    serviceRouting: {
      llmText: {
        backend: "pi",
        transport: "direct",
        primaryModel: "openai/gpt-5.4-mini",
      },
    },
  } as ElizaConfig;
  applyPiProviderApiKeyReference(config, "openai", "providers.openai.api-key");
  return config;
}

function openAiResponsesSuccess(): Response {
  const events = [
    { type: "response.created", response: { id: "resp_test" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        status: "in_progress",
      },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: "PONG",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "PONG", annotations: [] }],
        status: "completed",
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  const body =
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}` +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function createInitializedPiRuntime(
  runtimeCredentialOverlay?: RuntimeCredentialOverlay,
): Promise<AgentRuntime> {
  const config = piOpenAiConfig();
  const settings = buildRuntimeSettingsProjection(config, {
    env: {},
    preferredProviderId: "pi",
    brainProviderName: "pi",
    runtimeCredentialOverlay,
  });
  const piPlugin = createPiPlugin();
  preparePreferredProviderPluginForBoot({
    resolvedPlugins: [{ name: "@elizaos/plugin-pi-ai", plugin: piPlugin }],
    preferredPackageName: "@elizaos/plugin-pi-ai",
    priorityBoost: 10,
    configProjection: settings,
  });
  const runtime = new AgentRuntime({
    logLevel: "fatal",
    settings,
    plugins: [piPlugin],
    disableBasicCapabilities: true,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
  });
  await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
  return runtime;
}

describe("Pi cold runtime credential projection", () => {
  it("isolates OpenAI→Anthropic credentials across real runtime construction", async () => {
    let config = {
      serviceRouting: {
        llmText: {
          backend: "pi",
          transport: "direct",
          primaryModel: "openai/gpt-5.4-mini",
        },
      },
    } as ElizaConfig;
    applyPiProviderApiKeyReference(
      config,
      "openai",
      "providers.openai.api-key",
    );

    const constructed: AgentRuntime[] = [];
    const strategy = createColdStrategy({
      restartRuntime: async (_reason, runtimeCredentialOverlay) => {
        const runtime = new AgentRuntime({
          logLevel: "fatal",
          settings: buildRuntimeSettingsProjection(config, {
            env: process.env,
            runtimeCredentialOverlay,
          }),
        });
        constructed.push(runtime);
        return runtime;
      },
    });
    const oldRuntime = new AgentRuntime({ logLevel: "fatal" });
    const openAIOverlay = createRuntimeCredentialOverlay(
      "OPENAI_API_KEY",
      "operation-openai-secret",
    );
    const openAIRuntime = await strategy.apply({
      runtime: oldRuntime,
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
        credentialProvider: "openai",
      },
      runtimeCredentialOverlay: openAIOverlay,
      reportPhase: async () => {},
    });

    config = structuredClone(config);
    config.serviceRouting = {
      llmText: {
        backend: "pi",
        transport: "direct",
        primaryModel: "anthropic/claude-sonnet-4-6",
      },
    };
    applyPiProviderApiKeyReference(
      config,
      "anthropic",
      "providers.anthropic.api-key",
    );
    const anthropicOverlay = createRuntimeCredentialOverlay(
      "ANTHROPIC_API_KEY",
      "operation-anthropic-secret",
    );
    const anthropicRuntime = await strategy.apply({
      runtime: openAIRuntime,
      intent: {
        kind: "provider-switch",
        provider: "pi",
        primaryModel: "anthropic/claude-sonnet-4-6",
        credentialProvider: "anthropic",
      },
      runtimeCredentialOverlay: anthropicOverlay,
      reportPhase: async () => {},
    });

    expect(constructed).toEqual([openAIRuntime, anthropicRuntime]);
    expect(openAIRuntime.getSetting("OPENAI_API_KEY")).toBe(
      "operation-openai-secret",
    );
    expect(openAIRuntime.getSetting("ANTHROPIC_API_KEY")).toBeNull();
    expect(anthropicRuntime.getSetting("ANTHROPIC_API_KEY")).toBe(
      "operation-anthropic-secret",
    );
    expect(anthropicRuntime.getSetting("OPENAI_API_KEY")).toBeNull();
    expect(process.env.OPENAI_API_KEY).toBe("ambient-openai-decoy");
    expect(process.env.ANTHROPIC_API_KEY).toBe("ambient-anthropic-decoy");
    expect(JSON.stringify(openAIOverlay)).not.toContain(
      "operation-openai-secret",
    );
    expect(JSON.stringify(anthropicOverlay)).not.toContain(
      "operation-anthropic-secret",
    );
    expect(JSON.stringify(config)).not.toContain("operation-anthropic-secret");
  });

  it("runs the exact provider smoke through the initialized real Pi plugin", async () => {
    const fetchMock = vi.fn(async () => openAiResponsesSuccess());
    vi.stubGlobal("fetch", fetchMock);
    const overlay = createRuntimeCredentialOverlay(
      "OPENAI_API_KEY",
      "operation-openai-secret",
    );
    const runtime = await createInitializedPiRuntime(overlay);

    try {
      expect(runtime.getSetting("OPENAI_API_KEY")).toBe(
        "operation-openai-secret",
      );
      expect(runtime.getSetting("ELIZA_BRAIN_PROVIDER")).toBe("pi");
      await expect(providerSmokeCheck.run(runtime)).resolves.toEqual({
        ok: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.stop();
    }
  });

  it("returns a typed missing-credential failure before provider transport", async () => {
    const fetchMock = vi.fn(async () => openAiResponsesSuccess());
    vi.stubGlobal("fetch", fetchMock);
    const runtime = await createInitializedPiRuntime();

    try {
      const result = await providerSmokeCheck.run(runtime);
      expect(result).toMatchObject({
        ok: false,
        cause: { code: "PI_CREDENTIAL_MISSING" },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
});
