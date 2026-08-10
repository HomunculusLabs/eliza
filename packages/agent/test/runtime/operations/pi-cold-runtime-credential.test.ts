/**
 * Exercises the real cold-strategy-to-AgentRuntime construction boundary for
 * Pi credential overlays without booting provider networks or a database.
 */
import { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyPiProviderApiKeyReference } from "../../../src/api/provider-switch-config.ts";
import type { ElizaConfig } from "../../../src/config/config.ts";
import { createColdStrategy } from "../../../src/runtime/operations/cold-strategy.ts";
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
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

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
});
