/**
 * Exercises the authenticated provider-switch boundary for canonical Pi.
 * The harness invokes the real route/config mutators with an in-memory runtime
 * operation manager; no vault, provider, network, or live runtime is used.
 */
import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type {
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

function acceptedOperation(req: StartOperationRequest): RuntimeOperation {
  return {
    id: "operation-1",
    kind: req.intent.kind,
    intent: req.intent,
    tier: "cold",
    status: "pending",
    phases: [],
    startedAt: 1,
  };
}

function createHarness(args: {
  body: Record<string, unknown>;
  config?: ElizaConfig;
  onStart?: (request: StartOperationRequest) => Promise<void>;
}) {
  const response: CapturedResponse = {};
  const saveElizaConfig = vi.fn();
  let capturedRequest: StartOperationRequest | undefined;
  const runtimeOperationManager: RuntimeOperationManager = {
    start: vi.fn(async (request) => {
      capturedRequest = request;
      await args.onStart?.(request);
      if (!args.onStart) await request.prepare?.();
      return {
        kind: "accepted" as const,
        operation: acceptedOperation(request),
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
    req: { headers: {} } as http.IncomingMessage,
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
  };

  return {
    capturedRequest: () => capturedRequest,
    config,
    context,
    response,
    runtimeOperationManager,
    saveElizaConfig,
  };
}

const originalCompensationEnv = process.env.PI_SWITCH_COMPENSATION_TEST;
const originalCloudEnabledEnv = process.env.ELIZAOS_CLOUD_ENABLED;

afterEach(() => {
  if (originalCompensationEnv === undefined) {
    delete process.env.PI_SWITCH_COMPENSATION_TEST;
  } else {
    process.env.PI_SWITCH_COMPENSATION_TEST = originalCompensationEnv;
  }
  if (originalCloudEnabledEnv === undefined) {
    delete process.env.ELIZAOS_CLOUD_ENABLED;
  } else {
    process.env.ELIZAOS_CLOUD_ENABLED = originalCloudEnabledEnv;
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

  it.each(["sk-not-accepted", "", "   ", "x".repeat(513), null])(
    "rejects every submitted Pi API key before vault or operation work",
    async (apiKey) => {
      const harness = createHarness({
        body: {
          provider: "pi",
          primaryModel: "openai/gpt-5",
          apiKey,
        },
      });

      expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);

      expect(harness.response.status).toBe(400);
      expect(harness.response.data).toEqual({
        error:
          "Secure Pi API-key onboarding is not available yet; omit apiKey and use a preconfigured runtime credential.",
      });
      expect(harness.runtimeOperationManager.start).not.toHaveBeenCalled();
    },
  );

  it("accepts a qualified config-only switch and persists only canonical routing", async () => {
    const harness = createHarness({
      body: {
        provider: "pi",
        primaryModel: "openai/models/gpt-5:preview",
      },
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);

    expect(harness.response.status).toBe(202);
    expect(harness.config.serviceRouting?.llmText).toMatchObject({
      backend: "pi",
      transport: "direct",
      primaryModel: "openai/models/gpt-5:preview",
    });
    expect(harness.saveElizaConfig).toHaveBeenCalledTimes(1);
    expect(harness.capturedRequest()?.compensation).toMatchObject({
      restartPreviousRuntime: true,
    });
    expect(harness.capturedRequest()?.intent).toEqual({
      kind: "provider-switch",
      provider: "pi",
      primaryModel: "openai/models/gpt-5:preview",
    });
  });

  it("restores managed env without clobbering unrelated concurrent updates", async () => {
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
      body: { provider: "pi", primaryModel: "openai/gpt-5.4-mini" },
      config,
      onStart: async (request) => {
        await request.prepare?.();
        expect(process.env.ELIZAOS_CLOUD_ENABLED).toBeUndefined();
        process.env.PI_SWITCH_COMPENSATION_TEST = "concurrent-update";
        config.env = { vars: { ADDED_DURING_SWITCH: "during" } };
        await request.compensation?.restore();
      },
    });

    expect(await handleProviderSwitchRoutes(harness.context)).toBe(true);

    expect(config).toEqual(originalConfig);
    expect(process.env.ELIZAOS_CLOUD_ENABLED).toBe("before");
    expect(process.env.PI_SWITCH_COMPENSATION_TEST).toBe("concurrent-update");
    expect(harness.saveElizaConfig).toHaveBeenCalledTimes(2);
    expect(harness.response.status).toBe(202);
  });
});
