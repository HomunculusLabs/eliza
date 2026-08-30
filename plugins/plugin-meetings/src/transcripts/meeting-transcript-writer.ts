/**
 * Meeting transcript persistence — lands attended-meeting transcripts in the
 * SAME store the Transcripts view reads (`/api/transcripts*`, served by
 * plugin-local-inference's transcripts-routes over the runtime `"transcripts"`
 * memories partition).
 *
 * Persistence path chosen: a local writer that replicates the exact record
 * shape (option c). Rationale:
 *  - (a) is impossible: plugin-local-inference constructs its TranscriptService
 *    per-request inside its route handlers; it never registers a runtime
 *    service exposing it.
 *  - (b) would mean a hard cross-plugin dependency on the opt-in, native-heavy
 *    local-inference plugin (meetings must transcribe through the model layer
 *    regardless of which ASR provider serves it) through an unsupported deep
 *    wildcard subpath (`./services/voice/transcript-store`) — brittle surface.
 *  - (c) is ~100 lines against the SHARED `Transcript` contract
 *    (@elizaos/shared/transcripts), which both the write and read sides JSON
 *    round-trip. The record-shape golden test in
 *    `meeting-transcript-writer.test.ts` parses the persisted row with the
 *    same reader logic transcripts-routes uses, so drift fails loudly.
 *
 * Row shape (must stay byte-compatible with plugin-local-inference's
 * TranscriptStore): memory id = transcript id, table `"transcripts"`,
 * `metadata.type "custom"` / `metadata.source "transcript"`,
 * `content.transcript` = JSON of the full record, `content.text` = preview.
 * The knowledge mirror goes through `runtime.getService("documents")
 * .addDocument` with the transcript-knowledge payload (tag `"transcript"`,
 * `clientDocumentId` = transcript id, `textBacked: true`).
 */

import {
  logger,
  type MediaWriteResult,
  type Memory,
  type MemoryMetadata,
  requireMediaWritePort,
  type UUID,
} from "@elizaos/core";
import type {
  MeetingEndReason,
  MeetingParticipant,
  MeetingPlatform,
} from "@elizaos/shared";
import {
  type Transcript,
  type TranscriptConsentState,
  type TranscriptSegment,
  transcriptDurationMs,
  transcriptKnowledgeFragments,
  transcriptPlainText,
  transcriptPreview,
  transcriptSpeakerCount,
} from "@elizaos/shared/transcripts";

/** The `type` column partition transcripts live in (sibling to "messages"). */
export const TRANSCRIPTS_TABLE = "transcripts";
/** `metadata.source` marker — matches plugin-local-inference's store. */
export const TRANSCRIPT_METADATA_TYPE = "transcript";
/** Tag every mirrored transcript carries so it's filterable as a transcript. */
export const TRANSCRIPT_DOCUMENT_TAG = "transcript";

/** Default milliseconds between incremental segment flushes to the store. */
export const DEFAULT_WRITE_THROTTLE_MS = 5_000;

/** The subset of `IAgentRuntime` the writer needs (real runtime satisfies it). */
export interface MeetingTranscriptRuntime {
  agentId: UUID;
  createMemory(memory: Memory, tableName: string): Promise<UUID>;
  getMemoryById(id: UUID): Promise<Memory | null>;
  updateMemory(
    memory: Partial<Memory> & { id: UUID; metadata?: MemoryMetadata },
  ): Promise<boolean>;
  getService(name: string): unknown;
}

/** The documents/knowledge service surface the mirror needs (structural). */
interface DocumentsLike {
  addDocument(options: {
    worldId: UUID;
    roomId: UUID;
    entityId: UUID;
    clientDocumentId: UUID;
    contentType: string;
    originalFilename: string;
    content: string;
    scope?: string;
    addedFrom?: string;
    metadata?: Record<string, unknown>;
    fragments?: Array<{ text: string; metadata?: Record<string, unknown> }>;
  }): Promise<{ storedDocumentMemoryId: UUID }>;
}

export interface StartMeetingTranscriptInput {
  sessionId: UUID;
  worldId: UUID;
  roomId: UUID;
  entityId: UUID;
  title: string;
  platform: MeetingPlatform;
  meetingUrl: string;
  nativeMeetingId: string;
  /** Capture-time consent decision; callers must never omit or infer it later. */
  consentState: TranscriptConsentState;
}

export interface FinalizeMeetingTranscriptInput {
  segments: TranscriptSegment[];
  endReason: MeetingEndReason;
  participants: MeetingParticipant[];
  /** Retained session audio (mono PCM16 WAV) — persisted to the media store. */
  audioWav?: Buffer | null;
  /** Already-rehosted source audio, used by authenticated platform imports. */
  retainedAudio?: { url: string; contentType: string };
  /** Import/capture provenance stored with the transcript record. */
  metadata?: Record<string, unknown>;
}

