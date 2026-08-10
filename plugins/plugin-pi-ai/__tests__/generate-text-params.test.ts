/**
 * Table-driven contract coverage classifies every current GenerateTextParams
 * field and exercises provider capability combinations without network access.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { type GenerateTextParams, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { staticPiCatalogSource } from "../catalog/index.js";
import type { ResolvedPiModelId } from "../models/resolve-model.js";
import { resolveQualifiedPiModel } from "../models/resolve-model.js";
import { translateGenerateTextCall } from "../models/translate-input.js";
import { CURATED_PI_PROVIDERS } from "../providers/manifest.js";

const FIELD_DISPOSITIONS = {
  prompt: "mapped",
  maxTokens: "mapped",
  omitMaxTokens: "mapped",
  minTokens: "rejected",
  temperature: "mapped",
  topP: "mapped",
  topK: "rejected",
  minP: "rejected",
  seed: "rejected",
  repetitionPenalty: "rejected",
  frequencyPenalty: "mapped",
  presencePenalty: "mapped",
  stream: "executor",
  responseFormat: "mapped",
  stopSequences: "rejected",
  onStreamChunk: "executor",
  voiceOutput: "host-only",
  priority: "host-only",
  user: "host-only",
  system: "mapped",
  attachments: "mapped",
  messages: "mapped",
  tools: "mapped",
  toolChoice: "mapped",
  responseSchema: "mapped",
  promptSegments: "mapped",
  providerOptions: "mapped",
  model: "resolver",
  signal: "mapped",
  prefill: "host-only",
  responseSkeleton: "host-only",
  grammar: "host-only",
  streamStructured: "host-only",
  spanSamplerPlan: "host-only",
} as const satisfies {
  [Field in keyof Required<GenerateTextParams>]:
    | "mapped"
    | "rejected"
    | "executor"
    | "host-only"
    | "resolver";
};

function openAIModel(
  overrides: Partial<Model<"openai-responses">> = {},
): Model<Api> {
  return {
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
    ...overrides,
  } as Model<Api>;
}

function anthropicModel(
  overrides: Partial<Model<"anthropic-messages">> = {},
): Model<Api> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    compat: {
      supportsStrictTools: true,
      supportsTemperature: true,
      supportsLongCacheRetention: true,
      sendSessionAffinityHeaders: true,
    },
    ...overrides,
  } as Model<Api>;
}

const openAIResolved: ResolvedPiModelId = {
  qualifiedModel: "openai/gpt-5.4-mini",
  provider: "openai",
  modelId: "gpt-5.4-mini",
  unknownModel: false,
};
const anthropicResolved: ResolvedPiModelId = {
  qualifiedModel: "anthropic/claude-sonnet-4-6",
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  unknownModel: false,
};

function translate(
  params: GenerateTextParams,
  options: {
    model?: Model<Api>;
    resolved?: ResolvedPiModelId;
    signal?: AbortSignal;
    systemPromptFallback?: string;
  } = {},
) {
  return translateGenerateTextCall({
    slot: ModelType.TEXT_SMALL,
    params,
    model: options.model ?? openAIModel(),
    resolved: options.resolved ?? openAIResolved,
    signal: options.signal ?? new AbortController().signal,
    systemPromptFallback: options.systemPromptFallback,
  });
}

function expectRejected(
  params: GenerateTextParams,
  code:
    | "PI_UNSUPPORTED_PARAMETER"
    | "PI_UNSUPPORTED_CAPABILITY"
    | "PI_INVALID_MESSAGE_SEQUENCE" = "PI_UNSUPPORTED_PARAMETER",
  options?: Parameters<typeof translate>[1],
): void {
  expect(() => translate(params, options)).toThrowError(
    expect.objectContaining({ code }),
  );
}

describe("GenerateTextParams exhaustive contract", () => {
  it("contains a compile-time and runtime disposition for every current field", () => {
    expect(Object.keys(FIELD_DISPOSITIONS).sort()).toEqual(
      [
        "attachments",
        "frequencyPenalty",
        "grammar",
        "maxTokens",
        "messages",
        "minP",
        "minTokens",
        "model",
        "omitMaxTokens",
        "onStreamChunk",
        "prefill",
        "presencePenalty",
        "priority",
        "prompt",
        "promptSegments",
        "providerOptions",
        "repetitionPenalty",
        "responseFormat",
        "responseSchema",
        "responseSkeleton",
        "seed",
        "signal",
        "spanSamplerPlan",
        "stopSequences",
        "stream",
        "streamStructured",
        "system",
        "temperature",
        "toolChoice",
        "tools",
        "topK",
        "topP",
        "user",
        "voiceOutput",
      ].sort(),
    );
  });

  const controller = new AbortController();
  const callback = () => {};
  const cases: Array<{
    field: keyof GenerateTextParams;
    params: GenerateTextParams;
    verify: (prepared: ReturnType<typeof translate>) => void;
    signal?: AbortSignal;
  }> = [
    {
      field: "prompt",
      params: { prompt: "legacy" },
      verify: (value) =>
        expect(value.context.messages[0]).toMatchObject({
          role: "user",
          content: [{ type: "text", text: "legacy" }],
        }),
    },
    {
      field: "maxTokens",
      params: { prompt: "x", maxTokens: 321 },
      verify: (value) => expect(value.options.maxTokens).toBe(321),
    },
    {
      field: "omitMaxTokens",
      params: { prompt: "x", maxTokens: 321, omitMaxTokens: true },
      verify: (value) => expect(value.options).not.toHaveProperty("maxTokens"),
    },
    {
      field: "temperature",
      params: { prompt: "x", temperature: 0.4 },
      verify: (value) => expect(value.options.temperature).toBe(0.4),
    },
    {
      field: "topP",
      params: { prompt: "x", topP: 0.8 },
      verify: (value) =>
        expect(value.options.samplingParams).toEqual({ top_p: 0.8 }),
    },
    {
      field: "frequencyPenalty",
      params: { prompt: "x", frequencyPenalty: -0.2 },
      verify: (value) =>
        expect(value.options.samplingParams).toEqual({
          frequency_penalty: -0.2,
        }),
    },
    {
      field: "presencePenalty",
      params: { prompt: "x", presencePenalty: 0.2 },
      verify: (value) =>
        expect(value.options.samplingParams).toEqual({ presence_penalty: 0.2 }),
    },
    {
      field: "stream",
      params: { prompt: "x", stream: true },
      verify: (value) => expect(value.options).not.toHaveProperty("stream"),
    },
    {
      field: "responseFormat",
      params: { prompt: "x", responseFormat: { type: "json_object" } },
      verify: (value) =>
        expect(value.structuredResponseTool).toBe(
          "__eliza_structured_response",
        ),
    },
    {
      field: "onStreamChunk",
      params: { prompt: "x", onStreamChunk: callback },
      verify: (value) =>
        expect(value.options).not.toHaveProperty("onStreamChunk"),
    },
    {
      field: "voiceOutput",
      params: { prompt: "x", voiceOutput: "internal" },
      verify: (value) =>
        expect(value.annotations.hostOnly.voiceOutput).toBe("internal"),
    },
    {
      field: "priority",
      params: { prompt: "x", priority: "background" },
      verify: (value) =>
        expect(value.annotations.hostOnly.priority).toBe("background"),
    },
    {
      field: "user",
      params: { prompt: "x", user: "host-user" },
      verify: (value) => expect(value.annotations.user).toBe("host-user"),
    },
    {
      field: "system",
      params: { prompt: "x", system: "Explicit system" },
      verify: (value) =>
        expect(value.context.systemPrompt).toBe("Explicit system"),
    },
    {
      field: "attachments",
      params: {
        prompt: "x",
        attachments: [{ mediaType: "image/png", data: "aGVsbG8=" }],
      },
      verify: (value) =>
        expect(value.context.messages[0]).toMatchObject({
          role: "user",
          content: expect.arrayContaining([
            { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ]),
        }),
    },
    {
      field: "messages",
      params: {
        prompt: "ignored",
        messages: [{ role: "user", content: "native" }],
      },
      verify: (value) =>
        expect(value.context.messages[0]).toMatchObject({
          content: [{ type: "text", text: "native" }],
        }),
    },
    {
      field: "tools",
      params: {
        prompt: "x",
        tools: [{ name: "lookup", parameters: { type: "object" } }],
      },
      verify: (value) => expect(value.context.tools?.[0].name).toBe("lookup"),
    },
    {
      field: "toolChoice",
      params: {
        prompt: "x",
        tools: [{ name: "lookup", parameters: { type: "object" } }],
        toolChoice: {
          type: "tool",
          toolName: "lookup",
        } as unknown as GenerateTextParams["toolChoice"],
      },
      verify: (value) =>
        expect(value.options.toolChoice).toEqual({
          type: "function",
          name: "lookup",
        }),
    },
    {
      field: "responseSchema",
      params: {
        prompt: "x",
        responseSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
      verify: (value) => expect(value.context.tools).toHaveLength(1),
    },
    {
      field: "promptSegments",
      params: {
        prompt: "cached prompt",
        promptSegments: [
          { content: "cached ", stable: true, ttl: "long" },
          { content: "prompt", stable: false },
        ],
      },
      verify: (value) =>
        expect(value.annotations.unsupportedPromptCacheHints).toBe(true),
    },
    {
      field: "providerOptions",
      params: {
        prompt: "x",
        providerOptions: {
          pi: {
            cacheRetention: "short",
            timeoutMs: 1_000,
            maxRetries: 1,
            maxRetryDelayMs: 500,
            metadata: { requestClass: "test" },
          },
          openai: {
            reasoningEffort: "low",
            reasoningSummary: "concise",
            serviceTier: "default",
          },
        },
      },
      verify: (value) =>
        expect(value.options).toMatchObject({
          cacheRetention: "short",
          timeoutMs: 1_000,
          maxRetries: 1,
          maxRetryDelayMs: 500,
          metadata: { requestClass: "test" },
          reasoningEffort: "low",
          reasoningSummary: "concise",
          serviceTier: "default",
        }),
    },
    {
      field: "model",
      params: { prompt: "x", model: "openai/gpt-5.4" },
      verify: () => {
        const resolved = resolveQualifiedPiModel({
          slot: ModelType.TEXT_SMALL,
          params: { prompt: "x", model: "openai/gpt-5.4" },
          routeSnapshot: {
            ELIZA_LLM_TEXT_SMALL_MODEL: "openai/gpt-5.4-nano",
          },
          catalogSource: staticPiCatalogSource,
          providerManifest: CURATED_PI_PROVIDERS,
        });
        expect(resolved.qualifiedModel).toBe("openai/gpt-5.4");
      },
    },
    {
      field: "signal",
      params: { prompt: "x", signal: controller.signal },
      signal: controller.signal,
      verify: (value) => expect(value.options.signal).toBe(controller.signal),
    },
    {
      field: "prefill",
      params: { prompt: "x", prefill: "prefix" },
      verify: (value) =>
        expect(value.annotations.hostOnly.prefill).toBe("prefix"),
    },
    {
      field: "responseSkeleton",
      params: { prompt: "x", responseSkeleton: {} as never },
      verify: (value) =>
        expect(value.annotations.hostOnly.responseSkeleton).toEqual({}),
    },
    {
      field: "grammar",
      params: { prompt: "x", grammar: "root ::= text" },
      verify: (value) =>
        expect(value.annotations.hostOnly.grammar).toBe("root ::= text"),
    },
    {
      field: "streamStructured",
      params: { prompt: "x", streamStructured: true },
      verify: (value) =>
        expect(value.annotations.hostOnly.streamStructured).toBe(true),
    },
    {
      field: "spanSamplerPlan",
      params: { prompt: "x", spanSamplerPlan: { overrides: [] } },
      verify: (value) =>
        expect(value.annotations.hostOnly.spanSamplerPlan).toEqual({
          overrides: [],
        }),
    },
  ];

  it.each(cases)("handles $field according to its disposition", (testCase) => {
    const prepared = translate(testCase.params, { signal: testCase.signal });
    testCase.verify(prepared);
  });

  it.each([
    ["minTokens", { minTokens: 1 }],
    ["topK", { topK: 4 }],
    ["minP", { minP: 0.1 }],
    ["seed", { seed: 7 }],
    ["repetitionPenalty", { repetitionPenalty: 1.1 }],
    ["stopSequences", { stopSequences: ["stop"] }],
  ] as const)("typed-rejects unsupported %s", (_field, value) => {
    expectRejected({ prompt: "x", ...value });
  });
});

describe("provider capability combinations and malformed inputs", () => {
  it("maps supported Anthropic thinking options and named tool choice", () => {
    const prepared = translate(
      {
        prompt: "x",
        tools: [
          { name: "lookup", parameters: { type: "object" }, strict: true },
        ],
        toolChoice: "required",
        providerOptions: {
          pi: { cacheRetention: "long", sessionId: "session-1" },
          anthropic: {
            thinkingEnabled: true,
            thinkingBudgetTokens: 2_048,
            effort: "high",
            thinkingDisplay: "omitted",
            interleavedThinking: true,
          },
        },
      },
      { model: anthropicModel(), resolved: anthropicResolved },
    );
    expect(prepared.options).toMatchObject({
      toolChoice: "any",
      cacheRetention: "long",
      sessionId: "session-1",
      thinkingEnabled: true,
      thinkingBudgetTokens: 2_048,
      effort: "high",
      thinkingDisplay: "omitted",
      interleavedThinking: true,
    });
  });

  it.each([
    ["unknown namespace", { other: {} }],
    ["non-object pi namespace", { pi: "bad" }],
    ["endpoint", { openai: { endpoint: "https://evil.invalid" } }],
    ["base URL", { openai: { baseUrl: "https://evil.invalid" } }],
    ["headers", { openai: { headers: { authorization: "secret" } } }],
    ["wrong timeout type", { pi: { timeoutMs: "1000" } }],
    ["wrong retry type", { pi: { maxRetries: "2" } }],
    ["wrong metadata type", { pi: { metadata: "secret" } }],
    ["wrong thinking opt-in", { pi: { includeThinking: "yes" } }],
    ["wrong reasoning effort", { openai: { reasoningEffort: "extreme" } }],
  ])(
    "rejects malformed/forbidden provider options: %s",
    (_name, providerOptions) => {
      expectRejected({
        prompt: "x",
        providerOptions:
          providerOptions as GenerateTextParams["providerOptions"],
      });
    },
  );

  it.each([
    ["canonical toolName", { type: "tool", toolName: "lookup" }],
    ["core tool/name", { type: "tool", name: "lookup" }],
    [
      "OpenAI function wrapper",
      { type: "function", function: { name: "lookup" } },
    ],
    ["core bare name", { name: "lookup" }],
  ])(
    "accepts the evidenced named tool-choice form: %s",
    (_name, toolChoice) => {
      const prepared = translate({
        prompt: "x",
        tools: [{ name: "lookup", parameters: { type: "object" } }],
        toolChoice: toolChoice as GenerateTextParams["toolChoice"],
      });
      expect(prepared.options.toolChoice).toEqual({
        type: "function",
        name: "lookup",
      });
    },
  );

  it.each([
    ["array", { type: "array", items: { type: "string" } }],
    ["scalar", { type: "string" }],
    ["boolean", { type: "boolean" }],
    ["implicit root", { properties: { ok: { type: "boolean" } } }],
  ])(
    "rejects non-object-root structured response schemas: %s",
    (_name, responseSchema) => {
      expectRejected(
        {
          prompt: "x",
          responseSchema:
            responseSchema as GenerateTextParams["responseSchema"],
        },
        "PI_UNSUPPORTED_CAPABILITY",
      );
    },
  );

  it("rejects unsupported model capabilities before provider work", () => {
    expectRejected(
      {
        prompt: "x",
        attachments: [{ mediaType: "image/png", data: "aGVsbG8=" }],
      },
      "PI_UNSUPPORTED_CAPABILITY",
      { model: openAIModel({ input: ["text"] }) },
    );
    expectRejected(
      {
        prompt: "x",
        tools: [{ name: "lookup", strict: true }],
      },
      "PI_UNSUPPORTED_CAPABILITY",
      { model: openAIModel({ compat: { supportsStrictMode: false } }) },
    );
    expectRejected(
      { prompt: "x", temperature: 0.2 },
      "PI_UNSUPPORTED_CAPABILITY",
      {
        model: anthropicModel({ compat: { supportsTemperature: false } }),
        resolved: anthropicResolved,
      },
    );
    expectRejected(
      {
        prompt: "x",
        providerOptions: { pi: { cacheRetention: "long" } },
      },
      "PI_UNSUPPORTED_CAPABILITY",
      {
        model: openAIModel({ compat: { supportsLongCacheRetention: false } }),
      },
    );
    expectRejected(
      {
        prompt: "x",
        providerOptions: { anthropic: { thinkingEnabled: true } },
      },
      "PI_UNSUPPORTED_CAPABILITY",
      {
        model: anthropicModel({ reasoning: false }),
        resolved: anthropicResolved,
      },
    );
  });

  it.each([
    ["topP", { topP: 0.5 }],
    ["frequencyPenalty", { frequencyPenalty: 0.5 }],
    ["presencePenalty", { presencePenalty: 0.5 }],
  ] as const)(
    "rejects Anthropic %s rather than silently dropping it",
    (_name, control) => {
      expectRejected({ prompt: "x", ...control }, "PI_UNSUPPORTED_PARAMETER", {
        model: anthropicModel(),
        resolved: anthropicResolved,
      });
    },
  );

  it("rejects advanced requests for an explicitly allowlisted unknown model", () => {
    expectRejected(
      {
        prompt: "x",
        tools: [{ name: "lookup" }],
        providerOptions: { pi: { allowUnknownModel: true } },
      },
      "PI_UNSUPPORTED_CAPABILITY",
      {
        model: openAIModel({
          id: "future-model",
          name: "future-model",
          reasoning: false,
          input: ["text"],
        }),
        resolved: {
          qualifiedModel: "openai/future-model",
          provider: "openai",
          modelId: "future-model",
          unknownModel: true,
        },
      },
    );
  });

  it.each([
    ["null message", { messages: [null] }],
    ["unknown role", { messages: [{ role: "admin", content: "x" }] }],
    [
      "orphan result",
      { messages: [{ role: "tool", toolCallId: "missing", content: "x" }] },
    ],
    [
      "missing result",
      {
        messages: [
          {
            role: "assistant",
            toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }],
          },
          { role: "user", content: "next" },
        ],
      },
    ],
    [
      "malformed content",
      { messages: [{ role: "user", content: [{ type: "text" }] }] },
    ],
  ])("rejects malformed messages: %s", (_name, params) => {
    expectRejected(params as GenerateTextParams, "PI_INVALID_MESSAGE_SEQUENCE");
  });

  it.each([
    ["non-array tools", { tools: {} }, "PI_UNSUPPORTED_PARAMETER"],
    ["null definition", { tools: [null] }, "PI_UNSUPPORTED_CAPABILITY"],
    [
      "invalid name",
      { tools: [{ name: "bad name" }] },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "duplicate name",
      { tools: [{ name: "same" }, { name: "same" }] },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "non-object schema",
      { tools: [{ name: "lookup", parameters: "bad" }] },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "invalid choice",
      { tools: [{ name: "lookup" }], toolChoice: "sometimes" },
      "PI_UNSUPPORTED_PARAMETER",
    ],
    [
      "invalid named-choice discriminator",
      {
        tools: [{ name: "lookup" }],
        toolChoice: { type: "invalid", name: "lookup" },
      },
      "PI_UNSUPPORTED_PARAMETER",
    ],
    [
      "ambiguous canonical/compat named choice",
      {
        tools: [{ name: "lookup" }],
        toolChoice: { type: "tool", toolName: "lookup", name: "lookup" },
      },
      "PI_UNSUPPORTED_PARAMETER",
    ],
    [
      "extra named-choice fields",
      {
        tools: [{ name: "lookup" }],
        toolChoice: { type: "tool", toolName: "lookup", extra: true },
      },
      "PI_UNSUPPORTED_PARAMETER",
    ],
  ] as const)("rejects malformed tools: %s", (_name, value, code) => {
    expectRejected(
      { prompt: "x", ...(value as object) } as GenerateTextParams,
      code,
    );
  });

  it.each([
    [
      "non-image MIME",
      { mediaType: "application/pdf", data: "raw" },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "remote URL",
      { mediaType: "image/png", data: new URL("https://example.com/a.png") },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "file URL",
      { mediaType: "image/png", data: new URL("file:///tmp/a.png") },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "tilde path",
      { mediaType: "image/png", data: "~/private.png" },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    [
      "Windows path",
      { mediaType: "image/png", data: "C:\\private.png" },
      "PI_UNSUPPORTED_CAPABILITY",
    ],
    ["missing data", { mediaType: "image/png" }, "PI_UNSUPPORTED_PARAMETER"],
  ] as const)(
    "rejects unsafe or malformed attachments: %s",
    (_name, attachment, code) => {
      expectRejected(
        {
          prompt: "x",
          attachments: [attachment] as GenerateTextParams["attachments"],
        },
        code,
      );
    },
  );

  it("uses the canonical character system fallback only when no explicit system exists", () => {
    expect(
      translate({ prompt: "x" }, { systemPromptFallback: "Character fallback" })
        .context.systemPrompt,
    ).toBe("Character fallback");
    expect(
      translate(
        { prompt: "x", system: "Explicit" },
        { systemPromptFallback: "Character fallback" },
      ).context.systemPrompt,
    ).toBe("Explicit");
  });
});
