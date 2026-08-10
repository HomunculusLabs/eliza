/**
 * Exercises the typed boot boundary with deterministic phase doubles, including
 * ordering, immutable environment capture, policy parsing, and reverse cleanup.
 */
import { AgentRuntime, ModelType, type Plugin } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  BOOT_PHASES,
  type BootPhase,
  captureAgentEnvironment,
  createBootContext,
  preparePreferredProviderPluginForBoot,
  resolveBootPlan,
  resolveBootPolicy,
  runBootPhases,
} from "./boot-pipeline.ts";

describe("boot pipeline", () => {
  it("captures an immutable environment and parses named policy", () => {
    const source: NodeJS.ProcessEnv = {
      ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS: "yes",
      ELIZA_API_EXPOSE_PORT: "0",
    };
    const environment = captureAgentEnvironment(source);
    source.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "no";

    expect(environment.get("ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS")).toBe("yes");
    expect(resolveBootPolicy(environment)).toMatchObject({
      allowDestructiveMigrations: true,
      apiExposePort: false,
      preferredProviderPriorityBoost: 10,
    });
  });

  it("projects config and boosts all ten preferred text slots without changing direct providers", async () => {
    const textSlots = [
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
    ] as const;
    const models = Object.fromEntries(
      textSlots.map((slot) => [slot, async () => "ok"]),
    ) as Plugin["models"];
    const directPlugin: Plugin = {
      name: "openai",
      description: "direct provider fixture",
      priority: 1,
      models,
    };
    const piPlugin: Plugin = {
      name: "pi",
      description: "Pi gateway fixture",
      config: { EXISTING_SETTING: "kept" },
      models,
    };
    const resolved = [
      { name: "@elizaos/plugin-openai", plugin: directPlugin },
      { name: "@elizaos/plugin-pi-ai", plugin: piPlugin },
    ];

    const prepared = preparePreferredProviderPluginForBoot({
      resolvedPlugins: resolved,
      preferredPackageName: "@elizaos/plugin-pi-ai",
      priorityBoost: 10,
      configProjection: {
        ELIZA_LLM_TEXT_BACKEND: "pi",
        ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
        ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-nano",
      },
    });

    expect(prepared).toBe(piPlugin);
    expect(piPlugin.priority).toBe(10);
    expect(piPlugin.config).toEqual({
      EXISTING_SETTING: "kept",
      ELIZA_LLM_TEXT_BACKEND: "pi",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
      ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-nano",
    });
    expect(directPlugin.priority).toBe(1);
    expect(directPlugin.config).toBeUndefined();

    preparePreferredProviderPluginForBoot({
      resolvedPlugins: resolved,
      preferredPackageName: "@elizaos/plugin-openai",
      priorityBoost: 10,
      configProjection: {
        ELIZA_LLM_TEXT_BACKEND: "openai",
        ELIZA_LLM_TEXT_PRIMARY_MODEL: "gpt-5.6",
      },
    });
    expect(piPlugin.priority).toBeUndefined();
    expect(piPlugin.config).toEqual({ EXISTING_SETTING: "kept" });
    expect(directPlugin.priority).toBe(11);
    expect(directPlugin.config).toEqual({
      ELIZA_LLM_TEXT_BACKEND: "openai",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "gpt-5.6",
    });

    preparePreferredProviderPluginForBoot({
      resolvedPlugins: resolved,
      preferredPackageName: "@elizaos/plugin-pi-ai",
      priorityBoost: 10,
      configProjection: {
        ELIZA_LLM_TEXT_BACKEND: "pi",
        ELIZA_LLM_TEXT_PRIMARY_MODEL: "anthropic/claude-sonnet-4-6",
      },
    });
    expect(piPlugin.priority).toBe(10);
    expect(piPlugin.config).toEqual({
      EXISTING_SETTING: "kept",
      ELIZA_LLM_TEXT_BACKEND: "pi",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "anthropic/claude-sonnet-4-6",
    });
    expect(piPlugin.config).not.toHaveProperty("ELIZA_LLM_TEXT_SMALL_MODEL");
    expect(directPlugin.priority).toBe(1);
    expect(directPlugin.config).toBeUndefined();

    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await runtime.registerPlugin(directPlugin);
    await runtime.registerPlugin(piPlugin);
    for (const slot of textSlots) {
      expect(
        runtime
          .getModelRegistrations()
          .filter((registration) => registration.modelType === slot)
          .map(({ provider, priority }) => ({ provider, priority })),
      ).toEqual([
        { provider: "pi", priority: 10 },
        { provider: "openai", priority: 1 },
      ]);
    }
    await runtime.unloadPlugin("pi");
    await runtime.unloadPlugin("openai");
  });

  it("runs phases once in declared order and disposes in reverse order", async () => {
    const events: string[] = [];
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
      observePhase: (phase) => events.push(`enter:${phase}`),
    });
    const phases: BootPhase[] = BOOT_PHASES.slice(0, 3).map((name) => ({
      name,
      run: () => {
        events.push(`run:${name}`);
      },
      dispose: () => {
        events.push(`dispose:${name}`);
      },
    }));

    const dispose = await runBootPhases(context, phases);
    await dispose();

    expect(context.completedPhases).toEqual(BOOT_PHASES.slice(0, 3));
    expect(events).toEqual([
      "enter:load-config",
      "run:load-config",
      "enter:resolve-settings",
      "run:resolve-settings",
      "enter:resolve-plugin-plan",
      "run:resolve-plugin-plan",
      "dispose:resolve-plugin-plan",
      "dispose:resolve-settings",
      "dispose:load-config",
    ]);
  });

  it("cleans completed phases when a later phase fails", async () => {
    const disposeFirst = vi.fn();
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
    });

    await expect(
      runBootPhases(context, [
        { name: "load-config", run: vi.fn(), dispose: disposeFirst },
        {
          name: "resolve-settings",
          run: () => {
            throw new Error("settings failed");
          },
        },
      ]),
    ).rejects.toThrow("settings failed");
    expect(disposeFirst).toHaveBeenCalledOnce();
  });

  it("rejects duplicate or backward phase transitions", () => {
    const context = createBootContext({
      environment: captureAgentEnvironment({}),
    });
    context.enterPhase("resolve-settings");
    expect(() => context.enterPhase("load-config")).toThrow(
      "cannot follow resolve-settings",
    );
  });

  it.each([
    ["interactive", {}, true, false, true],
    ["headless", { headless: true }, false, false, true],
    ["server-only", { serverOnly: true }, true, false, true],
    [
      "local-agent",
      { serverOnly: true, localAgentMode: true },
      true,
      false,
      false,
    ],
    ["cloud", { headless: true }, true, true, true],
  ] as const)(
    "characterizes %s startup without running process infrastructure",
    (label, options, configured, cloudThinClient, bindApiListener) => {
      const plan = resolveBootPlan({
        ...options,
        configured,
        cloudThinClient,
        apiExposePort: false,
      });
      expect(plan).toMatchObject({
        hostMode: label === "cloud" ? "headless" : label,
        firstRun: !configured,
        runtimeMode: cloudThinClient ? "cloud" : "local",
        bindApiListener,
      });
    },
  );
});
