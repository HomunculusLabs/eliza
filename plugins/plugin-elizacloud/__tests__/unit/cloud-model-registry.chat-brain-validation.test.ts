/**
 * Chat-brain model-id validation contracts for CloudModelRegistryService and
 * the canRespond gate (#30228). Deterministic unit harness: the Cloud auth
 * client and the runtime are fakes; the service under test is real. Covers the
 * issue matrix — stale configured override, valid configured override,
 * provider/catalog warming (fetch failure must stay retryable, not
 * invalid_model), and default fallback — plus the typed-error contract.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
});

import { CloudModelRegistryService } from "../../src/services/cloud-model-registry";

/** Minimal CloudAuthService stand-in returning a scripted /models response. */
function makeAuth(modelsResponse: { ids: string[]; error?: Error }) {
  return {
    isAuthenticated: () => true,
    getClient: () => ({
      get: async (_path: string) => {
        if (modelsResponse.error) throw modelsResponse.error;
        return {
          object: "list",
          data: modelsResponse.ids.map((id, i) => ({
            id,
            object: "model",
            created: 1700000000 + i,
            owned_by: "eliza",
          })),
        };
      },
    }),
  };
}

const CHAT_BRAIN_SETTINGS: Record<string, string> = {};

function makeRuntime(
  auth: unknown,
  settings: Record<string, string> = CHAT_BRAIN_SETTINGS,
  reportError = vi.fn()
) {
  const runtime = {
    getService: (type: string) => (type === "CLOUD_AUTH" ? auth : null),
    getSetting: (key: string) => (key in settings ? settings[key] : process.env[key]),
    reportError,
  } as unknown as IAgentRuntime & { reportError: ReturnType<typeof vi.fn> };
  return runtime;
}