/** Serialize a transcript into the exact memory row the Transcripts view reads. */
function transcriptContentAndMetadata(transcript: Transcript): {
  content: Memory["content"];
  metadata: MemoryMetadata;
} {
  return {
    content: {
      text: transcriptPreview(transcript.segments),
      transcript: JSON.stringify(transcript),
    },
    metadata: {
      type: "custom",
      source: TRANSCRIPT_METADATA_TYPE,
      timestamp: transcript.createdAt,
      transcriptId: transcript.id,
      durationMs: transcript.durationMs,
      speakerCount: transcript.speakerCount,
      status: transcript.status,
    },
  };
}

/**
 * Parse the stored {@link Transcript} back out of a memory row — the exact
 * reader logic plugin-local-inference's transcripts-routes uses
 * (`rowToTranscript`), duplicated here so the record-shape golden test and the
 * GET_MEETING_TRANSCRIPT action read rows the same way the view does.
 */
export function readTranscriptRow(row: Memory): Transcript | null {
  const raw = (row.content as { transcript?: unknown }).transcript;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Transcript) : null;
  } catch {
    return null;
  }
}

/**
 * Persist meeting audio bytes through the host-owned content-addressed media
 * store (`MEDIA_WRITE_PORT_SERVICE`), returning the served
 * `/api/media/<sha256>.<ext>` handle. Fails closed with the typed
 * `MediaWritePortUnavailableError` when the host did not register the port —
 * the plugin must never fall back to its own writer (#30019).
 */
export async function persistMeetingAudio(
  runtime: MeetingTranscriptRuntime,
  wav: Buffer,
): Promise<MediaWriteResult> {
  const port = requireMediaWritePort(runtime);
  return port.persistMedia(new Uint8Array(wav), "audio/wav");
}

/**
 * Lifecycle writer for ONE meeting's transcript record: create at session
 * start with status `"recording"`, throttled incremental segment updates while
 * the meeting runs, and a final `"ready"` write with endedAt/duration/speaker
 * metadata + the knowledge mirror.
 */
export class MeetingTranscriptWriter {
  readonly transcriptId: UUID;
  private transcript: Transcript | null = null;
  private input: StartMeetingTranscriptInput | null = null;
  private segments: TranscriptSegment[] = [];
  /** Monotonic version of `segments` — bumped on every updateSegments call. */
  private segmentsVersion = 0;
  private lastWriteAt = 0;
  private pendingFlush: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  /**
   * Serialized incremental-flush drain: at most one ACTIVE flush plus one
   * QUEUED follow-up pass. Updates arriving while a pass is active schedule
   * exactly one follow-up (which reads the then-current segments), so writes
   * never complete out of order, no update is lost, and the queue stays
   * bounded under sustained updates. `finalize()` awaits the drain before its
   * terminal write (the async media port widened that race window).
   */
  private flushChain: Promise<void> = Promise.resolve();
  private flushActive = false;
  private flushQueued = false;
  /** Shared finalize operation so concurrent callers await the same result. */
  private finalizePromise: Promise<Transcript> | null = null;

  constructor(
    private readonly runtime: MeetingTranscriptRuntime,
    private readonly throttleMs: number = DEFAULT_WRITE_THROTTLE_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.transcriptId = crypto.randomUUID() as UUID;
  }

  /** Create the transcript record in status "recording". */
  async start(input: StartMeetingTranscriptInput): Promise<Transcript> {
    const createdAt = this.now();
    const transcript: Transcript = {
      id: this.transcriptId,
      title: input.title,
      createdAt,
      durationMs: 0,
      segments: [],
      source: "meeting",
      scope: "owner-private",
      status: "recording",
      speakerCount: 0,
      metadata: {
        platform: input.platform,
        meetingUrl: input.meetingUrl,
        nativeMeetingId: input.nativeMeetingId,
        sessionId: input.sessionId,
        participants: [],
        capture: { mode: "bot" },
        consent: { state: input.consentState },
        policy: { state: "allowed" },
        permission: { state: "not_required" },
        retention: {
          state: "transcript_only",
          sourceAudioDeleted: false,
        },
        sharing: {
          transcript: "owner_private",
          notes: "owner_private",
          sourceAudio: "disabled",
          artifacts: "owner_private",
        },
      },
    };
    const { content, metadata } = transcriptContentAndMetadata(transcript);
    await this.runtime.createMemory(
      {
        id: this.transcriptId,
        entityId: input.entityId,
        roomId: input.roomId,
        agentId: this.runtime.agentId,
        createdAt,
        content,
        metadata,
      },
      TRANSCRIPTS_TABLE,
    );
    this.transcript = transcript;
    this.input = input;
    this.lastWriteAt = createdAt;
    logger.info(
      { transcriptId: this.transcriptId, sessionId: input.sessionId },
      "[MeetingService] meeting transcript record created (recording)",
    );
    return transcript;
  }

