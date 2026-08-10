/**
 * Executes one slot-parameterized Pi text call with canonical model resolution,
 * lifecycle cancellation, trajectories, terminal translation, and telemetry.
 */
import type {
  Api,
  CredentialStore,
  Model,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import {
  assertActiveTrajectoryForLlmCall,
  buildCanonicalSystemPrompt,
  type GenerateTextParams,
  type IAgentRuntime,
  type RecordLlmCallDetails,
  recordLlmCall,
  type TextGenerationModelType,
  type TextStreamResult,
} from "@elizaos/core";
import type { PiCatalogSource } from "../catalog/index.js";
import { emitPiModelUsed } from "../observability/events.js";
import type { PiGatewayProvider } from "../providers/manifest.js";
import { cancelledPiError, mapPiError, PiTextError } from "./errors.js";
import {
  type ResolvedPiModelId,
  resolveQualifiedPiModel,
} from "./resolve-model.js";
import { createPiStreamAttempt, type PiStreamAttempt } from "./stream-pump.js";
import type { NormalizedPiTextResult } from "./translate-events.js";
import { translateGenerateTextCall } from "./translate-input.js";

export interface PiTextRuntimeState {
  routeSnapshot: Readonly<Record<string, string>>;
  readonly credentials: CredentialStore;
  readonly models: MutableModels;
  readonly providers: readonly Provider[];
  readonly providerManifest: readonly PiGatewayProvider[];
  readonly catalogSource: PiCatalogSource;
  readonly activeCalls: Set<AbortController>;
  readonly activePumps: Set<Promise<void>>;
  disposed: boolean;
}

interface NativePiTextResult {
  text: string;
  toolCalls: readonly import("@elizaos/core").ToolCall[];
  usage: import("@elizaos/core").TokenUsage;
  finishReason: string;
  providerMetadata: Record<string, unknown>;
}

type NativePiModelResult = string & NativePiTextResult;

function unknownModel(
  state: PiTextRuntimeState,
  resolved: ResolvedPiModelId,
): Model<Api> | undefined {
  const provider = state.models.getProvider(resolved.provider);
  const template = provider
    ?.getModels()
    .find(
      (candidate) =>
        candidate.api ===
        (resolved.provider === "openai"
          ? "openai-responses"
          : "anthropic-messages"),
    );
  if (template === undefined) return undefined;
  return {
    ...template,
    id: resolved.modelId,
    name: resolved.modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    samplingParams: undefined,
    compat: undefined,
  };
}

function resolveModel(
  state: PiTextRuntimeState,
  resolved: ResolvedPiModelId,
): Model<Api> {
  const model =
    state.models.getModel(resolved.provider, resolved.modelId) ??
    (resolved.unknownModel ? unknownModel(state, resolved) : undefined);
  if (model === undefined || model.provider !== resolved.provider) {
    throw new PiTextError(
      "Resolved Pi model is unavailable from its provider",
      {
        code: "PI_INVALID_MODEL_ID",
        context: {
          provider: resolved.provider,
          qualifiedModel: resolved.qualifiedModel,
        },
      },
    );
  }
  if (
    resolved.catalogEntry !== undefined &&
    (model.api !== resolved.catalogEntry.api ||
      !resolved.catalogEntry.input.every((input) =>
        model.input.includes(input),
      ))
  ) {
    throw new PiTextError(
      "Pi runtime model metadata disagrees with the curated catalog",
      {
        code: "PI_INVALID_MODEL_ID",
        context: {
          provider: resolved.provider,
          qualifiedModel: resolved.qualifiedModel,
          catalogApi: resolved.catalogEntry.api,
          runtimeApi: model.api,
        },
      },
    );
  }
  return model;
}

const SENSITIVE_TRAJECTORY_KEY =
  /(?:api[-_]?key|authorization|bearer|cookie|credential|password|secret|token)$/i;

function trajectorySafeValue(
  value: unknown,
  key?: string,
  seen = new Set<object>(),
): unknown {
  if (key !== undefined && SENSITIVE_TRAJECTORY_KEY.test(key)) {
    return "[REDACTED]";
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) return "[REDACTED_BINARY]";
  if (Array.isArray(value)) {
    return value.map((item) => trajectorySafeValue(item, undefined, seen));
  }
  if (typeof value !== "object" || seen.has(value)) return "[REDACTED]";
  seen.add(value);
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (record.type === "image" && entryKey === "data") {
      output[entryKey] = "[REDACTED_BINARY]";
    } else if (record.type === "thinking" && entryKey === "thinking") {
      output[entryKey] = "[REDACTED_THINKING]";
    } else {
      output[entryKey] = trajectorySafeValue(entryValue, entryKey, seen);
    }
  }
  seen.delete(value);
  return output;
}

