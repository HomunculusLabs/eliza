/**
 * Focused deterministic coverage for canonical text-slot chains and qualified
 * per-call Pi model validation.
 */
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { staticPiCatalogSource } from "../catalog/index.js";
import {
  PI_TEXT_SLOTS,
  resolveQualifiedPiModel,
  textSlotSettingChain,
  validatePiRouteSnapshot,
} from "../models/resolve-model.js";
import { CURATED_PI_PROVIDERS } from "../providers/manifest.js";

const route = {
  ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
  ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-nano",
  ELIZA_LLM_TEXT_LARGE_MODEL: "anthropic/claude-sonnet-4-6",
  ELIZA_LLM_TEXT_PLANNER_MODEL: "anthropic/claude-opus-4-6",
};

const slotChains = [
  [
    ModelType.TEXT_NANO,
    [
      "ELIZA_LLM_TEXT_NANO_MODEL",
      "ELIZA_LLM_TEXT_SMALL_MODEL",
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
    ],
  ],
  [
    ModelType.TEXT_SMALL,
    ["ELIZA_LLM_TEXT_SMALL_MODEL", "ELIZA_LLM_TEXT_PRIMARY_MODEL"],
  ],
  [
    ModelType.TEXT_MEDIUM,
    [
      "ELIZA_LLM_TEXT_MEDIUM_MODEL",
      "ELIZA_LLM_TEXT_LARGE_MODEL",
      "ELIZA_LLM_TEXT_SMALL_MODEL",
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
    ],
  ],
  [
    ModelType.TEXT_LARGE,
    ["ELIZA_LLM_TEXT_LARGE_MODEL", "ELIZA_LLM_TEXT_PRIMARY_MODEL"],
  ],
  [
    ModelType.TEXT_MEGA,
    [
      "ELIZA_LLM_TEXT_MEGA_MODEL",
      "ELIZA_LLM_TEXT_LARGE_MODEL",
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
    ],
  ],
  [
    ModelType.RESPONSE_HANDLER,
    [
      "ELIZA_LLM_TEXT_RESPONSE_HANDLER_MODEL",
      "ELIZA_LLM_TEXT_SMALL_MODEL",
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
    ],
  ],
  [
    ModelType.ACTION_PLANNER,
    [
      "ELIZA_LLM_TEXT_ACTION_PLANNER_MODEL",
      "ELIZA_LLM_TEXT_PLANNER_MODEL",
      "ELIZA_LLM_TEXT_LARGE_MODEL",
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
    ],
  ],
  [
    ModelType.TEXT_REASONING_SMALL,
    ["ELIZA_LLM_TEXT_SMALL_MODEL", "ELIZA_LLM_TEXT_PRIMARY_MODEL"],
  ],
  [
    ModelType.TEXT_REASONING_LARGE,
    ["ELIZA_LLM_TEXT_LARGE_MODEL", "ELIZA_LLM_TEXT_PRIMARY_MODEL"],
  ],
  [
    ModelType.TEXT_COMPLETION,
    [
      "ELIZA_LLM_TEXT_PRIMARY_MODEL",
      "ELIZA_LLM_TEXT_LARGE_MODEL",
      "ELIZA_LLM_TEXT_SMALL_MODEL",
    ],
  ],
] as const;

describe("Pi model resolution", () => {
  it("defines exactly the ten text slots", () => {
    expect(PI_TEXT_SLOTS).toHaveLength(10);
    expect(new Set(PI_TEXT_SLOTS).size).toBe(10);
    expect(new Set(PI_TEXT_SLOTS)).toEqual(
      new Set(slotChains.map(([slot]) => slot)),
    );
  });

  it.each(slotChains)(
    "uses the settled canonical chain for %s",
    (slot, chain) => {
      expect(textSlotSettingChain(slot)).toEqual(chain);
    },
  );

  it("uses the first configured slot field and lets a qualified per-call model win", () => {
    const slot = resolveQualifiedPiModel({
      slot: ModelType.TEXT_MEDIUM,
      params: { prompt: "hi" },
      routeSnapshot: route,
      catalogSource: staticPiCatalogSource,
      providerManifest: CURATED_PI_PROVIDERS,
    });
    expect(slot.qualifiedModel).toBe("anthropic/claude-sonnet-4-6");

    const override = resolveQualifiedPiModel({
      slot: ModelType.TEXT_MEDIUM,
      params: { prompt: "hi", model: "openai/gpt-5.4" },
      routeSnapshot: route,
      catalogSource: staticPiCatalogSource,
      providerManifest: CURATED_PI_PROVIDERS,
    });
    expect(override.qualifiedModel).toBe("openai/gpt-5.4");
  });

  it("requires every registered text slot to resolve before snapshot acceptance", () => {
    for (const config of [
      {},
      { ELIZA_LLM_TEXT_NANO_MODEL: "openai/gpt-5.4-nano" },
      { ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-nano" },
    ]) {
      expect(() =>
        validatePiRouteSnapshot({
          config,
          catalogSource: staticPiCatalogSource,
          providerManifest: CURATED_PI_PROVIDERS,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PI_MODEL_NOT_CONFIGURED" }),
      );
    }
    expect(
      validatePiRouteSnapshot({
        config: {
          ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
        },
        catalogSource: staticPiCatalogSource,
        providerManifest: CURATED_PI_PROVIDERS,
      }),
    ).toEqual({ ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini" });
  });

  it("validates every configured canonical route before an atomic snapshot swap", () => {
    expect(() =>
      validatePiRouteSnapshot({
        config: {
          ...route,
          ELIZA_LLM_TEXT_NANO_MODEL: "openai/not-in-catalog",
        },
        catalogSource: staticPiCatalogSource,
        providerManifest: CURATED_PI_PROVIDERS,
      }),
    ).toThrow(/not present in the curated catalog/);
    expect(
      validatePiRouteSnapshot({
        config: route,
        catalogSource: staticPiCatalogSource,
        providerManifest: CURATED_PI_PROVIDERS,
      }),
    ).toEqual(route);
  });

  it("rejects unqualified/unknown IDs unless an unknown per-call model is explicit", () => {
    expect(() =>
      resolveQualifiedPiModel({
        slot: ModelType.TEXT_SMALL,
        params: { prompt: "hi", model: "gpt-5.4" },
        routeSnapshot: route,
        catalogSource: staticPiCatalogSource,
        providerManifest: CURATED_PI_PROVIDERS,
      }),
    ).toThrow(/provider-qualified/);

    const unknown = resolveQualifiedPiModel({
      slot: ModelType.TEXT_SMALL,
      params: {
        prompt: "hi",
        model: "openai/future-model",
        providerOptions: { pi: { allowUnknownModel: true } },
      },
      routeSnapshot: route,
      catalogSource: staticPiCatalogSource,
      providerManifest: CURATED_PI_PROVIDERS,
    });
    expect(unknown).toMatchObject({
      provider: "openai",
      modelId: "future-model",
      unknownModel: true,
    });
  });
});
