/**
 * Plays prepared voice audio through the shared Web Audio graph.
 * Provider fetchers own authentication and caching; this module owns the one
 * analyser, playback-reference tap, timeout, teardown, and telemetry lifecycle
 * that every decoded-audio provider must follow.
 */

import { ttsDebug, ttsDebugTextPreview } from "../utils/tts-debug";
import {
  type PlaybackFramePump,
  type PlaybackFrameTap,
  PlaybackTapLifecycle,
} from "./playback-frame-pump";
import type { SpeakTask, VoicePlaybackStartEvent } from "./voice-chat-types";

interface MutableCell<T> {
  current: T;
}

export interface VoicePlaybackWatchdogTiming {
  /** Minimum initial wall-clock watchdog delay; covers short/zero-duration buffers. */
  floorMs?: number;
  /** Wall-clock grace over nominal duration before the watchdog retires a still-running segment whose `ended` never arrived. */
  graceMs?: number;
  /** Poll interval once the nominal watchdog deadline has passed. */
  pollMs?: number;
  /** Hard wall-clock budget past the nominal deadline before a stalled segment settles as an error. */
  suspensionDeadlineMs?: number;
}

export interface DecodedVoicePlaybackOptions {
  context: AudioContext;
  audioBuffer: AudioBuffer;
  generation: number;
  generationRef: MutableCell<number>;
  provider: VoicePlaybackStartEvent["provider"];
  text: string;
  task: SpeakTask;
  cached: boolean;
  analyserRef: MutableCell<AnalyserNode | null>;
  timeDomainDataRef: MutableCell<Float32Array<ArrayBuffer> | null>;
  audioSourceRef: MutableCell<AudioBufferSourceNode | null>;
  playbackFrameTapRef: MutableCell<PlaybackFrameTap | null>;
  activeTaskFinishRef: MutableCell<(() => void) | null>;
  speechTimeoutRef: MutableCell<ReturnType<typeof setTimeout> | null>;
  getPlaybackFramePump: () => PlaybackFramePump;
  clearSpeechTimers: () => void;
  emitPlaybackStart: (event: VoicePlaybackStartEvent) => void;
  tracePlayback?: boolean;
  /** Injectable watchdog timing so tests can exercise the suspension contract deterministically. */
  watchdogTiming?: VoicePlaybackWatchdogTiming;
}