function trajectoryDetails(args: {
  slot: TextGenerationModelType;
  resolved: ResolvedPiModelId;
  prepared: ReturnType<typeof translateGenerateTextCall>;
}): RecordLlmCallDetails {
  const firstUser = args.prepared.context.messages.find(
    (message) => message.role === "user",
  );
  const userPrompt =
    firstUser?.role === "user"
      ? typeof firstUser.content === "string"
        ? firstUser.content
        : firstUser.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("")
      : "";
  const {
    signal: _signal,
    metadata: _metadata,
    ...providerOptions
  } = args.prepared.options;
  return {
    model: args.resolved.qualifiedModel,
    modelType: args.slot,
    provider: "pi",
    systemPrompt: args.prepared.context.systemPrompt ?? "",
    userPrompt,
    messages: trajectorySafeValue(args.prepared.context.messages) as unknown[],
    tools: trajectorySafeValue(args.prepared.context.tools),
    toolChoice: (providerOptions as Record<string, unknown>).toolChoice,
    responseSchema:
      args.prepared.structuredResponseTool === undefined
        ? undefined
        : args.prepared.context.tools?.[0]?.parameters,
    providerOptions: trajectorySafeValue({
      pi: providerOptions,
      annotations: args.prepared.annotations,
      upstreamProvider: args.resolved.provider,
    }),
    temperature: args.prepared.options.temperature,
    maxTokens: args.prepared.options.maxTokens,
    maxTokensOmitted: args.prepared.options.maxTokens === undefined,
    purpose: "external_llm",
    actionType: "pi.generateText",
  };
}

function applyResultToTrajectory(
  details: RecordLlmCallDetails,
  result: NormalizedPiTextResult,
): void {
  details.response = result.text;
  details.toolCalls = [...result.toolCalls];
  details.finishReason = result.finishReason;
  const { thinking: _thinking, ...trajectoryMetadata } =
    result.providerMetadata;
  details.providerMetadata = trajectoryMetadata;
  details.promptTokens = result.usage.promptTokens;
  details.completionTokens = result.usage.completionTokens;
  details.cacheReadInputTokens = result.usage.cacheReadInputTokens;
  details.cacheCreationInputTokens = result.usage.cacheCreationInputTokens;
  details.reasoningTokens = result.usage.reasoningTokens;
}

function applyFailureToTrajectory(
  details: RecordLlmCallDetails,
  error: PiTextError,
  resolved: ResolvedPiModelId,
  partialText = "",
): void {
  details.response = partialText;
  details.finishReason = "error";
  details.providerMetadata = {
    gateway: "pi",
    provider: resolved.provider,
    qualifiedModel: resolved.qualifiedModel,
    failed: true,
    errorCode: error.code,
    ...(typeof error.context?.committed === "boolean"
      ? { committed: error.context.committed }
      : {}),
  };
}

function nativeResult(result: NormalizedPiTextResult): NativePiModelResult {
  return {
    text: result.text,
    toolCalls: result.toolCalls,
    usage: result.usage,
    finishReason: result.finishReason,
    providerMetadata: result.providerMetadata,
    // Core's plugin handler map still declares text results as `string`; mature
    // adapters return this object shape for native message/tool calls.
  } as unknown as NativePiModelResult;
}

async function requireCredential(
  state: PiTextRuntimeState,
  resolved: ResolvedPiModelId,
  signal: AbortSignal,
): Promise<void> {
  const credential = await state.credentials.read(resolved.provider, {
    signal,
  });
  if (credential === undefined) {
    throw new PiTextError("Pi upstream provider credential is missing", {
      code: "PI_CREDENTIAL_MISSING",
      context: {
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
      },
    });
  }
}

