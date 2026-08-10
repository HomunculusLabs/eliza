/**
 * Resolves canonical text-slot settings and qualified per-call overrides without
 * consulting credentials or starting provider work.
 */
import {
  type GenerateTextParams,
  ModelType,
  type TextGenerationModelType,
} from "@elizaos/core";
import type {
  PiCatalogSource,
  PiGatewayProviderId,
  PiStaticCatalogEntry,
} from "../catalog/index.js";
import type { PiGatewayProvider } from "../providers/manifest.js";
import { PiTextError } from "./errors.js";

export interface ResolvedPiModelId {
  readonly qualifiedModel: string;
  readonly provider: PiGatewayProviderId;
  readonly modelId: string;
  readonly catalogEntry?: PiStaticCatalogEntry;
  readonly unknownModel: boolean;
}

export const PI_TEXT_SLOTS = Object.freeze([
  ModelType.TEXT_NANO,
  ModelType.TEXT_SMALL,
  ModelType.TEXT_MEDIUM,
  ModelType.TEXT_LARGE,
  ModelType.TEXT_MEGA,
  ModelType.RESPONSE_HANDLER,
  ModelType.ACTION_PLANNER,
  ModelType.TEXT_REASONING_SMALL,
  ModelType.TEXT_REASONING_LARGE,
  ModelType.TEXT_COMPLETION,
] as const satisfies readonly TextGenerationModelType[]);

const PRIMARY = "ELIZA_LLM_TEXT_PRIMARY_MODEL";
const SLOT_SETTING_CHAINS: Readonly<
  Record<TextGenerationModelType, readonly string[]>
> = Object.freeze({
  [ModelType.TEXT_NANO]: [
    "ELIZA_LLM_TEXT_NANO_MODEL",
    "ELIZA_LLM_TEXT_SMALL_MODEL",
    PRIMARY,
  ],
  [ModelType.TEXT_SMALL]: ["ELIZA_LLM_TEXT_SMALL_MODEL", PRIMARY],
  [ModelType.TEXT_MEDIUM]: [
    "ELIZA_LLM_TEXT_MEDIUM_MODEL",
    "ELIZA_LLM_TEXT_LARGE_MODEL",
    "ELIZA_LLM_TEXT_SMALL_MODEL",
    PRIMARY,
  ],
  [ModelType.TEXT_LARGE]: ["ELIZA_LLM_TEXT_LARGE_MODEL", PRIMARY],
  [ModelType.TEXT_MEGA]: [
    "ELIZA_LLM_TEXT_MEGA_MODEL",
    "ELIZA_LLM_TEXT_LARGE_MODEL",
    PRIMARY,
  ],
  [ModelType.RESPONSE_HANDLER]: [
    "ELIZA_LLM_TEXT_RESPONSE_HANDLER_MODEL",
    "ELIZA_LLM_TEXT_SMALL_MODEL",
    PRIMARY,
  ],
  [ModelType.ACTION_PLANNER]: [
    "ELIZA_LLM_TEXT_ACTION_PLANNER_MODEL",
    "ELIZA_LLM_TEXT_PLANNER_MODEL",
    "ELIZA_LLM_TEXT_LARGE_MODEL",
    PRIMARY,
  ],
  [ModelType.TEXT_REASONING_SMALL]: ["ELIZA_LLM_TEXT_SMALL_MODEL", PRIMARY],
  [ModelType.TEXT_REASONING_LARGE]: ["ELIZA_LLM_TEXT_LARGE_MODEL", PRIMARY],
  [ModelType.TEXT_COMPLETION]: [
    PRIMARY,
    "ELIZA_LLM_TEXT_LARGE_MODEL",
    "ELIZA_LLM_TEXT_SMALL_MODEL",
  ],
});

function hasInvalidModelCharacters(value: string): boolean {
  return [...value].some(
    (character) => /\s/.test(character) || character.charCodeAt(0) <= 0x1f,
  );
}

