/**
 * Purely translates the complete elizaOS text request into Pi context/options,
 * rejecting any hosted capability that cannot preserve caller intent.
 */
import type {
  AnthropicOptions,
  Api,
  AssistantMessage,
  Context,
  ImageContent,
  Model,
  ModelsApiStreamOptions,
  OpenAIResponsesOptions,
  ToolCall as PiToolCall,
  TextContent,
  ThinkingContent,
  Tool,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  dropDuplicateLeadingSystemMessage,
  type GenerateTextAttachment,
  type GenerateTextParams,
  type JSONSchema,
  resolveEffectiveSystemPrompt,
  type TextGenerationModelType,
  type ToolCall,
  type ToolDefinition,
} from "@elizaos/core";
import { PiTextError } from "./errors.js";
import type { ResolvedPiModelId } from "./resolve-model.js";

const STRUCTURED_RESPONSE_TOOL = "__eliza_structured_response";
export const PORTABLE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const HOST_ONLY_FIELDS = [
  "voiceOutput",
  "priority",
  "prefill",
  "responseSkeleton",
  "grammar",
  "streamStructured",
  "spanSamplerPlan",
] as const;

export interface PiTranslationAnnotations {
  readonly hostOnly: Readonly<Record<string, unknown>>;
  readonly unsupportedPromptCacheHints: boolean;
  readonly user?: string;
  readonly includeThinking: boolean;
}

export interface PreparedPiTextRequest {
  readonly context: Context;
  readonly options: ModelsApiStreamOptions<Api>;
  readonly nativeResult: boolean;
  readonly structuredResponseTool?: string;
  readonly annotations: PiTranslationAnnotations;
}

function unsupported(
  field: string,
  resolved: ResolvedPiModelId,
  requiredCapability?: string,
): never {
  throw new PiTextError(`Pi cannot preserve the requested ${field} behavior`, {
    code:
      requiredCapability === undefined
        ? "PI_UNSUPPORTED_PARAMETER"
        : "PI_UNSUPPORTED_CAPABILITY",
    context: {
      field,
      qualifiedModel: resolved.qualifiedModel,
      provider: resolved.provider,
      ...(requiredCapability === undefined ? {} : { requiredCapability }),
    },
  });
}

function invalidSequence(message: string, index?: number): never {
  throw new PiTextError(message, {
    code: "PI_INVALID_MESSAGE_SEQUENCE",
    context: index === undefined ? undefined : { messageIndex: index },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertJsonCompatible(
  value: unknown,
  field: string,
  resolved: ResolvedPiModelId,
  seen = new Set<object>(),
): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    unsupported(field, resolved, "finite JSON values");
  }
  if (typeof value !== "object") {
    unsupported(field, resolved, "JSON-serializable values");
  }
  if (seen.has(value)) {
    unsupported(field, resolved, "acyclic JSON values");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item === undefined) unsupported(field, resolved, "JSON array values");
      assertJsonCompatible(item, field, resolved, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      unsupported(field, resolved, "plain JSON objects");
    }
    for (const item of Object.values(value)) {
      assertJsonCompatible(item, field, resolved, seen);
    }
  }
  seen.delete(value);
}

function cloneJson<T>(value: T, field: string, resolved: ResolvedPiModelId): T {
  if (value === undefined) return value;
  assertJsonCompatible(value, field, resolved);
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch (cause) {
    // error-policy:J3 request-owned objects must be serializable before they
    // cross the provider boundary; cyclic/non-JSON values are explicit errors.
    throw new PiTextError("Pi request values must be JSON serializable", {
      code: "PI_UNSUPPORTED_PARAMETER",
      cause,
      context: {
        field,
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
      },
    });
  }
}

