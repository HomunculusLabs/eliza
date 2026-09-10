/**
 * Boundary regressions for `playDecodedVoiceAudio`'s wall-clock watchdog
 * (#31027). Deterministic jsdom harness: a fake Web Audio environment
 * (AudioContext state + audio clock under test control, fake timers) drives
 * the REAL helper end to end — no provider, network, or worklet involvement.
 *
 * The contract under test: a mid-playback AudioContext suspension must not
 * let the wall-clock watchdog retire the segment as a successful completion;
 * playback must wait (graph intact) for resume + natural `ended`, and a
 * context that never resumes settles as a typed error instead of fabricated
 * success. The legacy running-context lost-`ended` safety net is pinned too.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DecodedVoicePlaybackOptions,
  playDecodedVoiceAudio,
} from "./voice-chat-audio-playback";
import type { SpeakTask, VoicePlaybackStartEvent } from "./voice-chat-types";

class FakeAudioBuffer {
  readonly sampleRate = 48_000;
  readonly numberOfChannels = 1;
  constructor(readonly duration: number) {}
  get length(): number {
    return Math.ceil(this.duration * this.sampleRate);
  }
  getChannelData(): Float32Array {
    return new Float32Array(this.length);
  }
}

class FakeAudioNode {
  disconnectSpied = false;
  connect(): FakeAudioNode {
    return this;
  }
  disconnect(): void {
    this.disconnectSpied = true;
  }
}

class FakeAnalyser extends FakeAudioNode {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
}

class FakeBufferSource extends FakeAudioNode {
  startedAt = -1;
  stopped = false;
  onended: ((ev: Event) => unknown) | null = null;
  constructor(private readonly owner: FakeAudioContext) {
    super();
  }
  start(offset: number): void {
    this.startedAt = offset;
    this.owner.sources.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  currentTime = 0;
  readonly destination = new FakeAudioNode();
  readonly sources: FakeBufferSource[] = [];
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser();
  }
  createBufferSource(): FakeBufferSource {
    return new FakeBufferSource(this);
  }
  /** Test hook: advances the audio clock only while the context is running. */
  advanceClock(ms: number): void {
    if (this.state === "running") this.currentTime += ms / 1000;
  }
}

function makeTask(): SpeakTask {
  return { text: "hello world", append: false, segment: "full" };
}

const nullTapPump = {
  tapSource: () => Promise.resolve(null),
} as unknown as ReturnType<DecodedVoicePlaybackOptions["getPlaybackFramePump"]>;

function makeOptions(
  context: FakeAudioContext,
  overrides: Partial<DecodedVoicePlaybackOptions> = {},
): DecodedVoicePlaybackOptions {
  return {
    context: context as unknown as AudioContext,
    audioBuffer: new FakeAudioBuffer(2) as unknown as AudioBuffer,
    generation: 1,
    generationRef: { current: 1 },
    provider: "eliza-cloud",
    text: "hello world",
    task: makeTask(),
    cached: false,
    analyserRef: { current: null },
    timeDomainDataRef: { current: null },
    audioSourceRef: { current: null },
    playbackFrameTapRef: { current: null },
    activeTaskFinishRef: { current: null },
    speechTimeoutRef: { current: null },
    getPlaybackFramePump: () => nullTapPump,
    clearSpeechTimers: () => {},
    emitPlaybackStart: (_event: VoicePlaybackStartEvent) => {},
    tracePlayback: false,
    ...overrides,
  };
}

/** Fast timing: 2s buffer → nominal = max(500, 2000+300) = 2300ms wall. */
const FAST: DecodedVoicePlaybackOptions["watchdogTiming"] = {
  pollMs: 25,
  graceMs: 300,
  floorMs: 500,
  suspensionDeadlineMs: 1500,
};

function endSource(context: FakeAudioContext): void {
  const source = context.sources[0];
  source.onended?.({} as Event);
}

