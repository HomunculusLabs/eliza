/**
 * Integration-backed fake Pi streams verify validation ordering, buffered
 * fallback semantics, disposal, and redacted trajectory/event attribution.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AuthOperationOptions,
  Context,
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelsApiStreamOptions,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import {
  AgentRuntime,
  EventType,
  type IAgentRuntime,
  ModelType,
  type TextStreamResult,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { isModelProviderFallbackError } from "../../../packages/core/src/services/message/fallback-reply.js";
import { runWithTrajectoryContext } from "../../../packages/core/src/trajectory-context.js";
import { createPiPlugin } from "../runtime/plugin.js";

const model = {
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
  api: "openai-responses" as const,
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"] as const,
  cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 128_000,
  compat: { supportsStrictMode: true },
};

function message(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: {
      input: 7,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 1,
      totalTokens: 10,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037,
      },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: 0,
  };
}

function streamOf(
  events: readonly AssistantMessageEvent[],
): AssistantMessageEventStream {
  const terminal = events.at(-1);
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      if (terminal?.type === "done") return terminal.message;
      if (terminal?.type === "error") return terminal.error;
      return new Promise<AssistantMessage>(() => {});
    },
  } as unknown as AssistantMessageEventStream;
}

function successStream(): AssistantMessageEventStream {
  const partial = message([]);
  const final = message([
    { type: "thinking", thinking: "private output thinking" },
    { type: "text", text: "ok" },
  ]);
  return streamOf([
    { type: "start", partial },
    { type: "thinking_start", contentIndex: 0, partial },
    {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "private output thinking",
      partial,
    },
    {
      type: "thinking_end",
      contentIndex: 0,
      content: "private output thinking",
      partial,
    },
    { type: "text_start", contentIndex: 1, partial },
    { type: "text_delta", contentIndex: 1, delta: "ok", partial },
    { type: "text_end", contentIndex: 1, content: "ok", partial: final },
    { type: "done", reason: "stop", message: final },
  ]);
}

class FakeCredentials implements CredentialStore {
  readonly readSpy: ReturnType<typeof vi.fn>;

  constructor(
    readSpy = vi.fn(async () => ({ type: "api_key", key: "test-key" })),
  ) {
    this.readSpy = readSpy;
  }

  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.readSpy(providerId, options);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [];
  }

  async modify(): Promise<Credential | undefined> {
    throw new Error("read only");
  }

  async delete(): Promise<void> {
    throw new Error("read only");
  }
}

type StreamFactory = (
  context: Context,
  options?: ModelsApiStreamOptions<"openai-responses">,
) => AssistantMessageEventStream;

function fakeModels(streamFactory: StreamFactory): MutableModels {
  const providers = new Map<string, Provider>();
  return {
    setProvider(provider) {
      providers.set(provider.id, provider);
    },
    deleteProvider(id) {
      providers.delete(id);
    },
    clearProviders() {
      providers.clear();
    },
    getProviders() {
      return [...providers.values()];
    },
    getProvider(id) {
      return providers.get(id);
    },
    getModels() {
      return [model];
    },
    getModel(provider, id) {
      return provider === "openai" && id === model.id ? model : undefined;
    },
    stream(_model, context, options) {
      return streamFactory(
        context,
        options as ModelsApiStreamOptions<"openai-responses">,
      );
    },
    async complete() {
      throw new Error("The gateway must aggregate through stream()");
    },
  } as unknown as MutableModels;
}

function runtimeWithTrajectory(captured: Record<string, unknown>[] = []) {
  const emitEvent = vi.fn(async () => {});
  const reportError = vi.fn();
  const service = {
    isEnabled: () => true,
    logLlmCall: (details: Record<string, unknown>) => captured.push(details),
  };
  const runtime = {
    character: { name: "Contract Agent", system: "Character system" },
    getSetting: vi.fn(() => null),
    getService: vi.fn(() => service),
    getServicesByType: vi.fn(() => [service]),
    emitEvent,
    reportError,
  } as unknown as IAgentRuntime;
  return { runtime, emitEvent, reportError, captured };
}

async function initializedPlugin(args: {
  streamFactory: StreamFactory;
  credentials?: FakeCredentials;
  runtime?: IAgentRuntime;
}) {
  const credentials = args.credentials ?? new FakeCredentials();
  const plugin = createPiPlugin({
    modelsFactory: () => fakeModels(args.streamFactory),
    credentialStoreFactory: () => credentials,
  });
  const runtime = args.runtime ?? runtimeWithTrajectory().runtime;
  await plugin.init?.(
    { ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini" },
    runtime,
  );
  return { plugin, runtime, credentials };
}

describe("Pi executor lifecycle and observability", () => {
  it("validates the complete request before credential access or stream creation", async () => {
    const credentials = new FakeCredentials();
    const streamFactory = vi.fn(() => successStream());
    const { plugin, runtime } = await initializedPlugin({
      streamFactory,
      credentials,
    });
    await expect(
      plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
        prompt: "x",
        minTokens: 1,
      }),
    ).rejects.toMatchObject({ code: "PI_UNSUPPORTED_PARAMETER" });
    expect(credentials.readSpy).not.toHaveBeenCalled();
    expect(streamFactory).not.toHaveBeenCalled();
    await plugin.dispose?.(runtime);
  });

  it("rejects invalid config atomically and preserves the active route", async () => {
    const harness = await initializedPlugin({
      streamFactory: () => successStream(),
    });

    let applyError: unknown;
    try {
      await harness.plugin.applyConfig?.(
        { ELIZA_LLM_TEXT_PRIMARY_MODEL: "not-qualified" },
        harness.runtime,
      );
    } catch (error) {
      applyError = error;
    }
    expect(applyError).toMatchObject({ code: "PI_INVALID_MODEL_ID" });

    await expect(
      harness.plugin.models?.[ModelType.TEXT_SMALL]?.(harness.runtime, {
        prompt: "x",
      }),
    ).resolves.toBe("ok");
    await harness.plugin.dispose?.(harness.runtime);
  });

  it("keeps all buffered upstream activity pre-commit for fallback", async () => {
    const pre = await initializedPlugin({
      streamFactory: () =>
        streamOf([
          {
            type: "error",
            reason: "error",
            error: message([], "error", "HTTP 429 rate limit"),
          },
        ]),
    });
    const preError = await pre.plugin.models?.[ModelType.TEXT_SMALL]?.(
      pre.runtime,
      { prompt: "x" },
    ).catch((error: unknown) => error);
    expect(isModelProviderFallbackError(preError, ModelType.TEXT_SMALL)).toBe(
      true,
    );
    await pre.plugin.dispose?.(pre.runtime);

    const post = await initializedPlugin({
      streamFactory: () => {
        const partial = message([]);
        return streamOf([
          { type: "start", partial },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "charged", partial },
          {
            type: "error",
            reason: "error",
            error: message([], "error", "HTTP 503 unavailable"),
          },
        ]);
      },
    });
    const postError = await post.plugin.models?.[ModelType.TEXT_SMALL]?.(
      post.runtime,
      { prompt: "x" },
    ).catch((error: unknown) => error);
    expect(postError).toMatchObject({ code: "PI_STREAM_TERMINATED" });
    expect(postError.context).toMatchObject({ committed: true });
    expect(isModelProviderFallbackError(postError, ModelType.TEXT_SMALL)).toBe(
      false,
    );
    await post.plugin.dispose?.(post.runtime);
  });

  it("terminates a pending provider pump and requests iterator return on disposal", async () => {
    let resolvePending:
      | ((value: IteratorResult<AssistantMessageEvent>) => void)
      | undefined;
    let partial: AssistantMessage | undefined;
    const returnStarted = vi.fn();
    const onStreamChunk = vi.fn();
    const { plugin, runtime } = await initializedPlugin({
      streamFactory: () => {
        partial = message([]);
        const events: AssistantMessageEvent[] = [
          { type: "start", partial },
          { type: "text_start", contentIndex: 0, partial },
          { type: "text_delta", contentIndex: 0, delta: "partial", partial },
        ];
        return {
          [Symbol.asyncIterator]() {
            let index = 0;
            return {
              next: async (): Promise<
                IteratorResult<AssistantMessageEvent>
              > => {
                const event = events[index++];
                if (event !== undefined) return { value: event, done: false };
                return new Promise((resolve) => {
                  resolvePending = resolve;
                });
              },
              return: async (): Promise<
                IteratorResult<AssistantMessageEvent>
              > => {
                returnStarted();
                return new Promise(() => {});
              },
            };
          },
          async result() {
            return new Promise<AssistantMessage>(() => {});
          },
        } as unknown as AssistantMessageEventStream;
      },
    });
    const result = (await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: "x",
      stream: true,
      onStreamChunk,
    })) as TextStreamResult;
    await vi.waitFor(() => expect(resolvePending).toBeTypeOf("function"));
    await plugin.dispose?.(runtime);
    expect(returnStarted).toHaveBeenCalledOnce();
    expect(onStreamChunk).toHaveBeenCalledTimes(1);

    resolvePending?.({
      value: {
        type: "text_delta",
        contentIndex: 0,
        delta: "late",
        partial: partial as AssistantMessage,
      },
      done: false,
    });
    await Promise.resolve();
    expect(onStreamChunk).toHaveBeenCalledTimes(1);
    await expect(result.text).rejects.toMatchObject({ code: "PI_DISPOSED" });
    await expect(result.usage).rejects.toMatchObject({ code: "PI_DISPOSED" });
    await expect(result.finishReason).rejects.toMatchObject({
      code: "PI_DISPOSED",
    });
    await expect(result.toolCalls as Promise<unknown>).rejects.toMatchObject({
      code: "PI_DISPOSED",
    });
  });

  it("runtime unload removes all Pi model registrations and aborts active work", async () => {
    let resolvePending:
      | ((value: IteratorResult<AssistantMessageEvent>) => void)
      | undefined;
    const returnStarted = vi.fn();
    const plugin = createPiPlugin({
      modelsFactory: () =>
        fakeModels(() => {
          const partial = message([]);
          const events: AssistantMessageEvent[] = [
            { type: "start", partial },
            { type: "text_start", contentIndex: 0, partial },
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "partial",
              partial,
            },
          ];
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                next: async (): Promise<
                  IteratorResult<AssistantMessageEvent>
                > => {
                  const event = events[index++];
                  if (event !== undefined) return { value: event, done: false };
                  return new Promise((resolve) => {
                    resolvePending = resolve;
                  });
                },
                return: async (): Promise<
                  IteratorResult<AssistantMessageEvent>
                > => {
                  returnStarted();
                  return { value: undefined, done: true };
                },
              };
            },
            async result() {
              return new Promise<AssistantMessage>(() => {});
            },
          } as unknown as AssistantMessageEventStream;
        }),
      credentialStoreFactory: () => new FakeCredentials(),
    });
    plugin.config = {
      ELIZA_LLM_TEXT_BACKEND: "pi",
      ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini",
    };
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    await runtime.registerPlugin(plugin);
    expect(
      runtime
        .getModelRegistrations()
        .filter((registration) => registration.provider === "pi"),
    ).toHaveLength(10);

    const result = (await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: "x",
      stream: true,
    })) as TextStreamResult;
    await vi.waitFor(() => expect(resolvePending).toBeTypeOf("function"));

    await runtime.unloadPlugin("pi");

    expect(returnStarted).toHaveBeenCalledOnce();
    expect(
      runtime
        .getModelRegistrations()
        .filter((registration) => registration.provider === "pi"),
    ).toEqual([]);
    expect(runtime.getPluginOwnership("pi")).toBeNull();
    await expect(result.text).rejects.toMatchObject({ code: "PI_DISPOSED" });
  });

  it("omits request metadata and redacts private content while preserving attribution", async () => {
    const captured: Record<string, unknown>[] = [];
    const upstreamOptions: ModelsApiStreamOptions<"openai-responses">[] = [];
    const harness = runtimeWithTrajectory(captured);
    const { plugin, runtime } = await initializedPlugin({
      streamFactory: (_context, options) => {
        if (options !== undefined) upstreamOptions.push(options);
        return successStream();
      },
      runtime: harness.runtime,
    });

    await runWithTrajectoryContext(
      { trajectoryStepId: "pi-step" },
      async () => {
        await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "private input thinking" },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "inspect image" },
                {
                  type: "image",
                  image: "binary-attachment-secret",
                  mediaType: "image/png",
                },
              ],
            },
          ],
          providerOptions: {
            pi: {
              metadata: {
                apiKey: "trajectory-api-secret",
                nested: { authorization: "Bearer trajectory-token" },
                note: "innocuous-metadata-must-not-persist",
              },
            },
          },
        });
      },
    );

    expect(captured).toHaveLength(1);
    const trajectory = JSON.stringify(captured[0]);
    expect(trajectory).toContain("[REDACTED_BINARY]");
    expect(trajectory).toContain("[REDACTED_THINKING]");
    expect(trajectory).not.toContain("binary-attachment-secret");
    expect(trajectory).not.toContain("trajectory-api-secret");
    expect(trajectory).not.toContain("trajectory-token");
    expect(trajectory).not.toContain("innocuous-metadata-must-not-persist");
    expect(trajectory).not.toContain('"metadata"');
    expect(upstreamOptions[0]).toMatchObject({
      metadata: {
        note: "innocuous-metadata-must-not-persist",
      },
    });
    expect(trajectory).not.toContain("private input thinking");
    expect(trajectory).not.toContain("private output thinking");
    expect(captured[0]).toMatchObject({
      provider: "pi",
      model: "openai/gpt-5.4-mini",
      finishReason: "stop",
      providerMetadata: expect.objectContaining({
        gateway: "pi",
        provider: "openai",
      }),
    });

    await vi.waitFor(() => expect(harness.emitEvent).toHaveBeenCalled());
    const modelUsed = harness.emitEvent.mock.calls.find(
      ([event]) => event === EventType.MODEL_USED,
    )?.[1];
    expect(modelUsed).toMatchObject({
      source: "pi",
      provider: "pi",
      upstreamProvider: "openai",
      qualifiedModel: "openai/gpt-5.4-mini",
    });
    const eventJson = JSON.stringify(modelUsed);
    expect(eventJson).not.toContain("trajectory-api-secret");
    expect(eventJson).not.toContain("private output thinking");
    await plugin.dispose?.(runtime);
  });
});
