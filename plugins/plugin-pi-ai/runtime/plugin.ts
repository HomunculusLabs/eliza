/**
 * Creates the opt-in Pi plugin with isolated provider, routing, and in-flight
 * text-call state for each elizaOS runtime.
 */
import {
  type CreateModelsOptions,
  type CredentialStore,
  createModels,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import {
  ElizaError,
  type GenerateTextParams,
  type IAgentRuntime,
  ModelType,
  type Plugin,
  type TextGenerationModelType,
  type TextStreamResult,
} from "@elizaos/core";
import {
  type PiCatalogSource,
  staticPiCatalogSource,
} from "../catalog/index.js";
import { CLOSED_PI_AUTH_CONTEXT } from "../credentials/closed-auth-context.js";
import { createRuntimeSettingsCredentialStore } from "../credentials/runtime-settings-store.js";
import {
  PI_TEXT_SLOTS,
  textSlotSettingChain,
  validatePiRouteSnapshot,
} from "../models/resolve-model.js";
import { handlePiText, type PiTextRuntimeState } from "../models/text.js";
import {
  CURATED_PI_PROVIDERS,
  type PiGatewayProvider,
  validatePiProviderManifest,
} from "../providers/manifest.js";

export type PiCredentialStoreFactory = (
  runtime: IAgentRuntime,
  providers: readonly PiGatewayProvider[],
) => CredentialStore;

export type PiModelsFactory = (options: CreateModelsOptions) => MutableModels;

export interface CreatePiPluginOptions {
  readonly credentialStoreFactory?: PiCredentialStoreFactory;
  readonly providerManifest?: readonly PiGatewayProvider[];
  readonly catalogSource?: PiCatalogSource;
  readonly modelsFactory?: PiModelsFactory;
}

export function createPiPlugin(options: CreatePiPluginOptions = {}): Plugin {
  const manifest = validatePiProviderManifest(
    options.providerManifest ?? CURATED_PI_PROVIDERS,
  );
  const credentialStoreFactory =
    options.credentialStoreFactory ?? createRuntimeSettingsCredentialStore;
  const modelsFactory = options.modelsFactory ?? createModels;
  const catalogSource = options.catalogSource ?? staticPiCatalogSource;
  const states = new WeakMap<IAgentRuntime, PiTextRuntimeState>();

  const textHandler =
    (slot: TextGenerationModelType) =>
    async (
      runtime: IAgentRuntime,
      params: GenerateTextParams,
    ): Promise<string | TextStreamResult> => {
      const state = states.get(runtime);
      if (state === undefined) {
        throw new ElizaError("Pi plugin is not initialized for this runtime", {
          code: "PI_NOT_INITIALIZED",
          context: { slot },
        });
      }
      return handlePiText(runtime, state, slot, params);
    };

  return {
    name: "pi",
    packageName: "@elizaos/plugin-pi-ai",
    description:
      "Opt-in provider-neutral text gateway backed by curated Pi AI providers",

    async init(
      config: Record<string, string>,
      runtime: IAgentRuntime,
    ): Promise<void> {
      const current = states.get(runtime);
      if (current !== undefined && !current.disposed) {
        throw new ElizaError(
          "Pi plugin is already initialized for this runtime",
          { code: "PI_ALREADY_INITIALIZED" },
        );
      }

      const routeSnapshot = validatePiRouteSnapshot({
        config,
        catalogSource,
        providerManifest: manifest,
      });
      const credentials = credentialStoreFactory(runtime, manifest);
      const models = modelsFactory({
        credentials,
        authContext: CLOSED_PI_AUTH_CONTEXT,
      });
      const providers = await Promise.all(
        manifest.map(async (entry): Promise<Provider> => {
          const provider = await entry.loadProvider();
          if (provider.id !== entry.id) {
            throw new ElizaError(
              "Pi provider loader returned the wrong identity",
              {
                code: "PI_INVALID_PROVIDER_MANIFEST",
                context: {
                  expectedProviderId: entry.id,
                  actualProviderId: provider.id,
                },
              },
            );
          }
          return provider;
        }),
      );

      for (const provider of providers) models.setProvider(provider);
      states.set(runtime, {
        routeSnapshot,
        credentials,
        models,
        providers: Object.freeze(providers),
        providerManifest: manifest,
        catalogSource,
        activeCalls: new Set(),
        activePumps: new Set(),
        disposed: false,
      });
    },

    applyConfig(config: Record<string, string>, runtime: IAgentRuntime): void {
      const state = states.get(runtime);
      if (state === undefined || state.disposed) {
        throw new ElizaError("Pi plugin is not initialized for this runtime", {
          code: "PI_NOT_INITIALIZED",
        });
      }
      state.routeSnapshot = validatePiRouteSnapshot({
        config,
        catalogSource: state.catalogSource,
        providerManifest: state.providerManifest,
      });
    },

    async dispose(runtime: IAgentRuntime): Promise<void> {
      const state = states.get(runtime);
      if (state === undefined) return;
      state.disposed = true;
      for (const controller of state.activeCalls) {
        controller.abort(new Error("Pi plugin disposed"));
      }
      if (state.activePumps.size > 0) {
        await Promise.allSettled([...state.activePumps]);
      }
      state.activeCalls.clear();
      state.activePumps.clear();
      state.models.clearProviders();
      states.delete(runtime);
    },

    models: {
      [ModelType.TEXT_NANO]: textHandler(ModelType.TEXT_NANO),
      [ModelType.TEXT_SMALL]: textHandler(ModelType.TEXT_SMALL),
      [ModelType.TEXT_MEDIUM]: textHandler(ModelType.TEXT_MEDIUM),
      [ModelType.TEXT_LARGE]: textHandler(ModelType.TEXT_LARGE),
      [ModelType.TEXT_MEGA]: textHandler(ModelType.TEXT_MEGA),
      [ModelType.RESPONSE_HANDLER]: textHandler(ModelType.RESPONSE_HANDLER),
      [ModelType.ACTION_PLANNER]: textHandler(ModelType.ACTION_PLANNER),
      [ModelType.TEXT_REASONING_SMALL]: textHandler(
        ModelType.TEXT_REASONING_SMALL,
      ),
      [ModelType.TEXT_REASONING_LARGE]: textHandler(
        ModelType.TEXT_REASONING_LARGE,
      ),
      [ModelType.TEXT_COMPLETION]: textHandler(ModelType.TEXT_COMPLETION),
    },

    modelMetadata: Object.fromEntries(
      PI_TEXT_SLOTS.map((slot) => [
        slot,
        {
          displayModelSettings: [...textSlotSettingChain(slot)],
          local: false,
          streamable: true,
        },
      ]),
    ),
  };
}
