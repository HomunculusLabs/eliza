/**
 * Canonical Pi route resolution and provider-neutral runtime projection tests.
 * Uses in-memory ElizaConfig values only; no plugin module or provider is loaded.
 */
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  resolveLlmTextRuntimeSettings,
  resolvePreferredProviderId,
  resolvePreferredProviderPluginName,
} from "./model-resolution.ts";

function config(backend: string, transport: "direct" | "remote" = "direct") {
  return {
    serviceRouting: {
      llmText: {
        backend,
        transport,
        primaryModel: "openai/gpt-5.4-mini",
      },
    },
  } as ElizaConfig;
}

describe("Pi canonical model resolution", () => {
  it("resolves the exact direct Pi backend through generated ownership", () => {
    expect(resolvePreferredProviderId(config("pi"))).toBe("pi");
    expect(resolvePreferredProviderPluginName(config("pi"))).toBe(
      "@elizaos/plugin-pi-ai",
    );
  });

  it.each(["pi-ai", "plugin-pi-ai", "@elizaos/plugin-pi-ai"])(
    "does not treat backend alias %s as canonical Pi activation",
    (backend) => {
      expect(resolvePreferredProviderId(config(backend))).toBe("openai");
      expect(resolvePreferredProviderPluginName(config(backend))).toBe(
        "@elizaos/plugin-openai",
      );
    },
  );

  it("does not select a backend-owned gateway for remote transport", () => {
    expect(resolvePreferredProviderId(config("pi", "remote"))).toBe("openai");
    expect(resolvePreferredProviderPluginName(config("pi", "remote"))).toBe(
      "@elizaos/plugin-openai",
    );
  });

  it("projects every canonical Pi text model field and no unrelated route field", () => {
    const settings = resolveLlmTextRuntimeSettings({
      serviceRouting: {
        llmText: {
          backend: " pi ",
          transport: "direct",
          primaryModel: " openai/gpt-5.4-mini ",
          nanoModel: "openai/gpt-5.4-nano",
          smallModel: "openai/gpt-5.4-mini",
          mediumModel: "anthropic/claude-haiku-4-5",
          largeModel: "anthropic/claude-sonnet-4-5",
          megaModel: "anthropic/claude-opus-4-1",
          responseHandlerModel: "openai/gpt-5.4-mini",
          actionPlannerModel: "anthropic/claude-sonnet-4-5",
          plannerModel: "anthropic/claude-opus-4-1",
          shouldRespondModel: "not-projected",
          responseModel: "not-projected",
        },
      },
    } as ElizaConfig);

    expect(settings).toEqual({
      ELIZA_LLM_TEXT_BACKEND: "pi",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_NANO_MODEL: "openai/gpt-5.4-nano",
      ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_MEDIUM_MODEL: "anthropic/claude-haiku-4-5",
      ELIZA_LLM_TEXT_LARGE_MODEL: "anthropic/claude-sonnet-4-5",
      ELIZA_LLM_TEXT_MEGA_MODEL: "anthropic/claude-opus-4-1",
      ELIZA_LLM_TEXT_RESPONSE_HANDLER_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_ACTION_PLANNER_MODEL: "anthropic/claude-sonnet-4-5",
      ELIZA_LLM_TEXT_PLANNER_MODEL: "anthropic/claude-opus-4-1",
    });
    expect(Object.values(settings)).not.toContain("not-projected");
  });
});
