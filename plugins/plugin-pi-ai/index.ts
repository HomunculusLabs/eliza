/**
 * Exposes the opt-in Pi gateway factory and its dependency-injection boundaries.
 */

export type {
  PiCatalogSource,
  PiGatewayApi,
  PiGatewayProviderId,
  PiModelInput,
  PiStaticCatalogEntry,
  PiStaticModelCost,
  PiStaticModelCostRates,
  PiStaticModelCostTier,
} from "./catalog/index.js";
export {
  findPiStaticModel,
  PI_AI_VERSION,
  PI_STATIC_CATALOG,
  staticPiCatalogSource,
} from "./catalog/index.js";
export type { RuntimeSettingReader } from "./credentials/runtime-settings-store.js";
export {
  createRuntimeSettingsCredentialStore,
  RuntimeSettingsCredentialStore,
} from "./credentials/runtime-settings-store.js";
export type {
  PiGatewayProvider,
  PiGatewaySettingKey,
} from "./providers/manifest.js";
export {
  CURATED_PI_PROVIDERS,
  validatePiProviderManifest,
} from "./providers/manifest.js";
export type {
  CreatePiPluginOptions,
  PiCredentialStoreFactory,
  PiModelsFactory,
} from "./runtime/plugin.js";
export { createPiPlugin } from "./runtime/plugin.js";

import { createPiPlugin } from "./runtime/plugin.js";

const piPlugin = createPiPlugin();

export default piPlugin;
