/**
 * Pins the hidden Pi provider identity across the canonical core contract and
 * its shared mirror. These tests cover alias normalization without treating
 * upstream OpenAI or Anthropic identities or environment keys as Pi signals.
 */
import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_PROVIDER_CATALOG as CORE_CATALOG,
  PI_CREDENTIAL_PROVIDERS as CORE_PI_CREDENTIAL_PROVIDERS,
  getFirstRunProviderOption as coreGetFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys as coreGetFirstRunProviderSignalEnvKeys,
  normalizeFirstRunProviderId as coreNormalizeFirstRunProviderId,
} from "../../../core/src/contracts/first-run-options";
import {
  FIRST_RUN_PROVIDER_CATALOG,
  getDirectAccountProviderForFirstRunProvider,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  normalizeFirstRunProviderId,
  PI_CREDENTIAL_PROVIDERS,
} from "./first-run-options";

const PI_ALIASES = [
  "pi",
  "PI",
  "pi-ai",
  "plugin-pi-ai",
  "@elizaos/plugin-pi-ai",
] as const;

describe("hidden Pi provider identity", () => {
  it("mirrors the minimal hidden identity in core and shared", () => {
    const sharedEntry = FIRST_RUN_PROVIDER_CATALOG.find(
      (provider) => provider.id === "pi",
    );
    const coreEntry = CORE_CATALOG.find((provider) => provider.id === "pi");

    expect(sharedEntry).toMatchObject({
      id: "pi",
      pluginName: "@elizaos/plugin-pi-ai",
      envKey: null,
      keyPrefix: null,
      family: "pi",
      authMode: "credentials",
      group: "local",
      supportsPrimaryModelOverride: true,
      onboardingVisible: false,
    });
    expect(coreEntry).toEqual(sharedEntry);
  });

  it("keeps the exact credential-provider union mirrored", () => {
    expect(PI_CREDENTIAL_PROVIDERS).toEqual(["openai", "anthropic"]);
    expect(CORE_PI_CREDENTIAL_PROVIDERS).toEqual(PI_CREDENTIAL_PROVIDERS);
  });

  it.each(PI_ALIASES)("normalizes %s to pi in both mirrors", (alias) => {
    expect(normalizeFirstRunProviderId(alias)).toBe("pi");
    expect(coreNormalizeFirstRunProviderId(alias)).toBe("pi");
    expect(getFirstRunProviderOption(alias)?.pluginName).toBe(
      "@elizaos/plugin-pi-ai",
    );
    expect(coreGetFirstRunProviderOption(alias)?.pluginName).toBe(
      "@elizaos/plugin-pi-ai",
    );
  });

  it("does not claim upstream provider aliases or environment signals", () => {
    expect(normalizeFirstRunProviderId("openai")).toBe("openai");
    expect(normalizeFirstRunProviderId("@elizaos/plugin-openai")).toBe(
      "openai",
    );
    expect(normalizeFirstRunProviderId("anthropic")).toBe("anthropic");
    expect(normalizeFirstRunProviderId("@elizaos/plugin-anthropic")).toBe(
      "anthropic",
    );
    expect(getFirstRunProviderSignalEnvKeys("pi")).toEqual([]);
    expect(coreGetFirstRunProviderSignalEnvKeys("pi")).toEqual([]);
    expect(getDirectAccountProviderForFirstRunProvider("pi")).toBeNull();
  });
});