export async function handlePiText(
  runtime: IAgentRuntime,
  state: PiTextRuntimeState,
  slot: TextGenerationModelType,
  params: GenerateTextParams,
): Promise<string | TextStreamResult> {
  if (state.disposed) throw cancelledPiError({ disposed: true });
  const resolved = resolveQualifiedPiModel({
    slot,
    params,
    routeSnapshot: state.routeSnapshot,
    catalogSource: state.catalogSource,
    providerManifest: state.providerManifest,
  });
  const model = resolveModel(state, resolved);
  const controller = new AbortController();
  const callerSignal =
    params.signal instanceof AbortSignal ? params.signal : undefined;
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const prepared = translateGenerateTextCall({
    slot,
    params,
    model,
    resolved,
    signal,
    systemPromptFallback: buildCanonicalSystemPrompt({
      character: runtime.character,
    }),
  });
  const details = trajectoryDetails({ slot, resolved, prepared });
  assertActiveTrajectoryForLlmCall({
    actionType: details.actionType,
    model: details.model,
    purpose: details.purpose,
  });
  state.activeCalls.add(controller);

  let resolveAttempt!: (attempt: PiStreamAttempt) => void;
  let rejectAttempt!: (error: unknown) => void;
  const attemptStarted = new Promise<PiStreamAttempt>((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });
  attemptStarted.catch(() => {
    // error-policy:J5 the caller awaits the same startup rejection below.
  });

  const recording = recordLlmCall(runtime, details, async () => {
    try {
      await requireCredential(state, resolved, signal);
      if (state.disposed) {
        throw cancelledPiError({ disposed: true, ...resolved });
      }
      const stream = state.models.stream(
        model,
        prepared.context,
        prepared.options,
      );
      const attempt = createPiStreamAttempt({
        stream,
        model,
        resolved,
        prepared,
        params,
        controller,
        signal,
        disposed: () => state.disposed,
      });
      state.activePumps.add(attempt.pump);
      void attempt.pump.then(
        () => state.activePumps.delete(attempt.pump),
        () => state.activePumps.delete(attempt.pump),
      );
      resolveAttempt(attempt);
      const terminal = await attempt.terminal;
      if (terminal.result !== undefined) {
        applyResultToTrajectory(details, terminal.result);
        emitPiModelUsed({ runtime, slot, result: terminal.result });
        return terminal.result;
      }
      const error =
        terminal.error ??
        new PiTextError("Pi stream ended without a terminal result", {
          code: "PI_STREAM_TERMINATED",
        });
      applyFailureToTrajectory(details, error, resolved, terminal.partialText);
      return { text: terminal.partialText };
    } catch (error) {
      const mapped = mapPiError(error, {
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
        committed: false,
        signal,
        disposed: state.disposed,
      });
      applyFailureToTrajectory(details, mapped, resolved);
      rejectAttempt(mapped);
      return undefined;
    }
  });
  void recording.catch((error) => rejectAttempt(error));

  const cleanup = recording.then(
    () => {
      state.activeCalls.delete(controller);
    },
    (error) => {
      state.activeCalls.delete(controller);
      // error-policy:J7 trajectory diagnostics cannot replace a model result.
      runtime.reportError("Pi.trajectory", error, {
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
      });
    },
  );
  let attempt: PiStreamAttempt;
  try {
    attempt = await attemptStarted;
    await attempt.ready;
  } catch (error) {
    await cleanup;
    throw error;
  }

  if (params.stream === true) return attempt.result;

  const terminal = await attempt.terminal;
  await cleanup;
  if (terminal.error !== undefined) throw terminal.error;
  if (terminal.result === undefined) {
    throw new PiTextError("Pi returned no completion", {
      code: "PI_EMPTY_RESULT",
      context: {
        provider: resolved.provider,
        qualifiedModel: resolved.qualifiedModel,
      },
    });
  }
  return prepared.nativeResult
    ? nativeResult(terminal.result)
    : terminal.result.text;
}