describe("CloudModelRegistryService chat-brain validation (#30228)", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const k of [
      "ELIZAOS_CLOUD_SMALL_MODEL",
      "ELIZAOS_CLOUD_LARGE_MODEL",
      "SMALL_MODEL",
      "LARGE_MODEL",
    ]) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = savedEnv;
    vi.restoreAllMocks();
  });

  it("marks a stale configured override invalid_model and reports a typed error naming key+model", async () => {
    const settings = {
      ELIZAOS_CLOUD_LARGE_MODEL: "gpt-removed-4x",
    };
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(makeAuth({ ids: ["gemma-4-31b", "gpt-5.2"] }), settings, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    expect(validation.status).toBe("invalid_model");
    expect(validation.invalid).toEqual([
      { key: "ELIZAOS_CLOUD_LARGE_MODEL", model: "gpt-removed-4x" },
    ]);
    // Typed, actionable error via reportError: names the config key + model.
    expect(reportError).toHaveBeenCalledTimes(1);
    const [scope, err, ctx] = reportError.mock.calls[0];
    expect(scope).toBe("CloudModelRegistry.validateChatBrainModels");
    expect((err as { code?: string }).code).toBe("ELIZA_CLOUD_MODEL_NOT_FOUND");
    expect(String((err as Error).message)).toContain("ELIZAOS_CLOUD_LARGE_MODEL");
    expect(String((err as Error).message)).toContain("gpt-removed-4x");
    expect(ctx).toMatchObject({
      invalid: [{ key: "ELIZAOS_CLOUD_LARGE_MODEL", model: "gpt-removed-4x" }],
    });
  });

  it("valid override passes (valid_model) and reports nothing", async () => {
    const settings = {
      ELIZAOS_CLOUD_SMALL_MODEL: "gemma-4-31b",
      ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2",
    };
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(makeAuth({ ids: ["gemma-4-31b", "gpt-5.2"] }), settings, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    expect(validation.status).toBe("valid_model");
    expect(validation.invalid).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("catalog fetch failure is retryable warming, NOT invalid_model", async () => {
    const settings = { ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2" };
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(
        makeAuth({ ids: [], error: new Error("catalog warming 503") }),
        settings,
        reportError
      )
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    // Fetch failure must never gate canRespond as permanent removal.
    expect(validation.status).toBe("unavailable");
    expect(validation.invalid).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("default fallback (no overrides set) validates the code defaults against the catalog", async () => {
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(makeAuth({ ids: ["gemma-4-31b", "gpt-5.2"] }), {}, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    // Defaults resolve through getSmallModel/getLargeModel fallbacks; if the
    // provider catalog carries them, the run is valid.
    expect(validation.status).toBe("valid_model");
  });

  it("default fallback absent from the catalog is invalid_model (a removed default is still broken)", async () => {
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(makeAuth({ ids: ["unrelated-model"] }), {}, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    expect(validation.status).toBe("invalid_model");
    expect(validation.invalid.length).toBeGreaterThan(0);
    expect(reportError).toHaveBeenCalled();
  });

  it("matches by bare name when the catalog carries provider-prefixed ids", async () => {
    const settings = { ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2" };
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(
        makeAuth({ ids: ["openai/gpt-5.2", "google/gemma-4-31b"] }),
        settings,
        reportError
      )
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    expect(validation.status).toBe("valid_model");
  });

  it("unauthenticated registry never gates: status stays unknown", async () => {
    const auth = {
      isAuthenticated: () => false,
      getClient: () => {
        throw new Error("should not be called");
      },
    };
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(auth, { ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2" }, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();

    const validation = service.getChatBrainValidation();
    expect(validation.status).toBe("unknown");
    expect(validation.invalid).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("chat-brain validation recovery + ownership boundaries (#30228)", () => {
  function makeMutableAuth() {
    let response: { ids: string[]; error?: Error } = {
      ids: ["gemma-4-31b", "gpt-5.2"],
    };
    return {
      auth: {
        isAuthenticated: () => true,
        getClient: () => ({
          get: async () => {
            if (response.error) throw response.error;
            return {
              object: "list",
              data: response.ids.map((id, i) => ({
                id,
                object: "model",
                created: 1700000000 + i,
                owned_by: "eliza",
              })),
            };
          },
        }),
      },
      setResponse: (r: { ids: string[]; error?: Error }) => {
        response = r;
      },
    };
  }

  it("a transient unavailable recovers to valid_model once the catalog loads", async () => {
    const { auth, setResponse } = makeMutableAuth();
    setResponse({ ids: [], error: new Error("503 warming") });
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(auth, { ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2" }, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();
    expect(service.getChatBrainValidation().status).toBe("unavailable");

    // Provider recovers; the TTL refresh must transition to valid_model —
    // a retained rejected fetch promise would keep it unavailable forever.
    setResponse({ ids: ["gemma-4-31b", "gpt-5.2"] });
    await service.getAvailableModels(); // TTL expiry path (lastFetchedAt=0)
    expect(service.getChatBrainValidation().status).toBe("valid_model");
  });

  it("an empty but successfully loaded catalog is invalid_model, not unknown", async () => {
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(makeAuth({ ids: [] }), { ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2" }, reportError)
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();
    // Empty catalog is authoritative: the configured id cannot be in it.
    expect(service.getChatBrainValidation().status).toBe("invalid_model");
    expect(reportError).toHaveBeenCalled();
  });

  it("never gates when ELIZAOS_CLOUD_USE_INFERENCE=false (another provider owns the text brain)", async () => {
    const reportError = vi.fn();
    const service = new CloudModelRegistryService(
      makeRuntime(
        makeAuth({ ids: ["unrelated-model"] }),
        {
          ELIZAOS_CLOUD_USE_INFERENCE: "false",
          ELIZAOS_CLOUD_LARGE_MODEL: "gpt-5.2",
        },
        reportError
      )
    );
    await (service as unknown as { initialize: () => Promise<void> }).initialize();
    expect(service.getChatBrainValidation().status).toBe("unknown");
    expect(reportError).not.toHaveBeenCalled();
  });
});