function textPart(text: string): TextContent {
  return { type: "text", text };
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function imageData(
  data: string | URL | Uint8Array,
  mediaType: string | undefined,
  resolved: ResolvedPiModelId,
  field: string,
): ImageContent {
  if (!mediaType?.toLowerCase().startsWith("image/")) {
    unsupported(field, resolved, "image input");
  }
  if (data instanceof Uint8Array) {
    return {
      type: "image",
      data: Buffer.from(data.slice()).toString("base64"),
      mimeType: mediaType,
    };
  }
  const value = data instanceof URL ? data.toString() : data;
  const match = value.match(/^data:([^;,]+);base64,(.*)$/s);
  if (match !== null) {
    if (!match[1].toLowerCase().startsWith("image/")) {
      unsupported(field, resolved, "image input");
    }
    return { type: "image", data: match[2], mimeType: match[1] };
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /^(?:\/|~\/|\.\/|\.\.\/|\\|~\\|\.\\|\.\.\\)/.test(value)
  ) {
    unsupported(
      field,
      resolved,
      "inline image data without fetch or local path access",
    );
  }
  return { type: "image", data: value, mimeType: mediaType };
}

function messageContent(
  content: import("@elizaos/core").ChatMessage["content"],
  resolved: ResolvedPiModelId,
  role: "user" | "assistant" | "tool",
): Array<TextContent | ImageContent | ThinkingContent> {
  if (typeof content === "string") return [textPart(content)];
  if (content === null || content === undefined) return [];
  if (!Array.isArray(content))
    invalidSequence("Message content must be an array or string");
  const output: Array<TextContent | ImageContent | ThinkingContent> = [];
  for (const part of content) {
    if (!isRecord(part) || typeof part.type !== "string") {
      invalidSequence("Message content parts must have a string type");
    }
    const record = part as unknown as Record<string, unknown>;
    if (record.type === "text") {
      if (typeof record.text !== "string")
        invalidSequence("Text content must contain text");
      output.push(textPart(record.text));
      continue;
    }
    if (record.type === "image") {
      if (role === "assistant") unsupported("messages.content.image", resolved);
      const image = record.image;
      if (
        !(
          typeof image === "string" ||
          image instanceof URL ||
          image instanceof Uint8Array
        )
      ) {
        invalidSequence("Image content is missing data");
      }
      output.push(
        imageData(
          image,
          typeof record.mediaType === "string" ? record.mediaType : undefined,
          resolved,
          "messages.content.image",
        ),
      );
      continue;
    }
    if (record.type === "file") {
      if (role === "assistant") unsupported("messages.content.file", resolved);
      const data = record.data;
      if (
        !(
          typeof data === "string" ||
          data instanceof URL ||
          data instanceof Uint8Array
        )
      ) {
        invalidSequence("File content is missing data");
      }
      output.push(
        imageData(
          data,
          typeof record.mediaType === "string" ? record.mediaType : undefined,
          resolved,
          "messages.content.file",
        ),
      );
      continue;
    }
    if (record.type === "thinking" && role === "assistant") {
      const thinking = record.thinking ?? record.text;
      if (typeof thinking !== "string")
        invalidSequence("Thinking content must contain text");
      output.push({ type: "thinking", thinking });
      continue;
    }
    unsupported(`messages.content.${record.type}`, resolved);
  }
  return output;
}

function parseToolArguments(
  call: ToolCall,
  messageIndex: number,
  resolved: ResolvedPiModelId,
): Record<string, unknown> {
  const raw = call.arguments ?? call.args ?? call.input ?? call.params;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // error-policy:J3 untrusted tool history is rejected explicitly below.
    }
    invalidSequence(
      "Assistant tool-call arguments must be a JSON object",
      messageIndex,
    );
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return cloneJson(
      raw as Record<string, unknown>,
      "messages.toolCalls.arguments",
      resolved,
    );
  }
  invalidSequence("Assistant tool-call arguments are missing", messageIndex);
}

function systemMessageText(
  message: import("@elizaos/core").ChatMessage,
  resolved: ResolvedPiModelId,
): string {
  if (typeof message.content === "string") return message.content;
  if (message.content === null || message.content === undefined) return "";
  const parts: string[] = [];
  for (const part of message.content) {
    const record = part as Record<string, unknown>;
    if (part.type !== "text" || typeof record.text !== "string") {
      unsupported(
        "messages.system.content",
        resolved,
        "text system instructions",
      );
    }
    parts.push(record.text);
  }
  return parts.join("");
}

