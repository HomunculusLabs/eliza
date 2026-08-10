/**
 * Emits terminal Pi usage with deliberate gateway/upstream attribution and no
 * prompt, secret, attachment, or thinking content.
 */
import {
  EventType,
  type IAgentRuntime,
  type ModelEventPayload,
  type TextGenerationModelType,
} from "@elizaos/core";
import type { NormalizedPiTextResult } from "../models/translate-events.js";

interface PiModelUsedPayload extends ModelEventPayload {
  source: "pi";
  provider: "pi";
  upstreamProvider: string;
  qualifiedModel: string;
  finishReason: string;
  cost?: { usd: number };
}

export function emitPiModelUsed(args: {
  runtime: IAgentRuntime;
  slot: TextGenerationModelType;
  result: NormalizedPiTextResult;
}): void {
  const metadata = args.result.providerMetadata;
  const payload: PiModelUsedPayload = {
    runtime: args.runtime,
    source: "pi",
    provider: "pi",
    upstreamProvider: metadata.provider,
    type: args.slot,
    model: metadata.modelName,
    modelName: metadata.modelName,
    modelLabel: String(args.slot),
    qualifiedModel: metadata.qualifiedModel,
    finishReason: args.result.finishReason,
    ...(args.result.costUsd === undefined
      ? {}
      : { costUsd: args.result.costUsd, cost: { usd: args.result.costUsd } }),
    tokens: {
      prompt: args.result.usage.promptTokens,
      completion: args.result.usage.completionTokens,
      total: args.result.usage.totalTokens,
      ...(args.result.usage.cacheReadInputTokens === undefined
        ? {}
        : {
            cached: args.result.usage.cacheReadInputTokens,
            cachedInputTokens: args.result.usage.cacheReadInputTokens,
            cacheReadInputTokens: args.result.usage.cacheReadInputTokens,
          }),
      ...(args.result.usage.cacheCreationInputTokens === undefined
        ? {}
        : {
            cacheCreationInputTokens:
              args.result.usage.cacheCreationInputTokens,
          }),
      ...(args.result.usage.reasoningTokens === undefined
        ? {}
        : { reasoningTokens: args.result.usage.reasoningTokens }),
    },
  };

  try {
    void args.runtime
      .emitEvent(EventType.MODEL_USED, payload)
      .catch((error) => {
        // error-policy:J7 usage telemetry must not kill a completed model call.
        args.runtime.reportError("Pi.MODEL_USED", error, {
          upstreamProvider: metadata.provider,
          qualifiedModel: metadata.qualifiedModel,
        });
      });
  } catch (error) {
    // error-policy:J7 usage telemetry must not kill a completed model call.
    args.runtime.reportError("Pi.MODEL_USED", error, {
      upstreamProvider: metadata.provider,
      qualifiedModel: metadata.qualifiedModel,
    });
  }
}
