/**
 * Focused fake-stream coverage for commitment, exactly-once visible deltas,
 * fallback classification, thinking separation, and cancellation settlement.
 */
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { isModelProviderFallbackError } from "../../../packages/core/src/services/message/fallback-reply.js";
import type { ResolvedPiModelId } from "../models/resolve-model.js";
import { createPiStreamAttempt } from "../models/stream-pump.js";
import { translateGenerateTextCall } from "../models/translate-input.js";

const model: Model<"openai-responses"> = {
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
  contextWindow: 400_000,
  maxTokens: 128_000,
  compat: { supportsStrictMode: true },
};
const resolved: ResolvedPiModelId = {
  qualifiedModel: "openai/gpt-5.4-mini",
  provider: "openai",
  modelId: "gpt-5.4-mini",
  unknownModel: false,
};

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: {
      input: 4,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 6,
      cost: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      },
    },
    stopReason,
    timestamp: 0,
  };
}

function streamOf(
  events: readonly AssistantMessageEvent[],
): AssistantMessageEventStream {
  const terminal = events.find(
    (event) => event.type === "done" || event.type === "error",
  );
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        await Promise.resolve();
        yield event;
      }
    },
    async result() {
      if (terminal?.type === "done") return terminal.message;
      if (terminal?.type === "error") return terminal.error;
      return new Promise<AssistantMessage>(() => {});
    },
  } as unknown as AssistantMessageEventStream;
}

function prepared(
  signal: AbortSignal,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
) {
  const params = { prompt: "hello", stream: true, onStreamChunk };
  return {
    params,
    request: translateGenerateTextCall({
      slot: ModelType.TEXT_SMALL,
      params,
      model: model as Model<Api>,
      resolved,
      signal,
    }),
  };
}

