/**
 * Focused pure-translation coverage for messages, tools, attachments, controls,
 * host annotations, and thinking/result separation.
 */
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ResolvedPiModelId } from "../models/resolve-model.js";
import { translatePiAssistantMessage } from "../models/translate-events.js";
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

function translate(
  params: Parameters<typeof translateGenerateTextCall>[0]["params"],
) {
  return translateGenerateTextCall({
    slot: ModelType.TEXT_SMALL,
    params,
    model: model as Model<Api>,
    resolved,
    signal: new AbortController().signal,
  });
}

describe("Pi input translation", () => {
  it("prefers non-empty messages, de-duplicates system, and preserves tool IDs/results", () => {
    const params = {
      prompt: "legacy prompt must not win",
      system: "Be precise.",
      messages: [
        { role: "system" as const, content: "Be precise." },
        { role: "developer" as const, content: "Use native tools." },
        {
          role: "assistant" as const,
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { q: "x" } }],
        },
        {
          role: "tool" as const,
          toolCallId: "call-1",
          name: "lookup",
          content: "found",
        },
        { role: "user" as const, content: "continue" },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object" },
          strict: true,
        },
      ],
      toolChoice: "auto" as const,
    };
    const before = structuredClone(params);
    const prepared = translate(params);

    expect(params).toEqual(before);
    expect(prepared.context.systemPrompt).toBe(
      "Be precise.\n\nUse native tools.",
    );
    expect(prepared.context.messages).toHaveLength(3);
    expect(prepared.context.messages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "lookup" }],
    });
    expect(prepared.context.messages[1]).toMatchObject({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "lookup",
    });
    expect(prepared.context.tools?.[0]).toMatchObject({
      name: "lookup",
      constrainedSampling: { type: "json_schema", strict: "require" },
    });
  });

  it("maps supported controls and records local-only fields without sending them", () => {
    const prepared = translate({
      prompt: "cached prompt",
      promptSegments: [
        { content: "cached ", stable: true },
        { content: "prompt", stable: false },
      ],
      maxTokens: 321,
      temperature: 0.5,
      topP: 0.8,
      frequencyPenalty: 0.2,
      presencePenalty: -0.1,
      voiceOutput: "internal",
      priority: "background",
      grammar: "root ::= text",
      providerOptions: {
        pi: { cacheRetention: "long", sessionId: "session-1" },
        openai: { reasoningEffort: "low", reasoningSummary: "concise" },
      },
    });

    expect(prepared.options).toMatchObject({
      maxTokens: 321,
      temperature: 0.5,
      cacheRetention: "long",
      sessionId: "session-1",
      reasoningEffort: "low",
      reasoningSummary: "concise",
      samplingParams: {
        top_p: 0.8,
        frequency_penalty: 0.2,
        presence_penalty: -0.1,
      },
    });
    expect(prepared.annotations.hostOnly).toMatchObject({
      voiceOutput: "internal",
      priority: "background",
      grammar: "root ::= text",
    });
    expect(prepared.annotations.unsupportedPromptCacheHints).toBe(true);
  });

  it("rejects unsafe attachment paths, orphan tool results, and unsupported controls", () => {
    expect(() =>
      translate({
        prompt: "image",
        attachments: [
          { mediaType: "image/png", data: new URL("file:///tmp/private.png") },
        ],
      }),
    ).toThrow(/cannot preserve/);
    expect(() =>
      translate({
        messages: [{ role: "tool", toolCallId: "missing", content: "x" }],
      }),
    ).toThrow(/unmatched preceding tool call/);
    expect(() => translate({ prompt: "x", minTokens: 1 })).toThrow(
      /cannot preserve/,
    );
  });

  it("forces structured output through a strict tool and keeps thinking out of text", () => {
    const prepared = translate({
      prompt: "return data",
      responseSchema: {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    });
    expect(prepared.structuredResponseTool).toBe("__eliza_structured_response");
    expect(prepared.context.tools?.[0]).toMatchObject({
      constrainedSampling: { type: "json_schema", strict: "require" },
    });

    const message: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "structured-1",
          name: "__eliza_structured_response",
          arguments: { answer: "yes" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        reasoning: 3,
        totalTokens: 15,
        cost: {
          input: 0.1,
          output: 0.2,
          cacheRead: 0.01,
          cacheWrite: 0.01,
          total: 0.32,
        },
      },
      stopReason: "toolUse",
      timestamp: 0,
    };
    const normalized = translatePiAssistantMessage({
      message,
      model: model as Model<Api>,
      resolved,
      structuredResponseTool: prepared.structuredResponseTool,
      includeThinking: false,
    });
    expect(normalized.text).toBe('{"answer":"yes"}');
    expect(normalized.text).not.toContain("private reasoning");
    expect(normalized.providerMetadata).not.toHaveProperty("thinking");
    expect(normalized.providerMetadata).toMatchObject({
      gateway: "pi",
      provider: "openai",
      thinkingTokens: 3,
      cost: { usd: 0.32 },
    });
  });

  it.each([
    ["role mismatch", { role: "user" }],
    ["API mismatch", { api: "anthropic-messages" }],
    ["provider mismatch", { provider: "anthropic" }],
    ["requested-model mismatch", { model: "gpt-5.4" }],
    ["model whitespace", { responseModel: "secret model" }],
    ["negative timestamp", { timestamp: -1 }],
    ["empty result", { content: [] }],
    ["unknown content type", { content: [{ type: "image", data: "x" }] }],
    ["negative usage", { usage: { input: -1 } }],
    ["fractional usage", { usage: { totalTokens: 1.5 } }],
    ["missing usage cost", { usage: { cost: null } }],
    ["reasoning exceeds output", { usage: { reasoning: 2 } }],
    ["invalid stop reason", { stopReason: "error" }],
  ])("typed-rejects malformed terminal messages: %s", (_name, override) => {
    const base: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    const message = {
      ...base,
      ...override,
      usage:
        "usage" in override ? { ...base.usage, ...override.usage } : base.usage,
    } as AssistantMessage;
    expect(() =>
      translatePiAssistantMessage({
        message,
        model: model as Model<Api>,
        resolved,
        includeThinking: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        code:
          _name === "empty result" ? "PI_EMPTY_RESULT" : "PI_STREAM_TERMINATED",
      }),
    );
  });

  it("rejects duplicate/malformed tool calls and multiple structured responses", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const base = {
      role: "assistant" as const,
      api: "openai-responses" as const,
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "toolUse" as const,
      timestamp: 0,
    };
    const duplicate = {
      ...base,
      content: [
        { type: "toolCall", id: "same", name: "lookup", arguments: {} },
        { type: "toolCall", id: "same", name: "lookup", arguments: {} },
      ],
    } as AssistantMessage;
    expect(() =>
      translatePiAssistantMessage({
        message: duplicate,
        model: model as Model<Api>,
        resolved,
        includeThinking: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));

    const malformed = {
      ...base,
      content: [
        { type: "toolCall", id: "call-1", name: "lookup", arguments: cyclic },
      ],
    } as AssistantMessage;
    expect(() =>
      translatePiAssistantMessage({
        message: malformed,
        model: model as Model<Api>,
        resolved,
        includeThinking: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));

    for (const content of [
      { type: "image", id: "call-1", name: "lookup", arguments: {} },
      { type: "toolCall", id: 7, name: "lookup", arguments: {} },
      { type: "toolCall", id: "call-1", name: 7, arguments: {} },
      { type: "toolCall", id: "call-1", name: "bad name", arguments: {} },
    ]) {
      expect(() =>
        translatePiAssistantMessage({
          message: { ...base, content: [content] } as AssistantMessage,
          model: model as Model<Api>,
          resolved,
          declaredToolNames: new Set(["lookup"]),
          includeThinking: false,
        }),
      ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));
    }

    expect(() =>
      translatePiAssistantMessage({
        message: {
          ...base,
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "undeclared",
              arguments: {},
            },
          ],
        } as AssistantMessage,
        model: model as Model<Api>,
        resolved,
        declaredToolNames: new Set(["lookup"]),
        includeThinking: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));

    const structured = {
      ...base,
      content: [
        {
          type: "toolCall",
          id: "one",
          name: "__eliza_structured_response",
          arguments: { ok: true },
        },
        {
          type: "toolCall",
          id: "two",
          name: "__eliza_structured_response",
          arguments: { ok: false },
        },
      ],
    } as AssistantMessage;
    expect(() =>
      translatePiAssistantMessage({
        message: structured,
        model: model as Model<Api>,
        resolved,
        structuredResponseTool: "__eliza_structured_response",
        includeThinking: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));

    for (const content of [
      [{ type: "text", text: "not structured" }],
      [
        { type: "text", text: "preamble" },
        {
          type: "toolCall",
          id: "structured",
          name: "__eliza_structured_response",
          arguments: { ok: true },
        },
      ],
      [
        {
          type: "toolCall",
          id: "other",
          name: "lookup",
          arguments: {},
        },
      ],
    ]) {
      expect(() =>
        translatePiAssistantMessage({
          message: { ...base, content } as AssistantMessage,
          model: model as Model<Api>,
          resolved,
          structuredResponseTool: "__eliza_structured_response",
          declaredToolNames: new Set(["__eliza_structured_response", "lookup"]),
          includeThinking: false,
        }),
      ).toThrowError(expect.objectContaining({ code: "PI_STREAM_TERMINATED" }));
    }
  });
});