function translateMessages(
  params: GenerateTextParams,
  model: Model<Api>,
  resolved: ResolvedPiModelId,
  systemPromptFallback?: string,
): Context {
  if (params.messages !== undefined && !Array.isArray(params.messages)) {
    invalidSequence("Messages must be an array");
  }
  if (params.prompt !== undefined && typeof params.prompt !== "string") {
    unsupported("prompt", resolved);
  }
  if (params.system !== undefined && typeof params.system !== "string") {
    unsupported("system", resolved);
  }
  const original = params.messages?.length
    ? params.messages
    : params.prompt?.length
      ? [{ role: "user" as const, content: params.prompt }]
      : [];
  if (original.length === 0) {
    throw new PiTextError("Pi text generation requires messages or a prompt", {
      code: "PI_UNSUPPORTED_PARAMETER",
      context: { field: "messages", qualifiedModel: resolved.qualifiedModel },
    });
  }
  for (let index = 0; index < original.length; index += 1) {
    const message = original[index];
    if (!isRecord(message) || typeof message.role !== "string") {
      invalidSequence("Messages must contain a supported role", index);
    }
  }

  const resolvedSystem = resolveEffectiveSystemPrompt({
    params,
    fallback: systemPromptFallback,
  });
  const withoutDuplicate =
    dropDuplicateLeadingSystemMessage(original, resolvedSystem) ?? original;
  const systemParts = resolvedSystem ? [resolvedSystem] : [];
  let historyStart = 0;
  while (
    historyStart < withoutDuplicate.length &&
    (withoutDuplicate[historyStart].role === "system" ||
      withoutDuplicate[historyStart].role === "developer")
  ) {
    const content = systemMessageText(withoutDuplicate[historyStart], resolved);
    if (content && !systemParts.includes(content)) systemParts.push(content);
    historyStart += 1;
  }
  const systemPrompt =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined;
  const messages: Context["messages"] = [];
  const calls = new Map<string, { name: string; completed: boolean }>();

  for (let index = historyStart; index < withoutDuplicate.length; index += 1) {
    const message = withoutDuplicate[index];
    if (!isRecord(message) || typeof message.role !== "string") {
      invalidSequence("Messages must contain a supported role", index);
    }
    if (message.role === "system" || message.role === "developer") {
      invalidSequence(
        "System messages must precede conversation history",
        index,
      );
    }
    if (message.role === "user") {
      if ([...calls.values()].some((call) => !call.completed)) {
        invalidSequence("Every preceding tool call requires a result", index);
      }
      const translated = messageContent(message.content, resolved, "user");
      const content = translated.filter(
        (part): part is TextContent | ImageContent => part.type !== "thinking",
      );
      messages.push({
        role: "user",
        content,
        timestamp: 0,
      } satisfies UserMessage);
      continue;
    }
    if (message.role === "assistant") {
      if ([...calls.values()].some((call) => !call.completed)) {
        invalidSequence("Every preceding tool call requires a result", index);
      }
      if (
        message.toolCalls !== undefined &&
        !Array.isArray(message.toolCalls)
      ) {
        invalidSequence("Assistant toolCalls must be an array", index);
      }
      const translated = messageContent(message.content, resolved, "assistant");
      const content: Array<TextContent | ThinkingContent | PiToolCall> =
        translated.filter(
          (part): part is TextContent | ThinkingContent =>
            part.type !== "image",
        );
      for (const call of message.toolCalls ?? []) {
        if (
          !isRecord(call) ||
          typeof call.id !== "string" ||
          typeof call.name !== "string" ||
          !call.id.trim() ||
          !PORTABLE_TOOL_NAME.test(call.name) ||
          calls.has(call.id)
        ) {
          invalidSequence(
            "Assistant tool-call IDs and names must be unique and non-empty",
            index,
          );
        }
        const piCall: PiToolCall = {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: parseToolArguments(call, index, resolved),
        };
        content.push(piCall);
        calls.set(call.id, { name: call.name, completed: false });
      }
      messages.push({
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: zeroUsage(),
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: 0,
      } satisfies AssistantMessage);
      continue;
    }

    if (message.role !== "tool") {
      invalidSequence("Messages must contain a supported role", index);
    }
    if (message.metadata !== undefined && !isRecord(message.metadata)) {
      invalidSequence("Tool-result metadata must be an object", index);
    }
    if (
      isRecord(message.metadata) &&
      message.metadata.isError !== undefined &&
      typeof message.metadata.isError !== "boolean"
    ) {
      invalidSequence("Tool-result isError must be boolean", index);
    }
    const toolCallId =
      typeof message.toolCallId === "string"
        ? message.toolCallId.trim()
        : undefined;
    if (!toolCallId) invalidSequence("Tool results require toolCallId", index);
    const prior = calls.get(toolCallId);
    if (prior === undefined || prior.completed) {
      invalidSequence(
        "Tool results must reference one unmatched preceding tool call",
        index,
      );
    }
    if (message.name && message.name !== prior.name) {
      invalidSequence(
        "Tool result name does not match its preceding call",
        index,
      );
    }
    prior.completed = true;
    const content = messageContent(message.content, resolved, "tool").filter(
      (part): part is TextContent | ImageContent => part.type !== "thinking",
    );
    messages.push({
      role: "toolResult",
      toolCallId,
      toolName: prior.name,
      content,
      isError: message.metadata?.isError === true,
      timestamp: 0,
    } satisfies ToolResultMessage);
  }

  if ([...calls.values()].some((call) => !call.completed)) {
    invalidSequence("Every assistant tool call requires one matching result");
  }

  if (params.attachments !== undefined && !Array.isArray(params.attachments)) {
    unsupported("attachments", resolved);
  }
  if (params.attachments?.length) {
    const final = messages.at(-1);
    if (final?.role !== "user") {
      unsupported("attachments", resolved, "a final user turn");
    }
    if (!model.input.includes("image"))
      unsupported("attachments", resolved, "image input");
    const existing =
      typeof final.content === "string"
        ? [textPart(final.content)]
        : [...final.content];
    for (const attachment of params.attachments) {
      if (
        !isRecord(attachment) ||
        typeof attachment.mediaType !== "string" ||
        attachment.mediaType.trim().length === 0 ||
        !(
          typeof attachment.data === "string" ||
          attachment.data instanceof URL ||
          attachment.data instanceof Uint8Array
        ) ||
        (attachment.filename !== undefined &&
          typeof attachment.filename !== "string")
      ) {
        unsupported("attachments", resolved);
      }
      existing.push(
        translateAttachment(attachment as GenerateTextAttachment, resolved),
      );
    }
    messages[messages.length - 1] = { ...final, content: existing };
  }

  const hasMessageContent = messages.some((message) => {
    const content = message.content;
    if (typeof content === "string") return content.length > 0;
    return content.some((part) => {
      if (part.type === "text") return part.text.length > 0;
      if (part.type === "thinking") return part.thinking.length > 0;
      return true;
    });
  });
  if (!hasMessageContent) {
    throw new PiTextError("Pi text generation received an empty call", {
      code: "PI_UNSUPPORTED_PARAMETER",
      context: { field: "messages", qualifiedModel: resolved.qualifiedModel },
    });
  }

  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    messages,
  };
}

