/**
 * Publishes the audited offline OpenAI and Anthropic model snapshot without
 * constructing Pi providers, runtimes, credential stores, or network clients.
 */

export const PI_AI_VERSION = "0.84.1" as const;

export type PiGatewayProviderId = "openai" | "anthropic";
export type PiGatewayApi = "openai-responses" | "anthropic-messages";
export type PiModelInput = "text" | "image";

export interface PiStaticModelCostRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface PiStaticModelCostTier extends PiStaticModelCostRates {
  readonly inputTokensAbove: number;
}

export interface PiStaticModelCost extends PiStaticModelCostRates {
  readonly tiers?: readonly PiStaticModelCostTier[];
}

export interface PiStaticCatalogEntry {
  readonly qualifiedId: `${PiGatewayProviderId}/${string}`;
  readonly provider: PiGatewayProviderId;
  readonly modelId: string;
  readonly displayName: string;
  readonly api: PiGatewayApi;
  readonly input: readonly PiModelInput[];
  readonly reasoning: boolean;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Pi's audited USD rates per million tokens. */
  readonly costPerMillionTokens: PiStaticModelCost;
}

function freezeCost(cost: PiStaticModelCost): PiStaticModelCost {
  const tiers = cost.tiers?.map((tier) => Object.freeze({ ...tier }));
  return Object.freeze({
    ...cost,
    ...(tiers === undefined ? {} : { tiers: Object.freeze(tiers) }),
  });
}

const entries = [
  {
    qualifiedId: "openai/gpt-5.4-nano",
    provider: "openai",
    modelId: "gpt-5.4-nano",
    displayName: "GPT-5.4 nano",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPerMillionTokens: {
      input: 0.2,
      output: 1.25,
      cacheRead: 0.02,
      cacheWrite: 0,
    },
  },
  {
    qualifiedId: "openai/gpt-5.4-mini",
    provider: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT-5.4 mini",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    costPerMillionTokens: {
      input: 0.75,
      output: 4.5,
      cacheRead: 0.075,
      cacheWrite: 0,
    },
  },
  {
    qualifiedId: "openai/gpt-5.4",
    provider: "openai",
    modelId: "gpt-5.4",
    displayName: "GPT-5.4",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 272_000,
    maxOutputTokens: 128_000,
    costPerMillionTokens: {
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 5,
          output: 22.5,
          cacheRead: 0.5,
          cacheWrite: 0,
        },
      ],
    },
  },
  {
    qualifiedId: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5 (latest)",
    api: "anthropic-messages",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    costPerMillionTokens: {
      input: 1,
      output: 5,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    },
  },
  {
    qualifiedId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costPerMillionTokens: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
    },
  },
  {
    qualifiedId: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    api: "anthropic-messages",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    costPerMillionTokens: {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
] as const satisfies readonly PiStaticCatalogEntry[];

export const PI_STATIC_CATALOG: readonly PiStaticCatalogEntry[] = Object.freeze(
  entries.map((entry) =>
    Object.freeze({
      ...entry,
      input: Object.freeze([...entry.input]),
      costPerMillionTokens: freezeCost(entry.costPerMillionTokens),
    }),
  ),
);

export interface PiCatalogSource {
  getCatalog(provider?: PiGatewayProviderId): readonly PiStaticCatalogEntry[];
}

export const staticPiCatalogSource: PiCatalogSource = Object.freeze({
  getCatalog(provider?: PiGatewayProviderId): readonly PiStaticCatalogEntry[] {
    if (provider === undefined) return PI_STATIC_CATALOG;
    return PI_STATIC_CATALOG.filter((entry) => entry.provider === provider);
  },
});

export function findPiStaticModel(
  qualifiedId: string,
): PiStaticCatalogEntry | undefined {
  return PI_STATIC_CATALOG.find((entry) => entry.qualifiedId === qualifiedId);
}
