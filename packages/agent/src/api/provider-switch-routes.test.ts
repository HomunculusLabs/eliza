/**
 * Exercises authenticated Pi provider switching with an in-memory operation
 * boundary and deterministic vault. The suite covers validation, exact upstream
 * references, accepted-only idempotency, redaction, and compensation without a
 * live provider or runtime.
 */
import type http from "node:http";
import type { SecretsManager, SetOptions } from "@elizaos/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type {
  OperationIntent,
  OperationStatus,
  RuntimeOperation,
  RuntimeOperationManager,
  StartOperationRequest,
} from "../runtime/operations/index.ts";
import {
  handleProviderSwitchRoutes,
  type ProviderSwitchRouteContext,
} from "./provider-switch-routes.ts";

interface CapturedResponse {
  data?: unknown;
  status?: number;
}

function operation(
  intent: OperationIntent,
  status: OperationStatus = "pending",
): RuntimeOperation {
  return {
    id: "operation-1",
    kind: intent.kind,
    intent,
    tier: "cold",
    status,
    phases: [],
    startedAt: 1,
  };
}

function createCredentialVault(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const vault = {
    has: vi.fn(async (key: string) => values.has(key)),
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    }),
    set: vi.fn(async (key: string, value: string, _options?: SetOptions) => {
      values.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
  return {
    values,
    vault,
    secretsManager: { vault } as unknown as SecretsManager,
  };
}

function createHarness(args: {
  body: Record<string, unknown>;
  config?: ElizaConfig;
  headers?: http.IncomingHttpHeaders;
  secretsManager?: SecretsManager;
  dedupedStatus?: OperationStatus;
  onSave?: (config: ElizaConfig) => void;
  onStart?: (
    request: StartOperationRequest,
  ) => Promise<OperationIntent | undefined>;
}) {
  const response: CapturedResponse = {};
  const saveElizaConfig = vi.fn((config: ElizaConfig) => {
    args.onSave?.(config);
  });
  let capturedRequest: StartOperationRequest | undefined;
  let preparedIntent: OperationIntent | undefined;
  const runtimeOperationManager: RuntimeOperationManager = {
    start: vi.fn(async (request) => {
      capturedRequest = request;
      if (args.dedupedStatus) {
        return {
          kind: "deduped" as const,
          operation: operation(request.intent, args.dedupedStatus),
        };
      }
      preparedIntent = args.onStart
        ? await args.onStart(request)
        : ((await request.prepare?.()) ?? request.intent);
      return {
        kind: "accepted" as const,
        operation: operation(preparedIntent ?? request.intent),
      };
    }),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    findActive: vi.fn(async () => null),
  };
  const config =
    args.config ??
    ({
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
          primaryModel: "gpt-5",
        },
      },
    } as ElizaConfig);
  const context: ProviderSwitchRouteContext = {
    req: { headers: args.headers ?? {} } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/provider/switch",
    state: { config },
    json: (_res, data, status) => {
      response.data = data;
      response.status = status;
    },
    error: (_res, message, status) => {
      response.data = { error: message };
      response.status = status;
    },
    readJsonBody: async <T extends object>() => args.body as T,
    saveElizaConfig,
    scheduleRuntimeRestart: vi.fn(),
    runtimeOperationManager,
    secretsManager: args.secretsManager,
  };

  return {
    capturedRequest: () => capturedRequest,
    preparedIntent: () => preparedIntent,
    currentConfig: () => context.state.config,
    initialConfig: config,
    context,
    response,
    runtimeOperationManager,
    saveElizaConfig,
  };
}