describe("Pi stream pump", () => {
  it("delivers identical ordered text deltas to callback and iterator exactly once", async () => {
    const controller = new AbortController();
    const callbacks: string[] = [];
    const input = prepared(controller.signal, (chunk) => callbacks.push(chunk));
    const partial = assistant([]);
    const final = assistant([{ type: "text", text: "hello" }]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "hel", partial },
        { type: "text_delta", contentIndex: 0, delta: "lo", partial },
        { type: "text_end", contentIndex: 0, content: "hello", partial: final },
        { type: "done", reason: "stop", message: final },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });

    await attempt.ready;
    const iterated: string[] = [];
    for await (const chunk of attempt.result.textStream) iterated.push(chunk);
    expect(iterated).toEqual(["hel", "lo"]);
    expect(callbacks).toEqual(iterated);
    await expect(attempt.result.text).resolves.toBe("hello");
    await expect(attempt.result.usage).resolves.toMatchObject({
      totalTokens: 6,
    });
  });

  it("removes its abort listener after a terminal event and settles the pump", async () => {
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const input = prepared(controller.signal);
    const partial = assistant([]);
    const final = assistant([{ type: "text", text: "done" }]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "done", partial },
        { type: "text_end", contentIndex: 0, content: "done", partial: final },
        { type: "done", reason: "stop", message: final },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });

    await expect(attempt.pump).resolves.toBeUndefined();
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("replays one identical normalized JSON delta for structured streams", async () => {
    const controller = new AbortController();
    const callbacks: string[] = [];
    const params = {
      prompt: "structured",
      stream: true,
      responseSchema: {
        type: "object" as const,
        properties: { answer: { type: "string" as const } },
      },
      onStreamChunk: (chunk: string) => callbacks.push(chunk),
    };
    const request = translateGenerateTextCall({
      slot: ModelType.TEXT_SMALL,
      params,
      model: model as Model<Api>,
      resolved,
      signal: controller.signal,
    });
    const partial = assistant([]);
    const call = {
      type: "toolCall" as const,
      id: "structured-1",
      name: request.structuredResponseTool as string,
      arguments: { answer: "yes" },
    };
    const final = assistant([call], "toolUse");
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "toolcall_start", contentIndex: 0, partial },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"answer":"yes"}',
          partial,
        },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: call,
          partial: final,
        },
        { type: "done", reason: "toolUse", message: final },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: request,
      params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });

    await attempt.ready;
    const chunks: string[] = [];
    for await (const chunk of attempt.result.textStream) chunks.push(chunk);
    expect(chunks).toEqual(['{"answer":"yes"}']);
    expect(callbacks).toEqual(chunks);
    await expect(attempt.result.text).resolves.toBe('{"answer":"yes"}');
    await expect(attempt.result.toolCalls as Promise<unknown>).resolves.toEqual(
      [],
    );
  });

  it("keeps buffered upstream deltas pre-commit and never calls stream callbacks", async () => {
    const controller = new AbortController();
    const callbacks: string[] = [];
    const params = {
      prompt: "buffered",
      stream: false,
      onStreamChunk: (chunk: string) => callbacks.push(chunk),
    };
    const request = translateGenerateTextCall({
      slot: ModelType.TEXT_SMALL,
      params,
      model: model as Model<Api>,
      resolved,
      signal: controller.signal,
    });
    const partial = assistant([]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "not-visible", partial },
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 503 unavailable",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: request,
      params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });

    const error = await attempt.ready.catch((reason: unknown) => reason);
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      true,
    );
    expect(callbacks).toEqual([]);
    await expect(attempt.result.text).rejects.toBe(error);
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of attempt.result.textStream) chunks.push(chunk);
      })(),
    ).rejects.toBe(error);
    expect(chunks).toEqual([]);
  });

  it("exposes only pre-commit transient errors to the real fallback classifier", async () => {
    const preController = new AbortController();
    const pre = prepared(preController.signal);
    const preAttempt = createPiStreamAttempt({
      stream: streamOf([
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 429 rate limit",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: pre.request,
      params: pre.params,
      controller: preController,
      signal: preController.signal,
      disposed: () => false,
    });
    const preError = await preAttempt.ready.catch((error: unknown) => error);
    expect(isModelProviderFallbackError(preError, ModelType.TEXT_SMALL)).toBe(
      true,
    );

    const thinkingController = new AbortController();
    const thinking = prepared(thinkingController.signal);
    const thinkingPartial = assistant([]);
    const thinkingAttempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial: thinkingPartial },
        { type: "thinking_start", contentIndex: 0, partial: thinkingPartial },
        {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "private",
          partial: thinkingPartial,
        },
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 503 unavailable",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: thinking.request,
      params: thinking.params,
      controller: thinkingController,
      signal: thinkingController.signal,
      disposed: () => false,
    });
    const thinkingError = await thinkingAttempt.ready.catch(
      (error: unknown) => error,
    );
    expect(
      isModelProviderFallbackError(thinkingError, ModelType.TEXT_SMALL),
    ).toBe(true);

    const postController = new AbortController();
    const post = prepared(postController.signal);
    const partial = assistant([]);
    const postAttempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "visible", partial },
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 503 unavailable",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: post.request,
      params: post.params,
      controller: postController,
      signal: postController.signal,
      disposed: () => false,
    });
    await postAttempt.ready;
    const postError = await postAttempt.result.text.catch(
      (error: unknown) => error,
    );
    expect(isModelProviderFallbackError(postError, ModelType.TEXT_SMALL)).toBe(
      false,
    );
  });

  it("settles every surface as cancellation when the call controller aborts", async () => {
    const controller = new AbortController();
    const input = prepared(controller.signal);
    const neverTerminal = {
      async *[Symbol.asyncIterator]() {
        yield {
          type: "start",
          partial: assistant([]),
        } as AssistantMessageEvent;
        await new Promise<void>(() => {});
      },
      async result() {
        return new Promise<AssistantMessage>(() => {});
      },
    } as unknown as AssistantMessageEventStream;
    const attempt = createPiStreamAttempt({
      stream: neverTerminal,
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    controller.abort(new Error("caller cancelled"));
    const error = await attempt.ready.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "PI_CANCELLED" });
    await expect(attempt.result.text).rejects.toMatchObject({
      code: "PI_CANCELLED",
    });
    await expect(attempt.result.usage).rejects.toMatchObject({
      code: "PI_CANCELLED",
    });
    await expect(attempt.result.finishReason).rejects.toMatchObject({
      code: "PI_CANCELLED",
    });
    await expect(
      attempt.result.toolCalls as Promise<unknown>,
    ).rejects.toMatchObject({
      code: "PI_CANCELLED",
    });
    const iterator = attempt.result.textStream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      code: "PI_CANCELLED",
    });
  });

  it("does not commit on start/end markers before a transient error", async () => {
    const controller = new AbortController();
    const input = prepared(controller.signal);
    const partial = assistant([]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 503 temporarily unavailable",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    const error = await attempt.ready.catch((reason: unknown) => reason);
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      true,
    );
  });

  it("classifies callback failures as committed stream errors and aborts Pi", async () => {
    const controller = new AbortController();
    const input = prepared(controller.signal, () => {
      throw new Error("consumer failed");
    });
    const partial = assistant([]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "text_start", contentIndex: 0, partial },
        { type: "text_delta", contentIndex: 0, delta: "x", partial },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    await attempt.ready;
    const error = await attempt.result.text.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "PI_STREAM_TERMINATED" });
    expect(error).not.toMatchObject({ code: "PI_CANCELLED" });
    expect(isModelProviderFallbackError(error, ModelType.TEXT_SMALL)).toBe(
      false,
    );
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps thinking/tool deltas out of both visible stream surfaces", async () => {
    const controller = new AbortController();
    const callbacks: string[] = [];
    const input = prepared(controller.signal, (chunk) => callbacks.push(chunk));
    const partial = assistant([]);
    const final = assistant([
      { type: "thinking", thinking: "private" },
      { type: "text", text: "visible" },
    ]);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "thinking_start", contentIndex: 0, partial },
        { type: "thinking_delta", contentIndex: 0, delta: "private", partial },
        { type: "thinking_end", contentIndex: 0, content: "private", partial },
        { type: "text_start", contentIndex: 1, partial },
        { type: "text_delta", contentIndex: 1, delta: "visible", partial },
        {
          type: "text_end",
          contentIndex: 1,
          content: "visible",
          partial: final,
        },
        { type: "done", reason: "stop", message: final },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    await attempt.ready;
    const chunks: string[] = [];
    for await (const chunk of attempt.result.textStream) chunks.push(chunk);
    expect(chunks).toEqual(["visible"]);
    expect(callbacks).toEqual(chunks);
    await expect(attempt.result.text).resolves.toBe("visible");
    expect(JSON.stringify(attempt.result.providerMetadata)).not.toContain(
      "private",
    );
  });

  it("accepts declared tool-only success without exposing tool JSON as text", async () => {
    const controller = new AbortController();
    const callbacks: string[] = [];
    const params = {
      prompt: "hello",
      stream: true,
      tools: [{ name: "lookup", parameters: { type: "object" as const } }],
      onStreamChunk: (chunk: string) => callbacks.push(chunk),
    };
    const request = translateGenerateTextCall({
      slot: ModelType.TEXT_SMALL,
      params,
      model: model as Model<Api>,
      resolved,
      signal: controller.signal,
    });
    const partial = assistant([]);
    const call = {
      type: "toolCall" as const,
      id: "call-1",
      name: "lookup",
      arguments: { q: "x" },
    };
    const final = assistant([call], "toolUse");
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        { type: "start", partial },
        { type: "toolcall_start", contentIndex: 0, partial },
        {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: '{"q":"x"}',
          partial,
        },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: call,
          partial: final,
        },
        { type: "done", reason: "toolUse", message: final },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: request,
      params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    await attempt.ready;
    await expect(attempt.result.text).resolves.toBe("");
    await expect(attempt.result.toolCalls as Promise<unknown>).resolves.toEqual(
      [{ id: "call-1", name: "lookup", arguments: { q: "x" } }],
    );
    expect(callbacks).toEqual([]);
  });

  it.each([
    [
      "content before start",
      [
        {
          type: "text_delta",
          contentIndex: 0,
          delta: "x",
          partial: assistant([]),
        },
      ],
    ],
    ["non-object event", [42]],
    ["malformed partial envelope", [{ type: "start", partial: null }]],
    [
      "duplicate start",
      [
        { type: "start", partial: assistant([]) },
        { type: "start", partial: assistant([]) },
      ],
    ],
    [
      "invalid content index",
      [
        { type: "start", partial: assistant([]) },
        { type: "text_start", contentIndex: -1, partial: assistant([]) },
      ],
    ],
    [
      "duplicate content start",
      [
        { type: "start", partial: assistant([]) },
        { type: "text_start", contentIndex: 0, partial: assistant([]) },
        { type: "thinking_start", contentIndex: 0, partial: assistant([]) },
      ],
    ],
    [
      "delta without matching part",
      [
        { type: "start", partial: assistant([]) },
        {
          type: "thinking_delta",
          contentIndex: 4,
          delta: "x",
          partial: assistant([]),
        },
      ],
    ],
    [
      "non-string delta",
      [
        { type: "start", partial: assistant([]) },
        { type: "text_start", contentIndex: 0, partial: assistant([]) },
        {
          type: "text_delta",
          contentIndex: 0,
          delta: 7,
          partial: assistant([]),
        },
      ],
    ],
    [
      "mismatched content end",
      [
        { type: "start", partial: assistant([]) },
        { type: "text_start", contentIndex: 0, partial: assistant([]) },
        {
          type: "thinking_end",
          contentIndex: 0,
          content: "x",
          partial: assistant([]),
        },
      ],
    ],
    [
      "malformed tool-call end",
      [
        { type: "start", partial: assistant([]) },
        { type: "toolcall_start", contentIndex: 0, partial: assistant([]) },
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: null,
          partial: assistant([]),
        },
      ],
    ],
    [
      "terminal with open content",
      [
        { type: "start", partial: assistant([]) },
        { type: "text_start", contentIndex: 0, partial: assistant([]) },
        {
          type: "done",
          reason: "stop",
          message: assistant([{ type: "text", text: "x" }]),
        },
      ],
    ],
    [
      "terminal reason mismatch",
      [
        { type: "start", partial: assistant([]) },
        {
          type: "done",
          reason: "length",
          message: assistant([{ type: "text", text: "x" }]),
        },
      ],
    ],
    [
      "malformed terminal error",
      [
        {
          type: "error",
          reason: "error",
          error: { ...assistant([], "error"), errorMessage: "" },
        },
      ],
    ],
    [
      "unknown event discriminator",
      [
        { type: "start", partial: assistant([]) },
        { type: "mystery", partial: assistant([]) },
      ],
    ],
    ["missing terminal event", [{ type: "start", partial: assistant([]) }]],
    [
      "terminal text without visible deltas",
      [
        { type: "start", partial: assistant([]) },
        {
          type: "done",
          reason: "stop",
          message: assistant([{ type: "text", text: "hidden" }]),
        },
      ],
    ],
  ])("typed-rejects malformed events: %s", async (_name, events) => {
    const controller = new AbortController();
    const input = prepared(controller.signal);
    const attempt = createPiStreamAttempt({
      stream: streamOf(events as unknown as AssistantMessageEvent[]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    await expect(attempt.ready).rejects.toMatchObject({
      code: "PI_STREAM_TERMINATED",
    });
  });

  it("observes unused companion rejections", async () => {
    const controller = new AbortController();
    const input = prepared(controller.signal);
    const attempt = createPiStreamAttempt({
      stream: streamOf([
        {
          type: "error",
          reason: "error",
          error: {
            ...assistant([], "error"),
            errorMessage: "HTTP 503 unavailable",
          },
        },
      ]),
      model: model as Model<Api>,
      resolved,
      prepared: input.request,
      params: input.params,
      controller,
      signal: controller.signal,
      disposed: () => false,
    });
    await attempt.ready.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