function piOptions(
  params: GenerateTextParams,
): Record<string, unknown> | undefined {
  const value = params.providerOptions?.pi;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function permitsUnknownPiModel(params: GenerateTextParams): boolean {
  return piOptions(params)?.allowUnknownModel === true;
}

export function resolveQualifiedPiModel(args: {
  slot: TextGenerationModelType;
  params: GenerateTextParams;
  routeSnapshot: Readonly<Record<string, string>>;
  catalogSource: PiCatalogSource;
  providerManifest: readonly PiGatewayProvider[];
}): ResolvedPiModelId {
  let candidate = args.params.model?.trim();
  if (!candidate) {
    for (const key of SLOT_SETTING_CHAINS[args.slot]) {
      const configured = args.routeSnapshot[key]?.trim();
      if (configured) {
        candidate = configured;
        break;
      }
    }
  }
  if (!candidate) {
    throw new PiTextError(`No Pi model is configured for ${args.slot}`, {
      code: "PI_MODEL_NOT_CONFIGURED",
      context: {
        slot: args.slot,
        settingChain: SLOT_SETTING_CHAINS[args.slot],
      },
    });
  }

  const slash = candidate.indexOf("/");
  if (slash <= 0 || slash === candidate.length - 1) {
    throw new PiTextError("Pi model IDs must be provider-qualified", {
      code: "PI_INVALID_MODEL_ID",
      context: { slot: args.slot, qualifiedModel: candidate },
    });
  }
  const provider = candidate.slice(0, slash);
  const modelId = candidate.slice(slash + 1);
  if (
    provider.trim() !== provider ||
    modelId.trim() !== modelId ||
    hasInvalidModelCharacters(modelId)
  ) {
    throw new PiTextError("Pi model IDs contain invalid whitespace", {
      code: "PI_INVALID_MODEL_ID",
      context: { slot: args.slot, qualifiedModel: candidate },
    });
  }
  const manifestEntry = args.providerManifest.find(
    (entry) => entry.id === provider,
  );
  if (manifestEntry === undefined) {
    throw new PiTextError(
      "Pi model uses a provider outside the curated manifest",
      {
        code: "PI_UNKNOWN_PROVIDER",
        context: { slot: args.slot, provider, qualifiedModel: candidate },
      },
    );
  }

  const catalogEntry = args.catalogSource
    .getCatalog(manifestEntry.id)
    .find((entry) => entry.qualifiedId === candidate);
  const unknownModel = catalogEntry === undefined;
  if (
    unknownModel &&
    !(args.params.model && permitsUnknownPiModel(args.params))
  ) {
    throw new PiTextError("Pi model is not present in the curated catalog", {
      code: "PI_INVALID_MODEL_ID",
      context: {
        slot: args.slot,
        provider,
        qualifiedModel: candidate,
        perCallOverride: args.params.model !== undefined,
      },
    });
  }

  return Object.freeze({
    qualifiedModel: candidate,
    provider: manifestEntry.id,
    modelId,
    ...(catalogEntry === undefined ? {} : { catalogEntry }),
    unknownModel,
  });
}

export function validatePiRouteSnapshot(args: {
  config: Record<string, string>;
  catalogSource: PiCatalogSource;
  providerManifest: readonly PiGatewayProvider[];
}): Readonly<Record<string, string>> {
  const snapshot = Object.freeze({ ...args.config });
  const settingKeys = new Set(Object.values(SLOT_SETTING_CHAINS).flat());
  for (const key of settingKeys) {
    if (!Object.hasOwn(snapshot, key)) continue;
    const configured = snapshot[key]?.trim();
    if (!configured) {
      throw new PiTextError("Configured Pi model setting cannot be empty", {
        code: "PI_INVALID_MODEL_ID",
        context: { settingKey: key },
      });
    }
    resolveQualifiedPiModel({
      slot: ModelType.TEXT_SMALL,
      params: { prompt: "route-validation", model: configured },
      routeSnapshot: {},
      catalogSource: args.catalogSource,
      providerManifest: args.providerManifest,
    });
  }
  for (const slot of PI_TEXT_SLOTS) {
    resolveQualifiedPiModel({
      slot,
      params: { prompt: "route-validation" },
      routeSnapshot: snapshot,
      catalogSource: args.catalogSource,
      providerManifest: args.providerManifest,
    });
  }
  return snapshot;
}

export function textSlotSettingChain(
  slot: TextGenerationModelType,
): readonly string[] {
  return SLOT_SETTING_CHAINS[slot];
}
