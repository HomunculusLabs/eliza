/**
 * Guards canonical provider-backend ownership generation independently from
 * environment-key auto-enable metadata. The real generated artifact must give
 * Pi sole ownership of `pi`, while malformed and duplicate claims fail before
 * registry data can ship.
 */
import { describe, expect, it } from "vitest";
import {
  collectProviderBackendPluginMap,
  collectProviderPluginMap,
} from "./generate";
import providerBackendPluginMap from "./provider-backend-plugin-map.json" with {
  type: "json",
};
import { type RegistryEntry, registryEntrySchema } from "./schema";

function backendEntry(
  id: string,
  npmName: string | undefined,
  providerBackends: string[],
): RegistryEntry {
  return registryEntrySchema.parse({
    id,
    name: id,
    npmName,
    providerBackends,
    render: { visible: false, group: "ai-provider" },
    kind: "plugin",
    subtype: "ai-provider",
  });
}

describe("provider backend plugin map generation", () => {
  it("assigns only the canonical pi backend to the Pi package", () => {
    expect(providerBackendPluginMap).toEqual({
      pi: "@elizaos/plugin-pi-ai",
    });
    expect(providerBackendPluginMap).not.toHaveProperty("openai");
    expect(providerBackendPluginMap).not.toHaveProperty("anthropic");
  });

  it("keeps backend ownership independent from environment auto-enable", () => {
    const piEntry = backendEntry("pi-ai", "@elizaos/plugin-pi-ai", ["pi"]);
    expect(collectProviderBackendPluginMap([piEntry])).toEqual({
      pi: "@elizaos/plugin-pi-ai",
    });
    expect(collectProviderPluginMap([piEntry])).toEqual({});
  });

  it("sorts backend keys for a stable generated artifact", () => {
    expect(
      Object.keys(
        collectProviderBackendPluginMap([
          backendEntry("zeta", "@elizaos/plugin-zeta", ["zeta"]),
          backendEntry("alpha", "@elizaos/plugin-alpha", ["alpha"]),
        ]),
      ),
    ).toEqual(["alpha", "zeta"]);
  });

  it("rejects duplicate backend owners", () => {
    expect(() =>
      collectProviderBackendPluginMap([
        backendEntry("one", "@elizaos/plugin-one", ["duplicate"]),
        backendEntry("two", "@elizaos/plugin-two", ["duplicate"]),
      ]),
    ).toThrow(
      'provider backend "duplicate" claimed by both @elizaos/plugin-one and @elizaos/plugin-two',
    );
  });

  it("rejects a backend claim without an owning package", () => {
    expect(() =>
      collectProviderBackendPluginMap([
        backendEntry("ownerless", undefined, ["ownerless"]),
      ]),
    ).toThrow(
      'provider backend "ownerless" claimed by ownerless without an npmName',
    );
  });

  it.each(["", "Pi", "pi_ai", " pi", "pi/ai"])(
    "rejects malformed backend id %j",
    (providerBackend) => {
      expect(
        registryEntrySchema.safeParse({
          id: "invalid",
          name: "invalid",
          npmName: "@elizaos/plugin-invalid",
          providerBackends: [providerBackend],
          render: { visible: false, group: "ai-provider" },
          kind: "plugin",
          subtype: "ai-provider",
        }).success,
      ).toBe(false);
    },
  );

  it("rejects duplicate backend ids within one entry", () => {
    expect(
      registryEntrySchema.safeParse({
        id: "duplicate",
        name: "duplicate",
        npmName: "@elizaos/plugin-duplicate",
        providerBackends: ["same", "same"],
        render: { visible: false, group: "ai-provider" },
        kind: "plugin",
        subtype: "ai-provider",
      }).success,
    ).toBe(false);
  });
});
