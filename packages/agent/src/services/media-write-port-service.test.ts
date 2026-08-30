/**
 * Media-write port service tests: real content-addressed store delegation
 * (real filesystem under a temp ELIZA_STATE_DIR), not mocks. Covers the
 * contract plugin-local-inference's transcripts route depends on: canonical
 * URL shape, idempotency, concurrent-writer deduplication, invalid-input
 * typed failures, and absent-service fail-closed resolution.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MEDIA_WRITE_PORT_SERVICE,
  MediaWritePortUnavailableError,
  requireMediaWritePort,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MediaWritePortService } from "./media-write-port-service.ts";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "media-write-port-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  delete process.env.ELIZA_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function service(): MediaWritePortService {
  return new MediaWritePortService();
}

function wav(bytes: number): Uint8Array {
  // Minimal honest WAV-shaped payload: RIFF header + silent PCM data.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVE", 8);
  return new Uint8Array(header);
}

describe("MediaWritePortService", () => {
  it("uses the canonical media-write service name", () => {
    expect(MediaWritePortService.serviceType).toBe(MEDIA_WRITE_PORT_SERVICE);
  });

  it("persists WAV bytes at the canonical URL with the real store", async () => {
    const bytes = wav(4);
    const result = await service().persistMedia(bytes, "audio/wav");
    expect(result.url).toMatch(/^\/api\/media\/[a-f0-9]{64}\.wav$/);
    expect(result.fileName).toBe(`${result.hash}.wav`);
    const onDisk = path.join(stateDir, "media", result.fileName);
    expect(fs.existsSync(onDisk)).toBe(true);
    expect(new Uint8Array(fs.readFileSync(onDisk))).toEqual(bytes);
  });

  it("is idempotent: identical bytes resolve to the same file", async () => {
    const bytes = wav(8);
    const first = await service().persistMedia(bytes, "audio/wav");
    const second = await service().persistMedia(bytes, "audio/wav");
    expect(second.url).toBe(first.url);
    expect(second.hash).toBe(first.hash);
  });

  it("deduplicates concurrent writers of the same bytes", async () => {
    const bytes = wav(16);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        service().persistMedia(bytes, "audio/wav"),
      ),
    );
    const names = new Set(results.map((r) => r.fileName));
    expect(names.size).toBe(1);
    expect(
      new Set(results.map((r) => path.join(stateDir, "media", r.fileName)))
        .size,
    ).toBe(1);
  });

  it("rejects non-byte input with a typed store error", async () => {
    await expect(
      // @ts-expect-error deliberately invalid consumer input
      service().persistMedia("not bytes", "audio/wav"),
    ).rejects.toMatchObject({ code: "MEDIA_STORE_WRITE_INVALID_INPUT" });
  });

  it("rejects an empty MIME type with a typed store error", async () => {
    await expect(service().persistMedia(wav(2), "")).rejects.toMatchObject({
      code: "MEDIA_STORE_WRITE_INVALID_INPUT",
    });
  });
});

describe("requireMediaWritePort fail-closed", () => {
  it("resolves the registered port via the service name", async () => {
    const port = service();
    const runtime = {
      getService: (name: string) =>
        name === MEDIA_WRITE_PORT_SERVICE ? port : null,
    };
    expect(requireMediaWritePort(runtime)).toBe(port);
  });

  it("throws the typed unavailable error when the host did not register it", () => {
    const runtime = { getService: () => null };
    try {
      requireMediaWritePort(runtime);
      expect.unreachable("requireMediaWritePort should fail closed");
    } catch (err) {
      expect(err).toBeInstanceOf(MediaWritePortUnavailableError);
      expect((err as MediaWritePortUnavailableError).code).toBe(
        "MEDIA_WRITE_PORT_UNAVAILABLE",
      );
    }
  });
});
