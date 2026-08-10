/**
 * Adapts runtime-scoped settings to Pi's credential API while denying mutation.
 */
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { ElizaError } from "@elizaos/core";
import {
  type PiGatewayProvider,
  validatePiProviderManifest,
} from "../providers/manifest.js";

export interface RuntimeSettingReader {
  getSetting(key: string): string | boolean | number | null;
}

function assertNotAborted(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted();
}

function readonlyMutationError(providerId: string): ElizaError {
  return new ElizaError(
    "Pi credentials are read-only in this integration phase",
    {
      code: "PI_CREDENTIAL_STORE_READ_ONLY",
      context: { providerId },
    },
  );
}

export class RuntimeSettingsCredentialStore implements CredentialStore {
  readonly #runtime: RuntimeSettingReader;
  readonly #settingsByProvider: ReadonlyMap<string, string>;

  constructor(
    runtime: RuntimeSettingReader,
    providers: readonly PiGatewayProvider[],
  ) {
    this.#runtime = runtime;
    const manifest = validatePiProviderManifest(providers);
    this.#settingsByProvider = new Map(
      manifest.map((provider) => [provider.id, provider.settingKey]),
    );
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    assertNotAborted(options);
    const settingKey = this.#settingsByProvider.get(providerId);
    if (settingKey === undefined) return undefined;

    const value = this.#runtime.getSetting(settingKey);
    assertNotAborted(options);
    if (typeof value !== "string") return undefined;
    const key = value.trim();
    if (key.length === 0) return undefined;
    return { type: "api_key", key };
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    assertNotAborted(options);
    const credentials: CredentialInfo[] = [];
    for (const providerId of this.#settingsByProvider.keys()) {
      if ((await this.read(providerId, options)) !== undefined) {
        credentials.push({ providerId, type: "api_key" });
      }
    }
    return credentials;
  }

  async modify(
    providerId: string,
    _modify: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    assertNotAborted(options);
    throw readonlyMutationError(providerId);
  }

  async delete(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<void> {
    assertNotAborted(options);
    throw readonlyMutationError(providerId);
  }
}

export function createRuntimeSettingsCredentialStore(
  runtime: RuntimeSettingReader,
  providers: readonly PiGatewayProvider[],
): CredentialStore {
  return new RuntimeSettingsCredentialStore(runtime, providers);
}
