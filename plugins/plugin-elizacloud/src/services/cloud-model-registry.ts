/** Fetches and caches available models from ElizaCloud. */

import { ElizaError, type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { CloudAuthService } from "./cloud-auth";
import {
  getLargeModel,
  getSmallModel,
  getSetting,
} from "../utils/config";

interface ModelListEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

interface ModelListResponse {
  object: string;
  data: ModelListEntry[];
}

export interface AvailableModel {
  id: string;
  provider: string;
  name: string;
  createdAt: number;
}

export interface ModelsByProvider {
  [provider: string]: AvailableModel[];
}

/**
 * Outcome of validating the EFFECTIVE chat-brain model ids (the ids the
 * TEXT_SMALL/TEXT_LARGE handlers will actually send) against the provider
 * catalog. Surfaced on `/api/status` as `modelValidation` so clients can
 * distinguish "configured model is gone" from a general provider outage
 * (#30228).
 *
 * - `unknown` — no authenticated catalog yet (never gates anything);
 * - `unavailable` — catalog fetch failed; transient warming stays retryable
 *   and must NOT be treated as model removal (never gates canRespond);
 * - `invalid_model` — the catalog loaded and a chat-brain id is absent: the
 *   run cannot answer; `invalid` names each config key + model id;
 * - `valid_model` — every effective chat-brain id is in the catalog.
 */
export interface CloudModelValidation {
  status: "unknown" | "unavailable" | "invalid_model" | "valid_model";
  invalid: Array<{ key: string; model: string }>;
  checkedAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const PROVIDER_PREFIXES: ReadonlyArray<[string, string]> = [
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["dall-e", "openai"],
  ["whisper", "openai"],
  ["tts", "openai"],
  ["claude-", "anthropic"],
  ["gemini-", "google"],
  ["llama", "meta"],
  ["deepseek", "deepseek"],
  ["grok", "xai"],
  ["kimi", "moonshot"],
];

function extractProvider(modelId: string): string {
  if (modelId.includes("/")) return modelId.split("/")[0];
  const lower = modelId.toLowerCase();
  for (const [prefix, provider] of PROVIDER_PREFIXES) {
    if (lower.startsWith(prefix)) return provider;
  }
  return "unknown";
}

function stripProvider(modelId: string): string {
  if (modelId.includes("/")) {
    return modelId.split("/").slice(1).join("/");
  }
  return modelId;
}

export class CloudModelRegistryService extends Service {
  static serviceType = "CLOUD_MODEL_REGISTRY";
  capabilityDescription = "Discovers and caches available AI models from ElizaCloud";

  private models: AvailableModel[] = [];
  private byProvider: ModelsByProvider = {};
  private lastFetchedAt = 0;
  private fetchPromise: Promise<void> | null = null;
  private chatBrainValidation: CloudModelValidation = {
    status: "unknown",
    invalid: [],
    checkedAt: 0,
  };

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const service = new CloudModelRegistryService(runtime);
    await service.initialize();
    return service;
  }

  async stop(): Promise<void> {
    this.models = [];
    this.byProvider = {};
    this.lastFetchedAt = 0;
    this.catalogLoaded = false;
    this.chatBrainValidation = {
      status: "unknown",
      invalid: [],
      checkedAt: 0,
    };
  }

  private async initialize(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;

    if (!auth?.isAuthenticated()) {
      logger.info("[CloudModelRegistry] Auth not available, will fetch models on first access");
      return;
    }

    await this.refreshCatalogAndValidate();
  }

  /**
   * Single catalog refresh + revalidation entry point. Every successful or
   * failed fetch transitions `chatBrainValidation` freshly, so a transient
   * `unavailable` never sticks after connectivity returns (#30228).
   */
  private async refreshCatalogAndValidate(): Promise<void> {
    // error-policy:J4 a catalog FETCH failure is transient warming — record
    // it as retryable `unavailable`, never as model removal, and never let
    // it fail service start. Only the fetch itself is inside this boundary;
    // validation runs after it on the successfully loaded catalog.
    try {
      await this.fetchModels();
    } catch (error) {
      this.chatBrainValidation = {
        status: "unavailable",
        invalid: [],
        checkedAt: Date.now(),
      };
      logger.warn(
        `[CloudModelRegistry] Catalog unavailable (${error instanceof Error ? error.message : String(error)}); chat-brain model validation will retry on next fetch`,
      );
      return;
    }
    // An unauthenticated no-op fetch loaded nothing — keep `unknown`; an
    // empty-but-loaded catalog IS authoritative and validates below.
    if (!this.catalogLoaded) return;
    this.validateConfiguredModels();
    this.validateChatBrainModels();
  }

  private async fetchModels(): Promise<boolean> {
    if (this.fetchPromise) {
      await this.fetchPromise;
      return this.catalogLoaded;
    }

    this.fetchPromise = this.doFetchModels();
    try {
      await this.fetchPromise;
    } finally {
      // Clear on BOTH outcomes: a retained rejected promise would make every
      // later fetch re-await the same failure, so a transient outage could
      // never recover (#30228).
      this.fetchPromise = null;
    }
    // A no-op pass (auth absent) loaded nothing — callers must not treat it
    // as an authoritative empty catalog.
    return this.catalogLoaded;
  }

  /** True once an authenticated /models response has actually been processed. */
  private catalogLoaded = false;

  private async doFetchModels(): Promise<void> {
    const auth = this.runtime.getService("CLOUD_AUTH") as CloudAuthService | undefined;
    if (!auth?.isAuthenticated()) return;

    const client = auth.getClient();

    const response = await client.get<ModelListResponse>("/models");
    const entries: ModelListEntry[] = response.data ?? [];

    this.models = entries.map((entry) => ({
      id: entry.id,
      provider: extractProvider(entry.id),
      name: stripProvider(entry.id),
      createdAt: entry.created,
    }));

    this.byProvider = {};
    for (const model of this.models) {
      if (!this.byProvider[model.provider]) {
        this.byProvider[model.provider] = [];
      }
      this.byProvider[model.provider].push(model);
    }

    this.lastFetchedAt = Date.now();
    this.catalogLoaded = true;
    logger.info(
      `[CloudModelRegistry] Loaded ${this.models.length} models from ${Object.keys(this.byProvider).length} providers`
    );
  }

  private validateConfiguredModels(): void {
    if (this.models.length === 0) return;

    const modelIds = new Set(this.models.map((m) => m.id));
    const nameSet = new Set(this.models.map((m) => m.name));

    const settingsToCheck = [
      { key: "ELIZAOS_CLOUD_NANO_MODEL", label: "nano model" },
      { key: "ELIZAOS_CLOUD_MEDIUM_MODEL", label: "medium model" },
      { key: "ELIZAOS_CLOUD_SMALL_MODEL", label: "small model" },
      { key: "ELIZAOS_CLOUD_LARGE_MODEL", label: "large model" },
      { key: "ELIZAOS_CLOUD_MEGA_MODEL", label: "mega model" },
      {
        key: "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
        label: "response handler model",
      },
      {
        key: "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
        label: "action planner model",
      },
      { key: "ELIZAOS_CLOUD_RESPONSE_MODEL", label: "response model" },
      { key: "ELIZAOS_CLOUD_EMBEDDING_MODEL", label: "embedding model" },
      {
        key: "ELIZAOS_CLOUD_IMAGE_DESCRIPTION_MODEL",
        label: "image description model",
      },
      {
        key: "ELIZAOS_CLOUD_IMAGE_GENERATION_MODEL",
        label: "image generation model",
      },
      { key: "ELIZAOS_CLOUD_TTS_MODEL", label: "TTS model" },
    ];

    for (const { key, label } of settingsToCheck) {
      const value = this.runtime.getSetting(key);
      if (value && typeof value === "string") {
        const found = modelIds.has(value) || nameSet.has(value);
        if (!found) {
          logger.warn(
            `[CloudModelRegistry] Configured ${label} "${value}" not found in available models. ` +
              "It may still work if the gateway supports it, but check your configuration."
          );
        }
      }
    }
  }

  /**
   * Validates the EFFECTIVE chat-brain model ids (what getSmallModel/
   * getLargeModel resolve to — the ids the TEXT_SMALL/TEXT_LARGE handlers
   * actually send) against the fetched catalog, recording a typed
   * {@link CloudModelValidation} and surfacing a missing model through
   * `runtime.reportError` with an actionable code naming the config key and
   * model (#30228). A stale `ELIZAOS_CLOUD_LARGE_MODEL` override previously
   * only logged a warning while `/api/status` kept reporting healthy
   * `canRespond`.
   *
   * Resolution note: when a tier override is set, the config key named in
   * `invalid` is that override key; when the id came from a bare `*_MODEL`
   * alias or the code default, the key names the setting the resolver reads
   * next. `unknown` (no authenticated catalog) and fetch failures never reach
   * this method — they stay non-gating by construction.
   */
  private validateChatBrainModels(): void {
    // The validation only describes the Cloud chat-brain handlers. When the
    // host wrote ELIZAOS_CLOUD_USE_INFERENCE=false, another provider owns the
    // text brain and a stale Cloud catalog entry must NEVER gate it — reset
    // to non-gating `unknown` (same state as an unloaded catalog).
    const useInference = getSetting(
      this.runtime,
      "ELIZAOS_CLOUD_USE_INFERENCE",
    );
    if (useInference?.trim().toLowerCase() === "false") {
      this.chatBrainValidation = {
        status: "unknown",
        invalid: [],
        checkedAt: Date.now(),
      };
      return;
    }
    // An EMPTY but successfully loaded catalog is authoritative: the effective
    // chat-brain ids cannot be in it, so the run cannot answer — record
    // invalid_model rather than staying permissive `unknown` (#30228).
    const modelIds = new Set(this.models.map((m) => m.id));
    const nameSet = new Set(this.models.map((m) => m.name));

    const slots: Array<{ label: string; keys: string[]; resolved: string }> = [
      {
        label: "small",
        keys: ["ELIZAOS_CLOUD_SMALL_MODEL", "SMALL_MODEL"],
        resolved: getSmallModel(this.runtime),
      },
      {
        label: "large",
        keys: ["ELIZAOS_CLOUD_LARGE_MODEL", "LARGE_MODEL"],
        resolved: getLargeModel(this.runtime),
      },
    ];

    const invalid: CloudModelValidation["invalid"] = [];
    for (const slot of slots) {
      if (modelIds.has(slot.resolved) || nameSet.has(slot.resolved)) continue;
      // Name the most specific configured key that produced the id: the
      // ELIZAOS_CLOUD_* override when set, else the bare alias tier setting.
      const key =
        slot.keys.find((k) => {
          const value = this.runtime.getSetting(k);
          return typeof value === "string" && value.trim().length > 0;
        }) ?? slot.keys[0];
      invalid.push({ key, model: slot.resolved });
    }

    this.chatBrainValidation = {
      status: invalid.length > 0 ? "invalid_model" : "valid_model",
      invalid,
      checkedAt: Date.now(),
    };

    if (invalid.length === 0) return;

    const detail = invalid
      .map((entry) => `${entry.key}="${entry.model}"`)
      .join(", ");
    // error-policy:J7 diagnostics must not kill the loop — the typed error is
    // reported through reportError (RECENT_ERRORS surfaces it) and the
    // validation state gates canRespond; the service keeps running.
    this.runtime.reportError?.(
      "CloudModelRegistry.validateChatBrainModels",
      new ElizaError(
        `Configured chat-brain model(s) not found in the Eliza Cloud catalog: ${detail}. Remove or update the stale override — the agent cannot answer until the configured model exists.`,
        {
          code: "ELIZA_CLOUD_MODEL_NOT_FOUND",
          context: { invalid, catalogSize: this.models.length },
        },
      ),
      { invalid },
    );
  }

  /** Current chat-brain validation snapshot for /api/status and canRespond gating. */
  getChatBrainValidation(): CloudModelValidation {
    return this.chatBrainValidation;
  }

  async getAvailableModels(): Promise<AvailableModel[]> {
    if (Date.now() - this.lastFetchedAt > CACHE_TTL_MS) {
      // Refresh through the revalidating path so a recovered catalog also
      // transitions chatBrainValidation (#30228).
      await this.refreshCatalogAndValidate();
    }
    return this.models;
  }

  async getModelsByProvider(): Promise<ModelsByProvider> {
    if (Date.now() - this.lastFetchedAt > CACHE_TTL_MS) {
      await this.refreshCatalogAndValidate();
    }
    return this.byProvider;
  }
}