function translateAttachment(
  attachment: GenerateTextAttachment,
  resolved: ResolvedPiModelId,
): ImageContent {
  return imageData(
    attachment.data,
    attachment.mediaType,
    resolved,
    "attachments",
  );
}

function supportsStrictTools(model: Model<Api>): boolean {
  const compat = model.compat as
    | { supportsStrictMode?: boolean; supportsStrictTools?: boolean }
    | undefined;
  return (
    compat?.supportsStrictMode === true || compat?.supportsStrictTools === true
  );
}

function translateTools(
  definitions: readonly ToolDefinition[] | undefined,
  model: Model<Api>,
  resolved: ResolvedPiModelId,
): Tool[] {
  if (definitions !== undefined && !Array.isArray(definitions)) {
    unsupported("tools", resolved);
  }
  const names = new Set<string>();
  return (definitions ?? []).map((definition) => {
    if (
      !isRecord(definition) ||
      typeof definition.name !== "string" ||
      !PORTABLE_TOOL_NAME.test(definition.name) ||
      names.has(definition.name)
    ) {
      unsupported("tools.name", resolved, "unique portable tool names");
    }
    names.add(definition.name);
    if (
      definition.description !== undefined &&
      typeof definition.description !== "string"
    ) {
      unsupported("tools.description", resolved);
    }
    if (
      definition.strict !== undefined &&
      typeof definition.strict !== "boolean"
    ) {
      unsupported("tools.strict", resolved);
    }
    if (
      definition.type !== undefined &&
      definition.type !== "function" &&
      definition.type !== "tool"
    ) {
      unsupported("tools.type", resolved, "function tools");
    }
    if (definition.strict === true && !supportsStrictTools(model)) {
      unsupported("tools.strict", resolved, "strict JSON-schema tools");
    }
    if (
      definition.parameters !== undefined &&
      !isRecord(definition.parameters)
    ) {
      unsupported("tools.parameters", resolved, "JSON schema object");
    }
    const parameters: JSONSchema = cloneJson(
      (definition.parameters ?? {
        type: "object",
        properties: {},
      }) as JSONSchema,
      "tools.parameters",
      resolved,
    );
    if (parameters.type !== undefined && parameters.type !== "object") {
      unsupported("tools.parameters", resolved, "object-root JSON schema");
    }
    return {
      name: definition.name,
      description: definition.description ?? "",
      parameters,
      ...(definition.strict === true
        ? { constrainedSampling: { type: "json_schema", strict: "require" } }
        : {}),
    } satisfies Tool;
  });
}