export async function playDecodedVoiceAudio({
  context,
  audioBuffer,
  generation,
  generationRef,
  provider,
  text,
  task,
  cached,
  analyserRef,
  timeDomainDataRef,
  audioSourceRef,
  playbackFrameTapRef,
  activeTaskFinishRef,
  speechTimeoutRef,
  getPlaybackFramePump,
  clearSpeechTimers,
  emitPlaybackStart,
  tracePlayback = false,
  watchdogTiming,
}: DecodedVoicePlaybackOptions): Promise<void> {
  if (generation !== generationRef.current) return;

  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;
  analyserRef.current = analyser;
  timeDomainDataRef.current = new Float32Array(
    new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT),
  );

  const source = context.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(context.destination);
  audioSourceRef.current = source;

  // Audible playback must not wait indefinitely for the optional visualizer
  // worklet on first use in a busy WebView.
  const tapPromise = getPlaybackFramePump()
    .tapSource(context, source, audioBuffer)
    .catch((error) => {
      // error-policy:J4 Playback-reference capture is optional; audio remains audible.
      ttsDebug("playback-reference:tap-attach-failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const tapLifecycle = new PlaybackTapLifecycle(playbackFrameTapRef);
  await tapLifecycle.attach(tapPromise);
  if (generation !== generationRef.current) {
    tapLifecycle.finish();
    source.disconnect();
    analyser.disconnect();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let watchdogPoll: ReturnType<typeof setTimeout> | null = null;
    const playStartMs = performance.now();
    let wrappedFinish: ((failure?: unknown) => void) | null = null;

    const finish = (failure?: unknown) => {
      if (finished) return;
      finished = true;
      if (watchdogPoll !== null) {
        clearTimeout(watchdogPoll);
        watchdogPoll = null;
      }
      tapLifecycle.finish();
      if (wrappedFinish && activeTaskFinishRef.current === wrappedFinish) {
        activeTaskFinishRef.current = null;
      }
      if (audioSourceRef.current === source) {
        audioSourceRef.current = null;
      }
      source.onended = null;
      try {
        source.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:source-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        analyser.disconnect();
      } catch (error) {
        // error-policy:J6 best-effort Web Audio teardown after playback ended.
        ttsDebug("play:web-audio:analyser-disconnect-failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      clearSpeechTimers();
      if (failure !== undefined) reject(failure);
      else resolve();
    };

    wrappedFinish = (failure?: unknown) => {
      if (tracePlayback) {
        ttsDebug("play:web-audio:end", {
          provider,
          segment: task.segment,
          elapsedMs: Math.round(performance.now() - playStartMs),
          ...(failure !== undefined
            ? {
                watchdogError:
                  failure instanceof Error ? failure.message : String(failure),
              }
            : {}),
        });
      }
      finish(failure);
    };

    if (tracePlayback) {
      ttsDebug("play:web-audio:start", {
        provider,
        segment: task.segment,
        append: task.append,
        cached,
        textChars: text.length,
        preview: ttsDebugTextPreview(text),
        durationSecApprox: Math.round(audioBuffer.duration * 100) / 100,
      });
    }

    activeTaskFinishRef.current = wrappedFinish;
    // `onended` dispatches with an Event argument; call through explicitly so
    // the argument is never mistaken for a watchdog failure payload.
    source.onended = () => wrappedFinish?.();
    tapLifecycle.start(playStartMs);

    // Wall-clock watchdog. If the nominal deadline passes with no `ended`
    // event, do NOT retire the segment as successful on wall time alone: a
    // suspended/interrupted AudioContext freezes the audio clock (and with it
    // the source's `ended` event) while wall time keeps running. Poll the
    // context state and the audio-clock progress (#31027):
    // - context `closed` → settle as a typed error (truthful failure, no
    //   fabricated success);
    // - context suspended/interrupted → the buffered source is paused, not
    //   lost; keep waiting for resume + natural `ended` (the same source node
    //   resumes without replaying delivered PCM) until the hard suspension
    //   deadline, then settle as a typed error;
    // - context running → legacy safety net for a lost `ended` dispatch:
    //   retire the segment as successful once the audio clock has had the
    //   grace to pass nominal end-of-buffer.
    const floorMs = watchdogTiming?.floorMs ?? 2500;
    const graceMs = watchdogTiming?.graceMs ?? 1200;
    const pollMs = watchdogTiming?.pollMs ?? 100;
    const suspensionDeadlineMs = watchdogTiming?.suspensionDeadlineMs ?? 30_000;
    const nominalMs = Math.max(
      floorMs,
      Math.ceil(audioBuffer.duration * 1000) + graceMs,
    );
    const settleDeadlineMs = nominalMs + suspensionDeadlineMs;
    // Audio-clock reading at schedule time; the watchdog computes progress as
    // `context.currentTime - sourceStartClock` so a suspended context (frozen
    // audio clock) reads as zero progress rather than wall-clock elapsed.
    const sourceStartClock = context.currentTime;
    const pollWatchdog = () => {
      if (finished) return;
      watchdogPoll = null;
      if (context.state === "closed") {
        wrappedFinish?.(
          new Error(
            `Audio playback context closed before the segment finished (state=${context.state})`,
          ),
        );
        return;
      }
      const audioElapsedMs = (context.currentTime - sourceStartClock) * 1000;
      if (context.state === "running") {
        if (audioElapsedMs >= nominalMs - graceMs) {
          wrappedFinish?.();
        } else {
          watchdogPoll = setTimeout(pollWatchdog, pollMs);
        }
        return;
      }
      // suspended / interrupted — keep the graph intact so resume delivers
      // the remaining buffered PCM, bounded by the hard deadline.
      if (performance.now() - playStartMs >= settleDeadlineMs) {
        wrappedFinish?.(
          new Error(
            `Audio playback remained ${context.state} for ${suspensionDeadlineMs}ms past the nominal ${nominalMs}ms watchdog deadline; giving up rather than reporting unfinished audio as completed`,
          ),
        );
        return;
      }
      watchdogPoll = setTimeout(pollWatchdog, pollMs);
    };
    speechTimeoutRef.current = setTimeout(pollWatchdog, nominalMs);

    source.start(0);
    emitPlaybackStart({
      text,
      segment: task.segment,
      provider,
      cached,
      startedAtMs: playStartMs,
      ...task.telemetry,
    });
  });
}
