/**
 * Normalizes terminal Pi messages while keeping visible text, thinking, tools,
 * usage, and gateway/upstream identity on separate elizaOS surfaces.
 */
import type {
  Api,
  AssistantMessage,
  Model,
  ToolCall as PiToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { JsonValue, TokenUsage, ToolCall } from "@elizaos/core";
import { PiTextError } from "./errors.js";
import type { ResolvedPiModelId } from "./resolve-model.js";
import { PORTABLE_TOOL_NAME } from "./translate-input.js";

export interface PiProviderMetadata extends Record<string, unknown> {
  readonly gateway: "pi";
  readonly provider: string;
  readonly modelName: string;
  readonly qualifiedModel: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly cost?: { readonly usd: number };
  readonly thinkingTokens?: number;
  readonly thinking?: string;
}

export interface NormalizedPiTextResult {
  readonly text: string;
  readonly thinking: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
  readonly finishReason: string;
  readonly providerMetadata: PiProviderMetadata;
  readonly costUsd?: number;
}

function hasInvalidModelCharacters(value: string): boolean {
  return [...value].some(
    (character) => /\s/.test(character) || character.charCodeAt(0) <= 0x1f,
  );
}

function jsonArguments(
  value: Record<string, unknown>,
  resolved: ResolvedPiModelId,
): Record<string, JsonValue> {
  try {
    const serialized = JSON.stringify(value);
    const parsed: unknown = JSON.parse(serialized);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new TypeError("tool arguments are not an object");
    }
    return parsed as Record<string, JsonValue>;
  } catch (cause) {
    // error-policy:J3 malformed upstream tool arguments are a terminal provider
    // protocol error; they are never exposed as a successful native result.
    throw new PiTextError("Pi returned non-JSON tool-call arguments", {
      code: "PI_STREAM_TERMINATED",
      cause,
      context: {
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
      },
    });
  }
}

function normalizeToolCall(
  call: PiToolCall,
  resolved: ResolvedPiModelId,
): ToolCall {
  return {
    id: call.id,
    name: call.name,
    arguments: jsonArguments(call.arguments, resolved),
  };
}

export function translatePiUsage(usage: Usage): TokenUsage {
  if (
    typeof usage !== "object" ||
    usage === null ||
    typeof usage.cost !== "object" ||
    usage.cost === null
  ) {
    throw new PiTextError("Pi returned malformed token usage", {
      code: "PI_STREAM_TERMINATED",
    });
  }
  const tokenValues = [
    usage.input,
    usage.output,
    usage.cacheRead,
    usage.cacheWrite,
    usage.totalTokens,
    ...(usage.cacheWrite1h === undefined ? [] : [usage.cacheWrite1h]),
    ...(usage.reasoning === undefined ? [] : [usage.reasoning]),
  ];
  const costValues = [
    usage.cost.input,
    usage.cost.output,
    usage.cost.cacheRead,
    usage.cost.cacheWrite,
    usage.cost.total,
  ];
  if (
    tokenValues.some(
      (value) =>
        !Number.isFinite(value) || value < 0 || !Number.isInteger(value),
    ) ||
    costValues.some((value) => !Number.isFinite(value) || value < 0) ||
    (usage.reasoning !== undefined && usage.reasoning > usage.output) ||
    (usage.cacheWrite1h !== undefined && usage.cacheWrite1h > usage.cacheWrite)
  ) {
    throw new PiTextError("Pi returned malformed token usage", {
      code: "PI_STREAM_TERMINATED",
    });
  }
  return {
    promptTokens: usage.input,
    completionTokens: usage.output,
    totalTokens: usage.totalTokens,
    ...(usage.cacheRead === 0 ? {} : { cacheReadInputTokens: usage.cacheRead }),
    ...(usage.cacheWrite === 0
      ? {}
      : { cacheCreationInputTokens: usage.cacheWrite }),
    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: usage.reasoning }),
  };
}

