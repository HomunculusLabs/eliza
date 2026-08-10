/**
 * Derives model-selection identifiers from an ElizaConfig: the primary model id
 * (agents.defaults.model.primary), the preferred provider id (from the resolved
 * service-routing llmText transport/backend, falling back to a model-name hint),
 * and the plugin package that provider maps to. Returns undefined when nothing is
 * explicitly configured, so elizaOS falls back to whichever model plugin loads.
 */
import { LLM_TEXT_ROUTE_RUNTIME_SETTING_BY_FIELD } from "@elizaos/core";
import providerBackendPluginMap from "@elizaos/registry/first-party/provider-backend-plugin-map.json" with {
  type: "json",
};
import {
  getFirstRunProviderOption,
  normalizeFirstRunProviderId,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";

function trimEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const PROVIDER_BACKEND_PLUGIN_MAP: Readonly<Record<string, string>> =
  providerBackendPluginMap;

function resolveProviderIdFromSelectionHint(
  value: string | undefined,
): string | undefined {
  const trimmed = trimEnvString(value);
  if (!trimmed) return undefined;

  return (
    normalizeFirstRunProviderId(trimmed) ??
    normalizeFirstRunProviderId(trimmed.split("/", 1)[0]) ??
    undefined
  );
}

/**
 * Resolve the primary model identifier from Eliza config.
 *
 * Eliza stores the model under `agents.defaults.model.primary` as an
 * AgentModelListConfig object. Returns undefined when no model is
 * explicitly configured (elizaOS falls back to whichever model
 * plugin is loaded).
 */
/** @internal Exported for testing. */
export function resolvePrimaryModel(config: ElizaConfig): string | undefined {
  const modelConfig = config.agents?.defaults?.model;
  if (!modelConfig) return undefined;

  // AgentDefaultsConfig.model is AgentModelListConfig: { primary?, fallbacks? }
  return modelConfig.primary;
}

/**
 * Project the canonical text route into provider-neutral runtime setting keys.
 * The host merges this into runtime settings and the selected plugin config
 * before initialization, keeping persisted state solely in serviceRouting.
 */
export function resolveLlmTextRuntimeSettings(
  config: ElizaConfig,
): Record<string, string> {
  const route = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  if (!route) return {};

  return Object.fromEntries(
    Object.entries(LLM_TEXT_ROUTE_RUNTIME_SETTING_BY_FIELD).flatMap(
      ([field, settingKey]) => {
        const value = route[field as keyof typeof route];
        return typeof value === "string" && value.trim().length > 0
          ? [[settingKey, value.trim()]]
          : [];
      },
    ),
  );
}

/** @internal Exported for testing. */
export function resolvePreferredProviderId(
  config: ElizaConfig,
): string | undefined {
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const rawBackend = trimEnvString(llmText?.backend);
  const backend = normalizeFirstRunProviderId(rawBackend) ?? undefined;
  const exactBackendOwner = rawBackend
    ? PROVIDER_BACKEND_PLUGIN_MAP[rawBackend]
    : undefined;
  const aliasesBackendOwnedProvider =
    backend !== undefined && PROVIDER_BACKEND_PLUGIN_MAP[backend] !== undefined;

  if (llmText?.transport === "cloud-proxy" && backend === "elizacloud") {
    return "elizacloud";
  }

  if (llmText?.transport === "direct") {
    const directProvider =
      backend &&
      backend !== "elizacloud" &&
      (!aliasesBackendOwnedProvider || exactBackendOwner !== undefined)
        ? backend
        : undefined;
    return (
      directProvider ?? resolveProviderIdFromSelectionHint(llmText.primaryModel)
    );
  }

  if (llmText?.transport === "remote") {
    const remoteProvider =
      backend && backend !== "elizacloud" && !aliasesBackendOwnedProvider
        ? backend
        : undefined;
    return (
      remoteProvider ?? resolveProviderIdFromSelectionHint(llmText.primaryModel)
    );
  }

  return resolveProviderIdFromSelectionHint(resolvePrimaryModel(config));
}

/** @internal Exported for testing. */
export function resolvePreferredProviderPluginName(
  config: ElizaConfig,
): string | undefined {
  const llmText = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  )?.llmText;
  const backend = trimEnvString(llmText?.backend);
  if (llmText?.transport === "direct" && backend) {
    const canonicalOwner = PROVIDER_BACKEND_PLUGIN_MAP[backend];
    if (canonicalOwner) return canonicalOwner;
  }

  const providerId = resolvePreferredProviderId(config);
  return providerId
    ? getFirstRunProviderOption(providerId)?.pluginName
    : undefined;
}
