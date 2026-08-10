/**
 * Focused plugin integration coverage for the ten registrations, native result
 * translation, closed injected credentials, and gateway/upstream usage events.
 */
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import {
  EventType,
  type IAgentRuntime,
  ModelType,
  TEXT_GENERATION_MODEL_TYPES,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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

class FakeCredentials implements CredentialStore {
  async read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return providerId === "openai"
      ? { type: "api_key", key: "test-only" }
      : undefined;
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

function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "not visible" },
      { type: "text", text: "hello" },
      { type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "x" } },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: {
      input: 12,
      output: 4,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: 1,
      totalTokens: 16,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.037,
      },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function streamMessage(): AssistantMessage {
  return {
    ...finalMessage(),
    content: [{ type: "text", text: "streamed" }],
    stopReason: "stop",
  };
}

function fakeStream(): AssistantMessageEventStream {
  const partial = { ...streamMessage(), content: [] };
  const final = streamMessage();
  const events: AssistantMessageEvent[] = [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: "stream", partial },
    { type: "text_delta", contentIndex: 0, delta: "ed", partial },
    { type: "text_end", contentIndex: 0, content: "streamed", partial: final },
    { type: "done", reason: "stop", message: final },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return final;
    },
  } as unknown as AssistantMessageEventStream;
}

function nativeStream(): AssistantMessageEventStream {
  const partial = { ...finalMessage(), content: [] };
  const final = finalMessage();
  const call = final.content.find((content) => content.type === "toolCall");
  if (call?.type !== "toolCall")
    throw new Error("fixture tool call is missing");
  const events: AssistantMessageEvent[] = [
    { type: "start", partial },
    { type: "text_start", contentIndex: 0, partial },
    { type: "text_delta", contentIndex: 0, delta: "hello", partial },
    { type: "text_end", contentIndex: 0, content: "hello", partial: final },
    { type: "toolcall_start", contentIndex: 1, partial },
    { type: "toolcall_delta", contentIndex: 1, delta: '{"q":"x"}', partial },
    { type: "toolcall_end", contentIndex: 1, toolCall: call, partial: final },
    { type: "done", reason: "toolUse", message: final },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return final;
    },
  } as unknown as AssistantMessageEventStream;
}

function fakeModels(): MutableModels {
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
    stream(_model: unknown, context: import("@earendil-works/pi-ai").Context) {
      return context.tools?.length ? nativeStream() : fakeStream();
    },
    async complete() {
      return finalMessage();
    },
  } as unknown as MutableModels;
}

function fakeRuntime() {
  const emitEvent = vi.fn(async () => {});
  const reportError = vi.fn();
  const runtime = {
    character: { name: "Test" },
    getSetting: vi.fn(() => null),
    getService: vi.fn(() => null),
    emitEvent,
    reportError,
  } as unknown as IAgentRuntime;
  return { runtime, emitEvent, reportError };
}

describe("Pi plugin text contract", () => {
  it("registers exactly all ten text slots with streaming/non-local metadata", () => {
    const plugin = createPiPlugin();
    expect(Object.keys(plugin.models ?? {}).sort()).toEqual(
      [...TEXT_GENERATION_MODEL_TYPES].sort(),
    );
    for (const slot of TEXT_GENERATION_MODEL_TYPES) {
      expect(plugin.modelMetadata?.[slot]).toMatchObject({
        local: false,
        streamable: true,
      });
    }
  });

  it("returns native text/tool/usage metadata and emits gateway-aware MODEL_USED", async () => {
    const models = fakeModels();
    const plugin = createPiPlugin({
      modelsFactory: () => models,
      credentialStoreFactory: () => new FakeCredentials(),
    });
    const { runtime, emitEvent } = fakeRuntime();
    await plugin.init?.(
      { ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini" },
      runtime,
    );

    const result = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      messages: [{ role: "user", content: "hello" }],
      tools: [{ name: "lookup", parameters: { type: "object" }, strict: true }],
    });
    expect(result).toMatchObject({
      text: "hello",
      finishReason: "tool-calls",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "x" } }],
      usage: {
        promptTokens: 12,
        completionTokens: 4,
        totalTokens: 16,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        reasoningTokens: 1,
      },
      providerMetadata: {
        gateway: "pi",
        provider: "openai",
        modelName: "gpt-5.4-mini",
        qualifiedModel: "openai/gpt-5.4-mini",
        thinkingTokens: 1,
      },
    });
    expect(JSON.stringify(result)).not.toContain("not visible");

    await vi.waitFor(() => expect(emitEvent).toHaveBeenCalled());
    expect(emitEvent).toHaveBeenCalledWith(
      EventType.MODEL_USED,
      expect.objectContaining({
        source: "pi",
        provider: "pi",
        upstreamProvider: "openai",
        qualifiedModel: "openai/gpt-5.4-mini",
        costUsd: 0.037,
        tokens: expect.objectContaining({
          prompt: 12,
          completion: 4,
          total: 16,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          reasoningTokens: 1,
        }),
      }),
    );
    await plugin.dispose?.(runtime);
  });

  it("streams through the plugin executor and emits terminal usage once", async () => {
    const plugin = createPiPlugin({
      modelsFactory: () => fakeModels(),
      credentialStoreFactory: () => new FakeCredentials(),
    });
    const { runtime, emitEvent } = fakeRuntime();
    await plugin.init?.(
      { ELIZA_LLM_TEXT_PRIMARY_MODEL: "openai/gpt-5.4-mini" },
      runtime,
    );
    const result = await plugin.models?.[ModelType.TEXT_SMALL]?.(runtime, {
      prompt: "hello",
      stream: true,
    });
    expect(typeof result).not.toBe("string");
    if (typeof result === "string" || result === undefined) return;

    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);
    expect(chunks).toEqual(["stream", "ed"]);
    await expect(result.text).resolves.toBe("streamed");
    expect(result.providerMetadata).toMatchObject({
      gateway: "pi",
      provider: "openai",
      qualifiedModel: "openai/gpt-5.4-mini",
      finishReason: "stop",
      usage: { totalTokens: 16 },
      cost: { usd: 0.037 },
    });
    await vi.waitFor(() =>
      expect(emitEvent).toHaveBeenCalledWith(
        EventType.MODEL_USED,
        expect.objectContaining({
          source: "pi",
          upstreamProvider: "openai",
          finishReason: "stop",
        }),
      ),
    );
    await plugin.dispose?.(runtime);
  });
});