  /**
   * Replace the live segment set (confirmed + pending tail) and schedule a
   * throttled store update — at most one write per `throttleMs`.
   */
  updateSegments(segments: TranscriptSegment[]): void {
    if (this.finalizePromise || !this.transcript) return;
    this.segments = segments;
    this.segmentsVersion += 1;
    const elapsed = this.now() - this.lastWriteAt;
    if (elapsed >= this.throttleMs) {
      void this.flush();
      return;
    }
    if (this.pendingFlush === null) {
      this.pendingFlush = setTimeout(() => {
        this.pendingFlush = null;
        void this.flush();
      }, this.throttleMs - elapsed);
      // Never keep the process alive for a throttle timer.
      this.pendingFlush.unref?.();
    }
  }

  /**
   * Incremental store write. Invoked via `void this.flush()` (fire-and-forget)
   * from the throttle path, so it must never reject — a DB hiccup would surface
   * as an unhandled promise rejection. All failures are caught and logged here;
   * the next update simply retries.
   */
  private async flush(): Promise<void> {
    // While a pass is active, ensure exactly ONE follow-up pass is queued;
    // each pass drains until quiescent (see drainFlushes), so no update is
    // lost and the backlog stays bounded (active + one queued).
    if (this.flushActive) {
      if (!this.flushQueued) {
        this.flushQueued = true;
        const run = this.flushChain
          .then(() => this.drainFlushes())
          .finally(() => {
            this.flushQueued = false;
          });
        this.flushChain = run;
      }
      return this.flushChain;
    }
    this.flushActive = true;
    const run = this.flushChain
      .then(() => this.drainFlushes())
      .finally(() => {
        this.flushActive = false;
      });
    this.flushChain = run;
    return run;
  }

  /**
   * Flush repeatedly until no new segments arrived during the last write.
   * A pass snapshots `this.segments` inside `doFlush`, so updates landing
   * mid-write bump `segmentsVersion` and force one more pass — the drain
   * cannot return while dirty data is unpersisted.
   */
  private async drainFlushes(): Promise<void> {
    let seen = -1;
    while (!this.finalized && !this.finalizePromise && this.transcript) {
      if (seen === this.segmentsVersion) break;
      seen = this.segmentsVersion;
      await this.doFlush();
    }
  }

  private async doFlush(): Promise<void> {
    if (this.finalized || this.finalizePromise || !this.transcript) return;
    this.lastWriteAt = this.now();
    const next: Transcript = {
      ...this.transcript,
      segments: this.segments,
      durationMs: transcriptDurationMs(this.segments),
      speakerCount: transcriptSpeakerCount(this.segments),
    };
    this.transcript = next;
    const { content, metadata } = transcriptContentAndMetadata(next);
    try {
      const ok = await this.runtime.updateMemory({
        id: this.transcriptId,
        content,
        metadata,
      });
      if (!ok) {
        logger.warn(
          {
            transcriptId: this.transcriptId,
            sessionId: this.input?.sessionId,
          },
          "[MeetingService] incremental transcript update hit a missing row",
        );
      }
    } catch (err) {
      logger.warn(
        {
          transcriptId: this.transcriptId,
          sessionId: this.input?.sessionId,
          error: err instanceof Error ? err.message : String(err),
        },
        "[MeetingService] incremental transcript update failed",
      );
    }
  }

  /** Final write: status "ready", timings, participants, audio + knowledge mirror. */
  async finalize(input: FinalizeMeetingTranscriptInput): Promise<Transcript> {
    // Concurrent callers share one finalize operation; both observe the same
    // outcome instead of a half-finalized transcript.
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = this.doFinalize(input);
    try {
      return await this.finalizePromise;
    } finally {
      // A failed finalize stays retryable: the transcript has not been marked
      // final, so a retry re-runs the write instead of returning stale
      // "recording" state as if it had succeeded.
      if (!this.finalized) this.finalizePromise = null;
    }
  }

  private async doFinalize(
    input: FinalizeMeetingTranscriptInput,
  ): Promise<Transcript> {
    if (!this.transcript || !this.input) {
      throw new Error(
        "[MeetingService] finalize called before transcript start",
      );
    }
    if (this.finalized) return this.transcript;
    if (this.pendingFlush !== null) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = null;
    }
    // Serialize against the full chain of incremental flushes so the finalized
    // row is strictly the LAST write (an async media-write port widened this
    // window; without the await a stale recording-status row could land after
    // the final state).
    await this.flushChain;