const ORIGINAL_ENVIRONMENT = {
  PI_SWITCH_COMPENSATION_TEST: process.env.PI_SWITCH_COMPENSATION_TEST,
  ELIZAOS_CLOUD_ENABLED: process.env.ELIZAOS_CLOUD_ENABLED,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
} as const;

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("POST /api/provider/switch for Pi", () => {
  it.each([
    undefined,
    "gpt-5",
    "/gpt-5",
    "openai/",
    " openai/gpt-5",
    "openai/gpt-5 ",
    "openai/gpt 5",
    "openai/gpt\n5",
    `openai/gpt${String.fromCharCode(0x7f)}5`,
    "OpenAI/gpt-5",
    "openai//gpt-5",
    "openai/./gpt-5",
    "openai/../gpt-5",
    "openai/gpt-5/",
  ])("rejects unqualified primaryModel %s", async (primaryModel) => {
    const harness = createHarness({
      body: { provider: "pi", ...(primaryModel ? { primaryModel } : {}) },
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(harness.response.status).toBe(400);
    expect(harness.response.data).toEqual({
      error:
        "Pi requires a provider-qualified primaryModel using openai/<model> or anthropic/<model>.",
    });
    expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
  });

  it.each(["", "   ", null, 7])(
    "rejects missing Pi API key %j before vault or operation work",
    async (apiKey) => {
      const harness = createHarness({
        body: { provider: "pi", primaryModel: "openai/gpt-5", apiKey },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(harness.response.status).toBe(400);
      expect(harness.response.data).toEqual({
        error: "Pi API key must be a non-empty string.",
      });
      expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
    },
  );

  it("retains the schema API-key size cap", async () => {
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "openai/gpt-5",
        apiKey: "x".repeat(513),
      },
    });
    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(harness.response).toEqual({
      status: 400,
      data: { error: "API key is too long" },
    });
    expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
  });

  it.each([
    ["openai/gpt-5", "anthropic"],
    ["anthropic/claude-sonnet-4-6", "openai"],
  ] as const)(
    "rejects mismatched credentialProvider before operation work: %s → %s",
    async (primaryModel, credentialProvider) => {
      const harness = createHarness({
        body: { provider: "pi", primaryModel, credentialProvider },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(harness.response.status).toBe(400);
      expect(harness.response.data).toEqual({
        error:
          "Pi credentialProvider must match the provider prefix of primaryModel.",
      });
      expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
      expect(harness.saveElizaConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["google", "OpenAI", " openai", null])(
    "rejects unsupported credentialProvider %j at the request schema",
    async (credentialProvider) => {
      const harness = createHarness({
        body: {
          provider: "pi",
          primaryModel: "openai/gpt-5",
          credentialProvider,
        },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(harness.response.status).toBe(400);
      expect(harness.response.data).toEqual({
        error: "credentialProvider must be either openai or anthropic",
      });
      expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
    },
  );

  it("rejects credentialProvider on a non-Pi switch", async () => {
    const harness = createHarness({
      body: {
        provider: "openai",
        primaryModel: "gpt-5",
        credentialProvider: "openai",
      },
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(harness.response.status).toBe(400);
    expect(harness.response.data).toEqual({
      error: "credentialProvider is only supported when provider is pi.",
    });
    expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
  });

  it("accepts a qualified config-only switch and saves a cloned config", async () => {
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "openai/models/gpt-5:preview",
        credentialProvider: "openai",
      },
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(harness.response.status).toBe(202);
    expect(harness.currentConfig()).not.toBe(harness.initialConfig);
    expect(harness.currentConfig().serviceRouting?.llmText).toMatchObject({
      backend: "pi",
      transport: "direct",
      primaryModel: "openai/models/gpt-5:preview",
    });
    expect(harness.saveElizaConfig).toHaveBeenCalledTimes(1);
    expect(harness.capturedRequest()?.compensation).toMatchObject({
      restartPreviousRuntime: true,
      previousRuntimeExpectedTextProvider: true,
    });
    expect(harness.preparedIntent()).toEqual({
      kind: "provider-switch",
      provider: "pi",
      primaryModel: "openai/models/gpt-5:preview",
      credentialProvider: "openai",
    });
  });

  it("marks a provider-less previous configuration for rollback health policy", async () => {
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
        credentialProvider: "openai",
      },
      config: {} as ElizaConfig,
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(harness.capturedRequest()?.compensation).toMatchObject({
      restartPreviousRuntime: true,
      previousRuntimeExpectedTextProvider: false,
    });
  });

  it.each([
    ["openai/gpt-5.4-mini", "openai", "OPENAI_API_KEY"],
    ["anthropic/claude-sonnet-4-6", "anthropic", "ANTHROPIC_API_KEY"],
  ] as const)(
    "stores %s only at the exact upstream reference",
    async (primaryModel, credentialProvider, environmentKey) => {
      const apiKey = `secret-${credentialProvider}-transaction`;
      const credentialVault = createCredentialVault();
      const harness = createHarness({
        body: { provider: "pi", primaryModel, credentialProvider, apiKey },
        secretsManager: credentialVault.secretsManager,
        headers: { "idempotency-key": `switch-${credentialProvider}` },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      const apiKeyRef = `providers.${credentialProvider}.api-key`;
      expect(credentialVault.vault.set).toHaveBeenCalledOnce();
      expect(credentialVault.vault.set).toHaveBeenCalledWith(
        apiKeyRef,
        apiKey,
        { sensitive: true, caller: "provider-switch-route" },
      );
      expect(credentialVault.values.get(apiKeyRef)).toBe(apiKey);
      const config = harness.currentConfig();
      expect((config.env as Record<string, unknown>)?.[environmentKey]).toBe(
        `vault://${apiKeyRef}`,
      );
      expect(config.env?.vars?.[environmentKey]).toBe(`vault://${apiKeyRef}`);
      expect(process.env[environmentKey]).toBeUndefined();
      expect(harness.capturedRequest()?.runtimeCredentialOverlay).toMatchObject(
        {
          settingKey: environmentKey,
        },
      );
      expect(harness.capturedRequest()?.runtimeCredentialOverlay?.read()).toBe(
        apiKey,
      );
      expect(
        JSON.stringify(harness.capturedRequest()?.runtimeCredentialOverlay),
      ).not.toContain(apiKey);
      expect(harness.preparedIntent()).toEqual({
        kind: "provider-switch",
        provider: "pi",
        primaryModel,
        credentialProvider,
        apiKeyRef,
      });
      const serialized = JSON.stringify({
        config,
        intent: harness.preparedIntent(),
        response: harness.response.data,
      });
      expect(serialized).not.toContain(apiKey);
      expect(serialized).toContain(apiKeyRef);
    },
  );

  it("sanitizes stale non-selected config credentials without changing the host environment", async () => {
    process.env.OPENAI_API_KEY = "host-openai-direct";
    process.env.ANTHROPIC_API_KEY = "host-anthropic-direct";
    const config = {
      serviceRouting: {
        llmText: {
          backend: "openai",
          transport: "direct",
          primaryModel: "gpt-5",
        },
      },
      env: {
        OPENAI_API_KEY: "legacy-openai-plaintext",
        ANTHROPIC_API_KEY: "vault://providers.anthropic.old-api-key",
        vars: {
          OPENAI_API_KEY: "legacy-openai-plaintext",
          ANTHROPIC_API_KEY: "vault://providers.anthropic.old-api-key",
        },
      },
    } as ElizaConfig;
    const credentialVault = createCredentialVault();
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "anthropic/claude-sonnet-4-6",
        credentialProvider: "anthropic",
        apiKey: "new-anthropic-secret",
      },
      config,
      secretsManager: credentialVault.secretsManager,
    });

    await handleProviderSwitchRoutes(harness.context);

    const nextConfig = harness.currentConfig();
    expect(
      (nextConfig.env as Record<string, unknown>).OPENAI_API_KEY,
    ).toBeUndefined();
    expect(nextConfig.env?.vars?.OPENAI_API_KEY).toBeUndefined();
    expect((nextConfig.env as Record<string, unknown>).ANTHROPIC_API_KEY).toBe(
      "vault://providers.anthropic.api-key",
    );
    expect(nextConfig.env?.vars?.ANTHROPIC_API_KEY).toBe(
      "vault://providers.anthropic.api-key",
    );
    expect(JSON.stringify(nextConfig)).not.toContain("legacy-openai-plaintext");
    expect(process.env.OPENAI_API_KEY).toBe("host-openai-direct");
    expect(process.env.ANTHROPIC_API_KEY).toBe("host-anthropic-direct");
  });

  it.each([true, false])(
    "restores prior vault %s, config, and scoped environment together",
    async (priorSecretExists) => {
      const apiKeyRef = "providers.openai.api-key";
      const priorSecret = "prior-openai-secret";
      const nextSecret = "next-openai-secret";
      const credentialVault = createCredentialVault(
        priorSecretExists ? { [apiKeyRef]: priorSecret } : {},
      );
      process.env.OPENAI_API_KEY = priorSecretExists
        ? priorSecret
        : "host-openai-before";
      process.env.ELIZAOS_CLOUD_ENABLED = "before";
      process.env.PI_SWITCH_COMPENSATION_TEST = "before";
      const config = {
        serviceRouting: {
          llmText: {
            backend: "openai",
            transport: "direct",
            primaryModel: "gpt-5",
          },
        },
        env: { vars: { EXISTING_SETTING: "before" } },
      } as ElizaConfig;
      const originalConfig = structuredClone(config);
      const harness = createHarness({
        body: {
          provider: "pi",
          primaryModel: "openai/gpt-5.4-mini",
          apiKey: nextSecret,
        },
        config,
        secretsManager: credentialVault.secretsManager,
        onStart: async (request) => {
          const prepared = await request.prepare?.();
          expect(process.env.OPENAI_API_KEY).toBe(
            priorSecretExists ? priorSecret : "host-openai-before",
          );
          expect(request.runtimeCredentialOverlay?.read()).toBe(nextSecret);
          process.env.PI_SWITCH_COMPENSATION_TEST = "concurrent-update";
          harness.currentConfig().env = {
            vars: { ADDED_DURING_SWITCH: "during" },
          };
          await request.compensation?.restore();
          return prepared;
        },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(harness.currentConfig()).toEqual(originalConfig);
      expect(process.env.OPENAI_API_KEY).toBe(
        priorSecretExists ? priorSecret : "host-openai-before",
      );
      expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("before");
      expect(process.env.PI_SWITCH_COMPENSATION_TEST).toBe("concurrent-update");
      expect(harness.saveElizaConfig).toHaveBeenCalledTimes(2);
      if (priorSecretExists) {
        expect(credentialVault.values.get(apiKeyRef)).toBe(priorSecret);
        expect(credentialVault.vault.set).toHaveBeenCalledTimes(2);
      } else {
        expect(credentialVault.values.has(apiKeyRef)).toBe(false);
        expect(credentialVault.vault.remove).toHaveBeenCalledWith(apiKeyRef);
      }
    },
  );

  it.each([
    ["vault", ["vault"]],
    ["config", ["config-environment"]],
    ["combined", ["vault", "config-environment"]],
  ] as const)(
    "reports redacted %s compensation failure after attempting both restorations",
    async (failureMode, failedSteps) => {
      const apiKeyRef = "providers.openai.api-key";
      const credentialVault = createCredentialVault({
        [apiKeyRef]: "prior-openai-secret",
      });
      let vaultSetCalls = 0;
      credentialVault.vault.set.mockImplementation(
        async (key: string, value: string) => {
          vaultSetCalls += 1;
          if (vaultSetCalls === 2 && failureMode !== "config") {
            throw new Error("vault backend echoed submitted plaintext");
          }
          credentialVault.values.set(key, value);
        },
      );
      let saveCalls = 0;
      const harness = createHarness({
        body: {
          provider: "pi",
          primaryModel: "openai/gpt-5.4-mini",
          apiKey: "next-openai-secret",
        },
        secretsManager: credentialVault.secretsManager,
        onSave: () => {
          saveCalls += 1;
          if (saveCalls === 2 && failureMode !== "vault") {
            throw new Error("config backend echoed submitted plaintext");
          }
        },
        onStart: async (request) => {
          const prepared = await request.prepare?.();
          await expect(request.compensation?.restore()).rejects.toMatchObject({
            code: "PI_SWITCH_COMPENSATION_FAILED",
            context: { failedSteps: [...failedSteps] },
          });
          return prepared;
        },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(vaultSetCalls).toBe(2);
      expect(saveCalls).toBe(2);
      expect(JSON.stringify(harness.response)).not.toContain(
        "backend echoed submitted plaintext",
      );
    },
  );

  it("does not rewrite a secret for an idempotent duplicate", async () => {
    const apiKey = "duplicate-secret-must-not-write";
    const credentialVault = createCredentialVault();
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "openai/gpt-5.4-mini",
        apiKey,
      },
      headers: { "idempotency-key": "same-request" },
      secretsManager: credentialVault.secretsManager,
      dedupedStatus: "succeeded",
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
    expect(credentialVault.vault.set).not.toHaveBeenCalled();
    expect(credentialVault.vault.has).not.toHaveBeenCalled();
    expect(harness.saveElizaConfig).not.toHaveBeenCalled();
    expect(harness.response.data).toMatchObject({
      success: true,
      status: "succeeded",
      deduped: true,
    });
    expect(JSON.stringify(harness.response.data)).not.toContain(apiKey);
  });

  it.each(["failed", "restart_required", "rolled-back"] as const)(
    "returns deduped terminal failure %s without success or rewrites",
    async (dedupedStatus) => {
      const harness = createHarness({
        body: { provider: "pi", primaryModel: "openai/gpt-5.4-mini" },
        dedupedStatus,
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);
      expect(harness.response).toEqual({
        status: 500,
        data: {
          success: false,
          provider: "pi",
          status: dedupedStatus,
          restarting: false,
          operationId: "operation-1",
          deduped: true,
        },
      });
      expect(harness.saveElizaConfig).not.toHaveBeenCalled();
    },
  );
});