function selectedToolName(
  choice: GenerateTextParams["toolChoice"],
  resolved: ResolvedPiModelId,
): string | undefined {
  if (choice === undefined) return undefined;
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") {
      return undefined;
    }
    unsupported("toolChoice", resolved);
  }
  if (!isRecord(choice)) unsupported("toolChoice", resolved);
  const record = choice as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.type === "tool") {
    const canonical = record.toolName;
    const compatible = record.name;
    if (
      typeof canonical === "string" &&
      compatible === undefined &&
      keys.join(",") === "toolName,type" &&
      PORTABLE_TOOL_NAME.test(canonical)
    ) {
      return canonical;
    }
    if (
      typeof compatible === "string" &&
      canonical === undefined &&
      keys.join(",") === "name,type" &&
      PORTABLE_TOOL_NAME.test(compatible)
    ) {
      return compatible;
    }
  }
  if (
    record.type === "function" &&
    keys.join(",") === "function,type" &&
    isRecord(record.function) &&
    Object.keys(record.function).length === 1 &&
    typeof record.function.name === "string" &&
    PORTABLE_TOOL_NAME.test(record.function.name)
  ) {
    return record.function.name;
  }
  if (
    record.type === undefined &&
    keys.join(",") === "name" &&
    typeof record.name === "string" &&
    PORTABLE_TOOL_NAME.test(record.name)
  ) {
    return record.name;
  }
  unsupported("toolChoice", resolved);
}

function translateToolChoice(
  params: GenerateTextParams,
  tools: readonly Tool[],
  resolved: ResolvedPiModelId,
):
  | OpenAIResponsesOptions["toolChoice"]
  | AnthropicOptions["toolChoice"]
  | undefined {
  const choice = params.toolChoice;
  if (choice === undefined) return undefined;
  if (tools.length === 0) unsupported("toolChoice", resolved, "tools");
  const named = selectedToolName(choice, resolved);
  if (named !== undefined && !tools.some((tool) => tool.name === named)) {
    unsupported("toolChoice", resolved, "a declared tool name");
  }
  if (resolved.provider === "anthropic") {
    if (choice === "required") return "any";
    if (choice === "auto" || choice === "none") return choice;
    return { type: "tool", name: named as string };
  }
  if (choice === "required" || choice === "auto" || choice === "none")
    return choice;
  return { type: "function", name: named as string };
}

function namespace(
  options: Record<string, unknown>,
  name: string,
  resolved: ResolvedPiModelId,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(options, name)) return undefined;
  const value = options[name];
  if (!isRecord(value)) unsupported(`providerOptions.${name}`, resolved);
  return value;
}

function assertKeys(
  value: Record<string, unknown> | undefined,
  allowed: readonly string[],
  namespaceName: string,
  resolved: ResolvedPiModelId,
): void {
  for (const key of Object.keys(value ?? {})) {
    if (!allowed.includes(key))
      unsupported(`providerOptions.${namespaceName}.${key}`, resolved);
  }
}

function finiteNumber(
  value: unknown,
  field: string,
  resolved: ResolvedPiModelId,
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    unsupported(field, resolved);
  }
  return value as number;
}

function assertOptionalBoolean(
  value: unknown,
  field: string,
  resolved: ResolvedPiModelId,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") unsupported(field, resolved);
  return value;
}

function assertOptionalLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  resolved: ResolvedPiModelId,
  allowNull = false,
): T | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && allowNull) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    unsupported(field, resolved);
  }
  return value as T;
}