describe("playDecodedVoiceAudio watchdog suspension contract (#31027)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves successfully on natural end while running (control)", async () => {
    const context = new FakeAudioContext();
    let settled: "resolved" | "rejected" | "pending" = "pending";
    const playback = playDecodedVoiceAudio(
      makeOptions(context, { watchdogTiming: FAST }),
    ).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    // Simulate 2s of running playback advancing the audio clock.
    for (let i = 0; i < 80; i += 1) {
      context.advanceClock(25);
      await vi.advanceTimersByTimeAsync(25);
    }
    endSource(context);
    await playback;
    expect(settled).toBe("resolved");
  });

  it("waits through a mid-playback suspension and resolves after resume + natural end (no duplicate playback)", async () => {
    const context = new FakeAudioContext();
    const started = vi.fn();
    const playback = playDecodedVoiceAudio(
      makeOptions(context, {
        watchdogTiming: FAST,
        emitPlaybackStart: () => started(),
      }),
    );
    // Track early settlement: the OLD watchdog resolved the promise here as a
    // FALSE success while the audio clock was still suspended.
    let settledEarly = false;
    void playback.then(
      () => {
        settledEarly = true;
      },
      () => {
        settledEarly = true;
      },
    );
    // 200ms of playback, then suspend.
    for (let i = 0; i < 8; i += 1) {
      context.advanceClock(25);
      await vi.advanceTimersByTimeAsync(25);
    }
    context.state = "suspended";
    // Past the nominal wall deadline (2300ms) but before the hard suspension
    // deadline (3800ms) — the OLD watchdog retired the segment here as a
    // false success; the new one must keep waiting with the graph intact.
    await vi.advanceTimersByTimeAsync(3000);
    expect(settledEarly).toBe(false);
    // Resume: the same source continues and ends naturally.
    context.state = "running";
    for (let i = 0; i < 80; i += 1) {
      context.advanceClock(25);
      await vi.advanceTimersByTimeAsync(25);
    }
    endSource(context);
    await expect(playback).resolves.toBeUndefined();
    expect(started).toHaveBeenCalledTimes(1);
    expect(context.sources).toHaveLength(1);
  });

  it("rejects (does not fabricate success) when the context stays suspended past the hard deadline", async () => {
    const context = new FakeAudioContext();
    const playback = playDecodedVoiceAudio(
      makeOptions(context, { watchdogTiming: FAST }),
    );
    // Attach a handler immediately so the timer-driven rejection is never
    // reported as unhandled before the matcher below observes it.
    void playback.catch(() => {});
    await vi.advanceTimersByTimeAsync(200);
    context.state = "suspended";
    // nominal (2300) + suspensionDeadline (1500) = 3800ms wall.
    await vi.advanceTimersByTimeAsync(6000);
    await expect(playback).rejects.toThrow(/remained suspended/);
  });

  it("rejects when the context closes mid-playback", async () => {
    const context = new FakeAudioContext();
    const playback = playDecodedVoiceAudio(
      makeOptions(context, { watchdogTiming: FAST }),
    );
    void playback.catch(() => {});
    await vi.advanceTimersByTimeAsync(1000);
    context.state = "closed";
    await vi.advanceTimersByTimeAsync(2500);
    await expect(playback).rejects.toThrow(/context closed/);
  });

  it("legacy safety net: resolves a running segment whose ended event is lost, once the audio clock passes nominal duration", async () => {
    const context = new FakeAudioContext();
    let settled: "resolved" | "rejected" | "pending" = "pending";
    const playback = playDecodedVoiceAudio(
      makeOptions(context, { watchdogTiming: FAST }),
    ).then(
      () => {
        settled = "resolved";
      },
      () => {
        settled = "rejected";
      },
    );
    // Play the full 2s of audio without ever firing `ended`, then keep both
    // clocks moving together past the watchdog deadline (wall 2300ms fires
    // the poll; the audio clock has comfortably passed nominal-grace so the
    // legacy safety net retires the segment successfully).
    for (let i = 0; i < 104; i += 1) {
      context.advanceClock(25);
      await vi.advanceTimersByTimeAsync(25);
    }
    await playback;
    expect(settled).toBe("resolved");
  });
});
