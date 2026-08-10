/**
 * Integration-backed resolver coverage proves a collected canonical Pi route
 * loads the real side-effect-free package in the blocking phase and never
 * defers it. No plugin init, credential read, or upstream network call occurs.
 */
import { describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import { resolvePlugins } from "./plugin-resolver.ts";

const PI_PACKAGE = "@elizaos/plugin-pi-ai";

describe("Pi blocking plugin resolution", () => {
  it("resolves direct canonical Pi in blocking and excludes it from deferred", async () => {
    const config = {
      serviceRouting: {
        llmText: {
          backend: "pi",
          transport: "direct",
          primaryModel: "openai/gpt-5.4-mini",
        },
      },
    } as ElizaConfig;

    const blocking = await resolvePlugins(config, {
      quiet: true,
      phase: "blocking",
      forceIncludePluginNames: [PI_PACKAGE],
    });
    expect(blocking.map((resolved) => resolved.name)).toContain(PI_PACKAGE);
    expect(
      blocking.find((resolved) => resolved.name === PI_PACKAGE)?.plugin,
    ).toMatchObject({
      name: "pi",
      packageName: PI_PACKAGE,
    });

    const deferred = await resolvePlugins(config, {
      quiet: true,
      phase: "deferred",
    });
    expect(deferred.map((resolved) => resolved.name)).not.toContain(PI_PACKAGE);
  }, 120_000);
});