function translateOptions(
  params: GenerateTextParams,
  model: Model<Api>,
  resolved: ResolvedPiModelId,
  toolChoice: ReturnType<typeof translateToolChoice>,
  signal: AbortSignal,
): { options: ModelsApiStreamOptions<Api>; includeThinking: boolean } {
  if (
    params.providerOptions !== undefined &&
    !isRecord(params.providerOptions)
  ) {
    unsupported("providerOptions", resolved);
  }
  const all = (params.providerOptions ?? {}) as Record<string, unknown>;
  const allowedNamespaces = new Set(["pi", resolved.provider]);
  for (const key of Object.keys(all)) {
    if (!allowedNamespaces.has(key))
      unsupported(`providerOptions.${key}`, resolved);
  }
  const pi = namespace(all, "pi", resolved);
  const upstream = namespace(all, resolved.provider, resolved);
  assertKeys(
    pi,
    [
      "allowUnknownModel",
      "cacheRetention",
      "sessionId",
      "metadata",
      "timeoutMs",
      "maxRetries",
      "maxRetryDelayMs",
      "includeThinking",
    ],
    "pi",
    resolved,
  );
  assertKeys(
    upstream,
    resolved.provider === "openai"
      ? ["reasoningEffort", "reasoningSummary", "serviceTier"]
      : [
          "thinkingEnabled",
          "thinkingBudgetTokens",
          "effort",
          "thinkingDisplay",
          "interleavedThinking",
        ],
    resolved.provider,
    resolved,
  );

  assertOptionalBoolean(
    pi?.allowUnknownModel,
    "providerOptions.pi.allowUnknownModel",
    resolved,
  );
  const includeThinking =
    assertOptionalBoolean(
      pi?.includeThinking,
      "providerOptions.pi.includeThinking",
      resolved,
    ) === true;
  if (pi?.metadata !== undefined && !isRecord(pi.metadata)) {
    unsupported("providerOptions.pi.metadata", resolved);
  }

  const compat = isRecord(model.compat) ? model.compat : {};
  if (resolved.provider === "openai") {
    const reasoningEffort = assertOptionalLiteral(
      upstream?.reasoningEffort,
      ["minimal", "low", "medium", "high", "xhigh", "max"],
      "providerOptions.openai.reasoningEffort",
      resolved,
    );
    const reasoningSummary = assertOptionalLiteral(
      upstream?.reasoningSummary,
      ["auto", "detailed", "concise"],
      "providerOptions.openai.reasoningSummary",
      resolved,
      true,
    );
    assertOptionalLiteral(
      upstream?.serviceTier,
      ["auto", "default", "flex", "scale", "priority"],
      "providerOptions.openai.serviceTier",
      resolved,
      true,
    );
    if (
      !model.reasoning &&
      (reasoningEffort !== undefined || reasoningSummary !== undefined)
    ) {
      unsupported(
        "providerOptions.openai.reasoningEffort",
        resolved,
        "reasoning model",
      );
    }
  } else {
    const thinkingEnabled = assertOptionalBoolean(
      upstream?.thinkingEnabled,
      "providerOptions.anthropic.thinkingEnabled",
      resolved,
    );
    const thinkingBudgetTokens = finiteNumber(
      upstream?.thinkingBudgetTokens,
      "providerOptions.anthropic.thinkingBudgetTokens",
      resolved,
      1,
      model.maxTokens,
      true,
    );
    const effort = assertOptionalLiteral(
      upstream?.effort,
      ["low", "medium", "high", "xhigh", "max"],
      "providerOptions.anthropic.effort",
      resolved,
    );
    const thinkingDisplay = assertOptionalLiteral(
      upstream?.thinkingDisplay,
      ["summarized", "omitted"],
      "providerOptions.anthropic.thinkingDisplay",
      resolved,
    );
    assertOptionalBoolean(
      upstream?.interleavedThinking,
      "providerOptions.anthropic.interleavedThinking",
      resolved,
    );
    if (
      !model.reasoning &&
      (thinkingEnabled === true ||
        thinkingBudgetTokens !== undefined ||
        effort !== undefined ||
        thinkingDisplay !== undefined)
    ) {
      unsupported(
        "providerOptions.anthropic.thinkingEnabled",
        resolved,
        "reasoning model",
      );
    }
    if (thinkingBudgetTokens !== undefined && thinkingEnabled !== true) {
      unsupported(
        "providerOptions.anthropic.thinkingBudgetTokens",
        resolved,
        "thinkingEnabled",
      );
    }
  }

  const maxTokens = params.omitMaxTokens
    ? undefined
    : finiteNumber(
        params.maxTokens,
        "maxTokens",
        resolved,
        1,
        model.maxTokens,
        true,
      );
  finiteNumber(params.temperature, "temperature", resolved, 0, 2);
  if (
    resolved.provider === "anthropic" &&
    params.temperature !== undefined &&
    compat.supportsTemperature === false
  ) {
    unsupported("temperature", resolved, "model temperature support");
  }
  if (params.minTokens !== undefined) unsupported("minTokens", resolved);
  if (params.stopSequences !== undefined)
    unsupported("stopSequences", resolved);
  if (params.topK !== undefined) unsupported("topK", resolved);
  if (params.minP !== undefined) unsupported("minP", resolved);
  if (params.seed !== undefined) unsupported("seed", resolved);
  if (params.repetitionPenalty !== undefined)
    unsupported("repetitionPenalty", resolved);
  if (resolved.provider === "anthropic") {
    if (params.topP !== undefined) unsupported("topP", resolved);
    if (params.frequencyPenalty !== undefined)
      unsupported("frequencyPenalty", resolved);
    if (params.presencePenalty !== undefined)
      unsupported("presencePenalty", resolved);
  }

  const samplingParams: Record<string, unknown> = {};
  const topP = finiteNumber(params.topP, "topP", resolved, 0, 1);
  const frequencyPenalty = finiteNumber(
    params.frequencyPenalty,
    "frequencyPenalty",
    resolved,
    -2,
    2,
  );
  const presencePenalty = finiteNumber(
    params.presencePenalty,
    "presencePenalty",
    resolved,
    -2,
    2,
  );
  if (topP !== undefined) samplingParams.top_p = topP;
  if (frequencyPenalty !== undefined)
    samplingParams.frequency_penalty = frequencyPenalty;
  if (presencePenalty !== undefined)
    samplingParams.presence_penalty = presencePenalty;

  const cacheRetention = pi?.cacheRetention;
  if (
    cacheRetention !== undefined &&
    cacheRetention !== "none" &&
    cacheRetention !== "short" &&
    cacheRetention !== "long"
  ) {
    unsupported("providerOptions.pi.cacheRetention", resolved);
  }
  if (
    cacheRetention === "long" &&
    compat.supportsLongCacheRetention === false
  ) {
    unsupported(
      "providerOptions.pi.cacheRetention",
      resolved,
      "long cache retention",
    );
  }
  const timeoutMs = finiteNumber(
    pi?.timeoutMs,
    "providerOptions.pi.timeoutMs",
    resolved,
    1,
    Number.MAX_SAFE_INTEGER,
    true,
  );
  const maxRetries = finiteNumber(
    pi?.maxRetries,
    "providerOptions.pi.maxRetries",
    resolved,
    0,
    10,
    true,
  );
  const maxRetryDelayMs = finiteNumber(
    pi?.maxRetryDelayMs,
    "providerOptions.pi.maxRetryDelayMs",
    resolved,
    0,
    300_000,
    true,
  );
  const sessionId = pi?.sessionId;
  if (
    sessionId !== undefined &&
    (typeof sessionId !== "string" || sessionId.trim().length === 0)
  ) {
    unsupported("providerOptions.pi.sessionId", resolved);
  }
  if (
    sessionId !== undefined &&
    resolved.provider === "anthropic" &&
    compat.sendSessionAffinityHeaders !== true
  ) {
    unsupported(
      "providerOptions.pi.sessionId",
      resolved,
      "provider session affinity",
    );
  }

  const options: ModelsApiStreamOptions<Api> = {
    signal,
    ...(params.temperature === undefined
      ? {}
      : { temperature: params.temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(Object.keys(samplingParams).length === 0 ? {} : { samplingParams }),
    ...(cacheRetention === undefined ? {} : { cacheRetention }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(pi?.metadata === undefined
      ? {}
      : {
          metadata: cloneJson(
            pi.metadata,
            "providerOptions.pi.metadata",
            resolved,
          ) as Record<string, unknown>,
        }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(maxRetryDelayMs === undefined ? {} : { maxRetryDelayMs }),
    ...(toolChoice === undefined ? {} : { toolChoice }),
    ...cloneJson(
      upstream ?? {},
      `providerOptions.${resolved.provider}`,
      resolved,
    ),
  };
  return { options, includeThinking };
}

export function translateGenerateTextCall(args: {
  slot: TextGenerationModelType;
  params: GenerateTextParams;
  model: Model<Api>;
  resolved: ResolvedPiModelId;
  signal: AbortSignal;
  systemPromptFallback?: string;
}): PreparedPiTextRequest {
  const { params, model, resolved } = args;
  assertOptionalBoolean(params.stream, "stream", resolved);
  assertOptionalBoolean(params.omitMaxTokens, "omitMaxTokens", resolved);
  if (params.user !== undefined && typeof params.user !== "string") {
    unsupported("user", resolved);
  }
  if (
    params.onStreamChunk !== undefined &&
    typeof params.onStreamChunk !== "function"
  ) {
    unsupported("onStreamChunk", resolved);
  }
  if (params.signal !== undefined && !(params.signal instanceof AbortSignal)) {
    unsupported("signal", resolved);
  }
  if (params.promptSegments !== undefined) {
    if (!Array.isArray(params.promptSegments)) {
      unsupported("promptSegments", resolved);
    }
    for (const segment of params.promptSegments) {
      if (
        !isRecord(segment) ||
        typeof segment.content !== "string" ||
        typeof segment.stable !== "boolean" ||
        (segment.ttl !== undefined &&
          segment.ttl !== "short" &&
          segment.ttl !== "long")
      ) {
        unsupported("promptSegments", resolved);
      }
    }
    const combined = params.promptSegments
      .map((segment) => segment.content)
      .join("");
    if (params.prompt !== combined)
      unsupported("promptSegments", resolved, "prompt concatenation invariant");
  }
  if (resolved.unknownModel) {
    const capabilityFields = [
      params.attachments,
      params.tools,
      params.toolChoice,
      params.responseSchema,
      params.responseFormat,
    ];
    if (capabilityFields.some((value) => value !== undefined)) {
      unsupported(
        "model",
        resolved,
        "catalog capability metadata for advanced requests",
      );
    }
  }
  if (params.attachments?.length && !model.input.includes("image")) {
    unsupported("attachments", resolved, "image input");
  }

  const context = translateMessages(
    params,
    model,
    resolved,
    args.systemPromptFallback,
  );
  const hasMessageImages = context.messages.some(
    (message) =>
      (message.role === "user" || message.role === "toolResult") &&
      Array.isArray(message.content) &&
      message.content.some((content) => content.type === "image"),
  );
  if (hasMessageImages && !model.input.includes("image")) {
    unsupported("messages.content.image", resolved, "image input");
  }
  let tools = translateTools(params.tools, model, resolved);
  let structuredResponseTool: string | undefined;
  if (
    params.responseFormat !== undefined &&
    typeof params.responseFormat !== "string" &&
    !isRecord(params.responseFormat)
  ) {
    unsupported("responseFormat", resolved);
  }
  const format =
    typeof params.responseFormat === "string"
      ? params.responseFormat
      : params.responseFormat?.type;
  if (format !== undefined && format !== "text" && format !== "json_object") {
    unsupported("responseFormat", resolved, "text or JSON object mode");
  }
  if (params.responseSchema !== undefined && !isRecord(params.responseSchema)) {
    unsupported("responseSchema", resolved, "JSON schema object");
  }
  if (params.responseSchema !== undefined || format === "json_object") {
    if (tools.length > 0 || params.toolChoice !== undefined) {
      unsupported(
        "responseSchema",
        resolved,
        "exclusive forced structured response tool",
      );
    }
    if (!supportsStrictTools(model)) {
      unsupported("responseSchema", resolved, "strict JSON-schema tools");
    }
    const schema = cloneJson(
      params.responseSchema ?? {
        type: "object",
        additionalProperties: true,
      },
      "responseSchema",
      resolved,
    );
    if (schema.type !== "object") {
      unsupported("responseSchema", resolved, "object-root JSON schema");
    }
    tools = [
      {
        name: STRUCTURED_RESPONSE_TOOL,
        description: "Return the requested structured response.",
        parameters: schema,
        constrainedSampling: { type: "json_schema", strict: "require" },
      } satisfies Tool,
    ];
    structuredResponseTool = STRUCTURED_RESPONSE_TOOL;
  }

  const effectiveChoice =
    structuredResponseTool === undefined
      ? translateToolChoice(params, tools, resolved)
      : resolved.provider === "anthropic"
        ? ({
            type: "tool",
            name: STRUCTURED_RESPONSE_TOOL,
          } satisfies AnthropicOptions["toolChoice"])
        : ({
            type: "function",
            name: STRUCTURED_RESPONSE_TOOL,
          } satisfies OpenAIResponsesOptions["toolChoice"]);
  const translatedOptions = translateOptions(
    params,
    model,
    resolved,
    effectiveChoice,
    args.signal,
  );
  if (
    params.voiceOutput !== undefined &&
    params.voiceOutput !== "user-visible" &&
    params.voiceOutput !== "internal"
  ) {
    unsupported("voiceOutput", resolved);
  }
  if (
    params.priority !== undefined &&
    params.priority !== "interactive" &&
    params.priority !== "background"
  ) {
    unsupported("priority", resolved);
  }
  if (params.prefill !== undefined && typeof params.prefill !== "string") {
    unsupported("prefill", resolved);
  }
  if (params.grammar !== undefined && typeof params.grammar !== "string") {
    unsupported("grammar", resolved);
  }
  assertOptionalBoolean(params.streamStructured, "streamStructured", resolved);
  if (
    params.responseSkeleton !== undefined &&
    !isRecord(params.responseSkeleton)
  ) {
    unsupported("responseSkeleton", resolved);
  }
  if (
    params.spanSamplerPlan !== undefined &&
    !isRecord(params.spanSamplerPlan)
  ) {
    unsupported("spanSamplerPlan", resolved);
  }

  const hostOnly: Record<string, unknown> = {};
  for (const field of HOST_ONLY_FIELDS) {
    const value = params[field];
    if (value !== undefined) {
      hostOnly[field] = cloneJson(value, field, resolved);
    }
  }

  return Object.freeze({
    context: {
      ...context,
      messages: [...context.messages],
      ...(tools.length === 0 ? {} : { tools: [...tools] }),
    },
    options: Object.freeze({ ...translatedOptions.options }),
    nativeResult: Boolean(
      params.messages?.length ||
        params.tools?.length ||
        params.toolChoice ||
        params.responseSchema ||
        format === "json_object",
    ),
    ...(structuredResponseTool === undefined ? {} : { structuredResponseTool }),
    annotations: Object.freeze({
      hostOnly: Object.freeze(hostOnly),
      unsupportedPromptCacheHints:
        params.promptSegments?.some(
          (segment) => segment.stable || segment.ttl !== undefined,
        ) === true,
      ...(params.user === undefined ? {} : { user: params.user }),
      includeThinking: translatedOptions.includeThinking,
    }),
  });
}
