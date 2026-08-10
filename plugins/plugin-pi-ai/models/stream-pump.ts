/**
 * Owns Pi stream consumption and the pre-commit/committed terminal state
 * machine so callbacks, iterators, and companion promises settle consistently.
 */
import type {
  Api,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";
import type {
  GenerateTextParams,
  TextStreamResult,
  ToolCall,
} from "@elizaos/core";
import { mapPiError, PiTextError } from "./errors.js";
import type { ResolvedPiModelId } from "./resolve-model.js";
import {
  type NormalizedPiTextResult,
  translatePiAssistantMessage,
} from "./translate-events.js";
import type { PreparedPiTextRequest } from "./translate-input.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class TextQueue implements AsyncIterable<string> {
  readonly #values: string[] = [];
  readonly #waiters: Array<Deferred<IteratorResult<string>>> = [];
  #terminal: { error?: unknown } | undefined;
  readonly #onReturn: () => void;

  constructor(onReturn: () => void) {
    this.#onReturn = onReturn;
  }

  push(value: string): void {
    if (value.length === 0 || this.#terminal !== undefined) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter.resolve({ value, done: false });
  }

  close(error?: unknown): void {
    if (this.#terminal !== undefined) return;
    this.#terminal = error === undefined ? {} : { error };
    for (const waiter of this.#waiters.splice(0)) {
      if (error === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this.#values.length > 0) {
          return { value: this.#values.shift() as string, done: false };
        }
        if (this.#terminal !== undefined) {
          if (this.#terminal.error !== undefined) throw this.#terminal.error;
          return { value: undefined, done: true };
        }
        const waiter = deferred<IteratorResult<string>>();
        this.#waiters.push(waiter);
        return waiter.promise;
      },
      return: async (): Promise<IteratorResult<string>> => {
        this.#onReturn();
        return { value: undefined, done: true };
      },
    };
  }
}

function handled<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {
    // error-policy:J5 companion rejections are observed by the stream surfaces;
    // this handler prevents an unused promise from becoming unhandled.
  });
  return promise;
}

export interface PiStreamTerminal {
  readonly result?: NormalizedPiTextResult;
  readonly error?: PiTextError;
  readonly partialText: string;
}

export interface PiStreamAttempt {
  readonly ready: Promise<void>;
  readonly terminal: Promise<PiStreamTerminal>;
  readonly pump: Promise<void>;
  readonly result: TextStreamResult;
}

type StreamPartKind = "text" | "thinking" | "toolcall";

function streamProtocolError(message: string): PiTextError {
  return new PiTextError(message, { code: "PI_STREAM_TERMINATED" });
}

function validContentIndex(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function validPartialEnvelope(
  value: unknown,
  model: Model<Api>,
  resolved: ResolvedPiModelId,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const partial = value as Record<string, unknown>;
  return (
    partial.role === "assistant" &&
    partial.api === model.api &&
    partial.provider === resolved.provider &&
    partial.model === model.id &&
    Array.isArray(partial.content)
  );
}

export function createPiStreamAttempt(args: {
  stream: AssistantMessageEventStream;
  model: Model<Api>;
  resolved: ResolvedPiModelId;
  prepared: PreparedPiTextRequest;
  params: GenerateTextParams;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  readonly disposed: () => boolean;
}): PiStreamAttempt {
  const ready = deferred<void>();
  const text = deferred<string>();
  const usage = deferred<NormalizedPiTextResult["usage"] | undefined>();
  const finishReason = deferred<string | undefined>();
  const toolCalls = deferred<readonly ToolCall[]>();
  const terminal = deferred<PiStreamTerminal>();
  let committed = false;
  let settled = false;
  let readySettled = false;
  let visibleText = "";
  let started = false;
  let abortForCallbackFailure = false;
  const openParts = new Map<number, StreamPartKind>();
  const iterator = args.stream[Symbol.asyncIterator]();
  const pumpAbort = deferred<void>();
  let abortListenerAttached = false;
  let iteratorReturn: Promise<void> | undefined;

  const detachAbortListener = (): void => {
    if (!abortListenerAttached) return;
    args.signal.removeEventListener("abort", onAbort);
    abortListenerAttached = false;
  };

  const queue = new TextQueue(() => {
    if (!settled)
      args.controller.abort(new Error("Pi text stream consumer stopped"));
  });
  const providerMetadata = {
    gateway: "pi",
    provider: args.resolved.provider,
    modelName: args.model.id,
    qualifiedModel: args.resolved.qualifiedModel,
  };

  const awaitPumpWork = async <T>(work: Promise<T>): Promise<T> => {
    const outcome = await Promise.race([
      work.then((value) => ({ type: "value" as const, value })),
      pumpAbort.promise.then(() => ({ type: "aborted" as const })),
    ]);
    if (outcome.type === "aborted") {
      throw args.signal.reason ?? new Error("Pi stream pump aborted");
    }
    return outcome.value;
  };

  const publishVisibleDelta = async (delta: string): Promise<void> => {
    if (delta.length === 0) return;
    if (!committed) {
      committed = true;
      readySettled = true;
      ready.resolve();
    }
    visibleText += delta;
    queue.push(delta);
    try {
      if (args.params.onStreamChunk !== undefined) {
        await awaitPumpWork(
          Promise.resolve().then(() => args.params.onStreamChunk?.(delta)),
        );
      }
    } catch (error) {
      abortForCallbackFailure = true;
      throw new PiTextError("Pi stream callback failed", {
        code: "PI_STREAM_TERMINATED",
        cause: error,
        context: {
          provider: args.resolved.provider,
          qualifiedModel: args.resolved.qualifiedModel,
          committed: true,
        },
      });
    }
  };

  const fail = (error: unknown): void => {
    if (settled) return;
    settled = true;
    detachAbortListener();
    const mapped = mapPiError(error, {
      provider: args.resolved.provider,
      qualifiedModel: args.resolved.qualifiedModel,
      committed,
      signal: args.signal,
      disposed: args.disposed(),
    });
    if (!readySettled) {
      readySettled = true;
      ready.reject(mapped);
    }
    queue.close(mapped);
    text.reject(mapped);
    usage.reject(mapped);
    finishReason.reject(mapped);
    toolCalls.reject(mapped);
    terminal.resolve({ error: mapped, partialText: visibleText });
  };

  const succeed = (normalized: NormalizedPiTextResult): void => {
    if (settled) return;
    settled = true;
    detachAbortListener();
    Object.assign(providerMetadata, normalized.providerMetadata);
    if (!readySettled) {
      readySettled = true;
      ready.resolve();
    }
    queue.close();
    text.resolve(normalized.text);
    usage.resolve(normalized.usage);
    finishReason.resolve(normalized.finishReason);
    toolCalls.resolve(normalized.toolCalls);
    terminal.resolve({ result: normalized, partialText: visibleText });
  };

  const requestIteratorReturn = (): Promise<void> => {
    if (iteratorReturn !== undefined) return iteratorReturn;
    if (iterator.return === undefined) {
      iteratorReturn = Promise.resolve();
      return iteratorReturn;
    }
    iteratorReturn = Promise.resolve()
      .then(() => iterator.return?.())
      .then(() => undefined);
    return iteratorReturn;
  };
  const onAbort = (): void => {
    fail(args.signal.reason);
    pumpAbort.resolve();
    void handled(requestIteratorReturn());
  };
  if (args.signal.aborted) onAbort();
  else {
    args.signal.addEventListener("abort", onAbort, { once: true });
    abortListenerAttached = true;
  }

  const pump = (async () => {
    try {
      while (!settled) {
        const iteration = await awaitPumpWork(
          Promise.resolve().then(() => iterator.next()),
        );
        if (settled || iteration.done) break;
        const event = iteration.value;
        if (typeof event !== "object" || event === null) {
          throw streamProtocolError("Pi stream emitted a malformed event");
        }
        if (
          event.type !== "done" &&
          event.type !== "error" &&
          !validPartialEnvelope(event.partial, args.model, args.resolved)
        ) {
          throw streamProtocolError(
            "Pi stream emitted a malformed partial envelope",
          );
        }
        if (event.type === "start") {
          if (started)
            throw streamProtocolError(
              "Pi stream emitted duplicate start events",
            );
          started = true;
          continue;
        }
        if (event.type === "error") {
          if (
            typeof event.error !== "object" ||
            event.error === null ||
            event.error.stopReason !== event.reason ||
            typeof event.error.errorMessage !== "string" ||
            event.error.errorMessage.trim().length === 0
          ) {
            throw streamProtocolError(
              "Pi stream emitted a malformed terminal error",
            );
          }
          throw new Error(event.error.errorMessage);
        }
        if (!started) {
          throw streamProtocolError("Pi stream emitted content before start");
        }

        if (
          event.type === "text_start" ||
          event.type === "thinking_start" ||
          event.type === "toolcall_start"
        ) {
          if (
            !validContentIndex(event.contentIndex) ||
            openParts.has(event.contentIndex)
          ) {
            throw streamProtocolError(
              "Pi stream emitted an invalid content start",
            );
          }
          openParts.set(
            event.contentIndex,
            event.type === "text_start"
              ? "text"
              : event.type === "thinking_start"
                ? "thinking"
                : "toolcall",
          );
          continue;
        }

        if (
          event.type === "text_delta" ||
          event.type === "thinking_delta" ||
          event.type === "toolcall_delta"
        ) {
          const expected: StreamPartKind =
            event.type === "text_delta"
              ? "text"
              : event.type === "thinking_delta"
                ? "thinking"
                : "toolcall";
          if (
            !validContentIndex(event.contentIndex) ||
            openParts.get(event.contentIndex) !== expected ||
            typeof event.delta !== "string"
          ) {
            throw streamProtocolError(
              "Pi stream emitted an invalid content delta",
            );
          }
          if (
            event.type === "text_delta" &&
            args.params.stream === true &&
            args.prepared.structuredResponseTool === undefined
          ) {
            await publishVisibleDelta(event.delta);
          }
          continue;
        }

        if (
          event.type === "text_end" ||
          event.type === "thinking_end" ||
          event.type === "toolcall_end"
        ) {
          const expected: StreamPartKind =
            event.type === "text_end"
              ? "text"
              : event.type === "thinking_end"
                ? "thinking"
                : "toolcall";
          if (
            !validContentIndex(event.contentIndex) ||
            openParts.get(event.contentIndex) !== expected ||
            (event.type !== "toolcall_end" &&
              typeof event.content !== "string") ||
            (event.type === "toolcall_end" &&
              (typeof event.toolCall !== "object" || event.toolCall === null))
          ) {
            throw streamProtocolError(
              "Pi stream emitted an invalid content end",
            );
          }
          openParts.delete(event.contentIndex);
          continue;
        }

        if (event.type === "done") {
          if (openParts.size > 0 || event.message.stopReason !== event.reason) {
            throw streamProtocolError(
              "Pi stream emitted a malformed terminal result",
            );
          }
          const normalized = translatePiAssistantMessage({
            message: event.message,
            model: args.model,
            resolved: args.resolved,
            structuredResponseTool: args.prepared.structuredResponseTool,
            declaredToolNames: new Set(
              args.prepared.context.tools?.map((tool) => tool.name) ?? [],
            ),
            includeThinking: args.prepared.annotations.includeThinking,
          });
          if (
            args.params.stream === true &&
            args.prepared.structuredResponseTool === undefined &&
            normalized.text !== visibleText
          ) {
            throw new PiTextError(
              "Pi terminal text did not match streamed deltas",
              {
                code: "PI_STREAM_TERMINATED",
                context: {
                  provider: args.resolved.provider,
                  qualifiedModel: args.resolved.qualifiedModel,
                  committed,
                },
              },
            );
          }
          if (
            args.params.stream === true &&
            args.prepared.structuredResponseTool !== undefined
          ) {
            await publishVisibleDelta(normalized.text);
          }
          succeed(normalized);
          void handled(requestIteratorReturn());
          return;
        }
        throw streamProtocolError("Pi stream emitted an unknown event type");
      }
      if (!settled) throw new Error("Pi stream ended without a terminal event");
    } catch (error) {
      fail(error);
      if (abortForCallbackFailure && !args.controller.signal.aborted) {
        args.controller.abort(error);
      }
      void handled(requestIteratorReturn());
    } finally {
      detachAbortListener();
    }
  })();

  return {
    ready: handled(ready.promise),
    terminal: handled(terminal.promise),
    pump: handled(pump),
    result: {
      textStream: queue,
      text: handled(text.promise),
      usage: handled(usage.promise),
      finishReason: handled(finishReason.promise),
      toolCalls: handled(toolCalls.promise),
      providerMetadata,
    },
  };
}
