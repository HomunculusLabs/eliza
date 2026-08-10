/**
 * Deterministic collector coverage for canonical Pi backend ownership. The
 * generated backend map may activate Pi only for an exact direct llmText route;
 * credentials, installation metadata, aliases, and later additive paths cannot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  collectPluginNames,
  MODEL_PROVIDER_PLUGIN_NAMES,
  PROVIDER_BACKEND_PLUGIN_MAP,
} from "./plugin-collector.ts";

const PI_PACKAGE = "@elizaos/plugin-pi-ai";
const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ELIZA_PLATFORM",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_LOCAL_LLAMA",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function piRoute(overrides: Partial<ElizaConfig> = {}): ElizaConfig {
  return {
    serviceRouting: {
      llmText: {
        backend: "pi",
        transport: "direct",
        primaryModel: "openai/gpt-5.4-mini",
      },
    },
    ...overrides,
  } as ElizaConfig;
}

describe("Pi canonical backend collection", () => {
  it("classifies the generated Pi owner as a blocking model provider", () => {
    expect(PROVIDER_BACKEND_PLUGIN_MAP).toEqual({ pi: PI_PACKAGE });
    expect(MODEL_PROVIDER_PLUGIN_NAMES.has(PI_PACKAGE)).toBe(true);
  });

  it("collects Pi only for the exact direct canonical llmText backend", () => {
    const reasons = new Map<string, string>();
    const names = collectPluginNames(piRoute(), reasons);

    expect(names.has(PI_PACKAGE)).toBe(true);
    expect(reasons.get(PI_PACKAGE)).toBe("serviceRouting.llmText.backend: pi");

    for (const backend of ["pi-ai", "plugin-pi-ai", PI_PACKAGE]) {
      const aliasNames = collectPluginNames({
        serviceRouting: {
          llmText: {
            backend,
            transport: "direct",
            primaryModel: "openai/gpt-5.4-mini",
          },
        },
      } as ElizaConfig);
      expect(aliasNames.has(PI_PACKAGE)).toBe(false);
    }
  });

  it("does not activate Pi from upstream keys or installation metadata", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const names = collectPluginNames({
      plugins: {
        installs: {
          [PI_PACKAGE]: { version: "workspace" },
        },
      },
    } as unknown as ElizaConfig);

    expect(names.has(PI_PACKAGE)).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(true);
  });

  it("prunes additive Pi requests when another backend owns text", () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const names = collectPluginNames({
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
          primaryModel: "gpt-5.4-mini",
        },
      },
      plugins: {
        allow: ["pi-ai", PI_PACKAGE],
        entries: { "pi-ai": { enabled: true } },
        installs: { [PI_PACKAGE]: { version: "workspace" } },
      },
    } as unknown as ElizaConfig);

    expect(names.has(PI_PACKAGE)).toBe(false);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("honors explicit disable after canonical activation", () => {
    const names = collectPluginNames(
      piRoute({
        plugins: { entries: { "pi-ai": { enabled: false } } },
      } as Partial<ElizaConfig>),
    );

    expect(names.has(PI_PACKAGE)).toBe(false);
  });

  it("preserves remote and mobile pruning", () => {
    const remoteNames = collectPluginNames(
      piRoute({
        deploymentTarget: { runtime: "remote", provider: "remote" },
      } as Partial<ElizaConfig>),
    );
    expect(remoteNames.has(PI_PACKAGE)).toBe(false);

    process.env.ELIZA_PLATFORM = "android";
    const mobileNames = collectPluginNames(piRoute());
    expect(mobileNames.has(PI_PACKAGE)).toBe(false);
  });

  it("keeps an exact direct Pi route beside cloud-owned capabilities", () => {
    const names = collectPluginNames(
      piRoute({
        deploymentTarget: { runtime: "cloud", provider: "elizacloud" },
        serviceRouting: {
          llmText: {
            backend: "pi",
            transport: "direct",
            primaryModel: "anthropic/claude-sonnet-4-5",
          },
          media: { backend: "elizacloud", transport: "cloud-proxy" },
        },
      } as Partial<ElizaConfig>),
    );

    expect(names.has(PI_PACKAGE)).toBe(true);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });
});