export function translatePiAssistantMessage(args: {
  message: AssistantMessage;
  model: Model<Api>;
  resolved: ResolvedPiModelId;
  structuredResponseTool?: string;
  declaredToolNames?: ReadonlySet<string>;
  includeThinking: boolean;
}): NormalizedPiTextResult {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ToolCall[] = [];
  const seenToolIds = new Set<string>();
  let structuredText: string | undefined;

  if (typeof args.message !== "object" || args.message === null) {
    throw new PiTextError("Pi returned a malformed assistant envelope", {
      code: "PI_STREAM_TERMINATED",
    });
  }
  const responseModel = args.message.responseModel ?? args.message.model;
  if (
    args.message.role !== "assistant" ||
    args.message.api !== args.model.api ||
    args.message.provider !== args.resolved.provider ||
    args.message.model !== args.model.id ||
    typeof responseModel !== "string" ||
    responseModel.trim().length === 0 ||
    hasInvalidModelCharacters(responseModel) ||
    !Number.isFinite(args.message.timestamp) ||
    args.message.timestamp < 0
  ) {
    throw new PiTextError("Pi returned mismatched provider/model attribution", {
      code: "PI_STREAM_TERMINATED",
      context: {
        provider: args.resolved.provider,
        qualifiedModel: args.resolved.qualifiedModel,
      },
    });
  }
  if (!Array.isArray(args.message.content)) {
    throw new PiTextError("Pi returned malformed assistant content", {
      code: "PI_STREAM_TERMINATED",
      context: {
        provider: args.resolved.provider,
        qualifiedModel: args.resolved.qualifiedModel,
      },
    });
  }

  for (const content of args.message.content) {
    if (typeof content !== "object" || content === null) {
      throw new PiTextError("Pi returned malformed assistant content", {
        code: "PI_STREAM_TERMINATED",
        context: {
          provider: args.resolved.provider,
          qualifiedModel: args.resolved.qualifiedModel,
        },
      });
    }
    if (content.type === "text") {
      if (typeof content.text !== "string") {
        throw new PiTextError("Pi returned malformed text content", {
          code: "PI_STREAM_TERMINATED",
        });
      }
      text.push(content.text);
      continue;
    }
    if (content.type === "thinking") {
      if (typeof content.thinking !== "string") {
        throw new PiTextError("Pi returned malformed thinking content", {
          code: "PI_STREAM_TERMINATED",
        });
      }
      thinking.push(content.thinking);
      continue;
    }
    if (
      content.type !== "toolCall" ||
      typeof content.id !== "string" ||
      content.id.trim().length === 0 ||
      typeof content.name !== "string" ||
      !PORTABLE_TOOL_NAME.test(content.name) ||
      seenToolIds.has(content.id) ||
      (args.declaredToolNames !== undefined &&
        !args.declaredToolNames.has(content.name))
    ) {
      throw new PiTextError("Pi returned malformed or undeclared tool calls", {
        code: "PI_STREAM_TERMINATED",
        context: {
          provider: args.resolved.provider,
          qualifiedModel: args.resolved.qualifiedModel,
        },
      });
    }
    seenToolIds.add(content.id);
    if (content.name === args.structuredResponseTool) {
      if (structuredText !== undefined) {
        throw new PiTextError("Pi returned multiple structured responses", {
          code: "PI_STREAM_TERMINATED",
          context: {
            provider: args.resolved.provider,
            qualifiedModel: args.resolved.qualifiedModel,
          },
        });
      }
      structuredText = JSON.stringify(
        jsonArguments(content.arguments, args.resolved),
      );
    } else {
      toolCalls.push(normalizeToolCall(content, args.resolved));
    }
  }

  if (
    args.structuredResponseTool !== undefined &&
    (structuredText === undefined ||
      text.join("").length > 0 ||
      toolCalls.length > 0)
  ) {
    throw new PiTextError("Pi violated the structured-response contract", {
      code: "PI_STREAM_TERMINATED",
      context: {
        provider: args.resolved.provider,
        qualifiedModel: args.resolved.qualifiedModel,
      },
    });
  }
  const visibleText = structuredText ?? text.join("");
  const visibleThinking = thinking.join("");
  if (visibleText.length === 0 && toolCalls.length === 0) {
    throw new PiTextError("Pi returned an empty assistant result", {
      code: "PI_EMPTY_RESULT",
      context: {
        provider: args.resolved.provider,
        qualifiedModel: args.resolved.qualifiedModel,
      },
    });
  }
  const usage = translatePiUsage(args.message.usage);
  const returnedToolCall = structuredText !== undefined || toolCalls.length > 0;
  if (
    (returnedToolCall && args.message.stopReason !== "toolUse") ||
    (!returnedToolCall && args.message.stopReason === "toolUse") ||
    (args.message.stopReason !== "stop" &&
      args.message.stopReason !== "length" &&
      args.message.stopReason !== "toolUse" &&
      args.message.stopReason !== "deferred")
  ) {
    throw new PiTextError("Pi returned an invalid terminal stop reason", {
      code: "PI_STREAM_TERMINATED",
      context: {
        provider: args.resolved.provider,
        qualifiedModel: args.resolved.qualifiedModel,
      },
    });
  }
  const finishReason =
    args.message.stopReason === "toolUse"
      ? "tool-calls"
      : args.message.stopReason;
  const costUsd =
    !args.resolved.unknownModel &&
    Number.isFinite(args.message.usage.cost.total) &&
    args.message.usage.cost.total >= 0
      ? args.message.usage.cost.total
      : undefined;
  const providerMetadata: PiProviderMetadata = {
    gateway: "pi",
    provider: args.message.provider || args.resolved.provider,
    modelName:
      args.message.responseModel ?? args.message.model ?? args.model.id,
    qualifiedModel: `${args.resolved.provider}/${
      args.message.responseModel ?? args.message.model ?? args.model.id
    }`,
    finishReason,
    usage,
    ...(costUsd === undefined ? {} : { cost: { usd: costUsd } }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { thinkingTokens: usage.reasoningTokens }),
    ...(args.includeThinking && visibleThinking.length > 0
      ? { thinking: visibleThinking }
      : {}),
  };

  return {
    text: visibleText,
    thinking: visibleThinking,
    toolCalls,
    usage,
    finishReason,
    providerMetadata,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}
