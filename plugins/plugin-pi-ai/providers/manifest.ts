/**
 * Defines and validates the only upstream provider identities this gateway may load.
 */
import type { Provider } from "@earendil-works/pi-ai";
import { ElizaError } from "@elizaos/core";
import type { PiGatewayProviderId } from "../catalog/index.js";
import { loadAnthropicProvider } from "./anthropic.js";
import { loadOpenAIProvider } from "./openai.js";

export type PiGatewaySettingKey = "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";

export interface PiGatewayProvider {
  readonly id: PiGatewayProviderId;
  readonly settingKey: PiGatewaySettingKey;
  readonly vaultProviderId: PiGatewayProviderId;
  loadProvider(): Promise<Provider>;
}

const expectedIdentities = {
  openai: {
    settingKey: "OPENAI_API_KEY",
    vaultProviderId: "openai",
  },
  anthropic: {
    settingKey: "ANTHROPIC_API_KEY",
    vaultProviderId: "anthropic",
  },
} as const satisfies Record<
  PiGatewayProviderId,
  {
    settingKey: PiGatewaySettingKey;
    vaultProviderId: PiGatewayProviderId;
  }
>;

export const CURATED_PI_PROVIDERS: readonly PiGatewayProvider[] = Object.freeze(
  [
    Object.freeze({
      id: "openai",
      ...expectedIdentities.openai,
      loadProvider: loadOpenAIProvider,
    }),
    Object.freeze({
      id: "anthropic",
      ...expectedIdentities.anthropic,
      loadProvider: loadAnthropicProvider,
    }),
  ],
);

export function validatePiProviderManifest(
  manifest: readonly PiGatewayProvider[],
): readonly PiGatewayProvider[] {
  if (manifest.length === 0) {
    throw new ElizaError("Pi provider manifest must not be empty", {
      code: "PI_INVALID_PROVIDER_MANIFEST",
    });
  }

  const seen = new Set<PiGatewayProviderId>();
  for (const provider of manifest) {
    const expected = expectedIdentities[provider.id];
    if (
      expected === undefined ||
      provider.settingKey !== expected.settingKey ||
      provider.vaultProviderId !== expected.vaultProviderId ||
      typeof provider.loadProvider !== "function" ||
      seen.has(provider.id)
    ) {
      throw new ElizaError(
        "Pi provider manifest contains an invalid identity",
        {
          code: "PI_INVALID_PROVIDER_MANIFEST",
          context: { providerId: provider.id },
        },
      );
    }
    seen.add(provider.id);
  }

  return Object.freeze([...manifest]);
}