    const endedAt = this.now();
    if (input.audioWav && input.retainedAudio) {
      throw new Error(
        "[MeetingService] finalize accepts captured or imported audio, not both",
      );
    }
    let audioUrl: string | undefined;
    let audioContentType: string | undefined;
    if (input.audioWav && input.audioWav.length > 0) {
      const stored = await persistMeetingAudio(this.runtime, input.audioWav);
      audioUrl = stored.url;
      audioContentType = "audio/wav";
    } else if (input.retainedAudio) {
      audioUrl = input.retainedAudio.url;
      audioContentType = input.retainedAudio.contentType;
    }

    const final: Transcript = {
      ...this.transcript,
      segments: input.segments,
      endedAt,
      durationMs: transcriptDurationMs(input.segments),
      speakerCount: transcriptSpeakerCount(input.segments),
      status: "ready",
      audioUrl,
      audioContentType,
      metadata: {
        ...this.transcript.metadata,
        ...input.metadata,
        endReason: input.endReason,
        participants: input.participants,
        retention: {
          state: audioUrl ? "audio_retained" : "transcript_only",
          sourceAudioDeleted: false,
        },
        sharing: {
          transcript: "owner_private",
          notes: "owner_private",
          sourceAudio: audioUrl ? "owner_private" : "disabled",
          artifacts: "owner_private",
        },
      },
    };

    const knowledgeDocumentId = await this.mirrorToKnowledge(final);
    if (knowledgeDocumentId) final.knowledgeDocumentId = knowledgeDocumentId;

    // Publish the final transcript object into the writer state ONLY after
    // the durable row write succeeds — a failed updateMemory must leave the
    // recording-state transcript authoritative, so a later incremental flush
    // can never persist a speculative terminal state after finalize()
    // reported failure.
    const { content, metadata } = transcriptContentAndMetadata(final);
    const ok = await this.runtime.updateMemory({
      id: this.transcriptId,
      content,
      metadata,
    });
    if (!ok) {
      throw new Error(
        `[MeetingService] transcript ${this.transcriptId} row vanished before finalize`,
      );
    }
    this.transcript = final;
    logger.info(
      {
        transcriptId: this.transcriptId,
        segments: final.segments.length,
        durationMs: final.durationMs,
        speakerCount: final.speakerCount,
        endReason: input.endReason,
      },
      "[MeetingService] meeting transcript finalized (ready)",
    );
    // Mark final only after the durable write succeeded — a failed finalize
    // stays retryable and concurrent updateSegments() calls keep working
    // until the record actually reaches its terminal state.
    this.finalized = true;
    return final;
  }

  /**
   * Best-effort searchable mirror into the documents/knowledge store — a
   * search-index failure must never lose the meeting record.
   */
  private async mirrorToKnowledge(
    transcript: Transcript,
  ): Promise<string | undefined> {
    const documents = this.runtime.getService(
      "documents",
    ) as DocumentsLike | null;
    if (!documents || !this.input) return undefined;
    const content = transcriptPlainText(transcript.segments);
    if (!content) return undefined;
    const slug =
      transcript.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64) || "transcript";
    try {
      const res = await documents.addDocument({
        worldId: this.input.worldId,
        roomId: this.input.roomId,
        entityId: this.input.entityId,
        clientDocumentId: transcript.id as UUID,
        contentType: "text/plain",
        originalFilename: `${slug}.txt`,
        content,
        scope: transcript.scope,
        addedFrom: "runtime-internal",
        metadata: {
          source: TRANSCRIPT_DOCUMENT_TAG,
          tags: [TRANSCRIPT_DOCUMENT_TAG],
          transcriptId: transcript.id,
          title: transcript.title,
          durationMs: transcript.durationMs,
          speakerCount: transcript.speakerCount,
          createdAt: transcript.createdAt,
          textBacked: true,
          // `mediaUrl` is the key the daily media GC scans on document rows;
          // `audioUrl` alone would leave the retained WAV unreferenced and it
          // would be swept. Set both: mediaUrl anchors the media store handle,
          // audioUrl is what transcript readers look up.
          ...(transcript.audioUrl
            ? {
                mediaUrl: transcript.audioUrl,
                audioUrl: transcript.audioUrl,
              }
            : {}),
        },
        fragments: transcriptKnowledgeFragments(transcript.segments),
      });
      return res.storedDocumentMemoryId;
    } catch (err) {
      logger.warn(
        {
          transcriptId: transcript.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "[MeetingService] transcript knowledge mirror failed",
      );
      return undefined;
    }
  }
}
