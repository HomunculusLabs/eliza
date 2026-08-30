/**
 * Route-level contract test for the transcript-create audio persistence:
 * POST /api/transcripts must persist session WAV bytes through the host
 * media-write port (single content-addressed store contract) and fail closed
 * with a typed 503 when the host did not register the port — never fall back
 * to a plugin-local writer. The registered fixture is a real filesystem
 * content-addressed writer implementing the core port (the production
 * implementation lives in @elizaos/agent and is covered by its own suite;
 * both suites pin the identical canonical URL shape so drift surfaces).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RouteHandlerContext } from "@elizaos/core";
import {
  MEDIA_WRITE_PORT_SERVICE,
  type MediaWritePort,
  MediaWritePortUnavailableError,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transcriptsRoutes } from "./transcripts-routes.js";

let stateDir: string;

beforeAll(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcripts-audio-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterAll(() => {
  delete process.env.ELIZA_STATE_DIR;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const WORLD = "11111111-1111-4111-8111-111111111111" as never;
const ROOM = "22222222-2222-4222-8222-222222222222" as never;
const ENTITY = "33333333-3333-4333-8333-333333333333" as never;

function wavBytes(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(40, 4);
  header.write("WAVE", 8);
  return header;
}

/** Real-FS content-addressed port fixture (test double of the host service). */
function realFsPort(): MediaWritePort {
  return {
    async persistMedia(bytes: Uint8Array, _mimeType: string) {
      const hash = createHash("sha256").update(bytes).digest("hex");
      const fileName = `${hash}.wav`;
      const dir = path.join(stateDir, "media");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, fileName);
      if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
      return { url: `/api/media/${fileName}`, hash, fileName };
    },
  };
}

function fakeRuntime(services: Record<string, unknown> = {}) {
  const rows = new Map<string, unknown>();
  const reported: { scope: string; err: unknown }[] = [];
  return {
    rows,
    reported,
    runtime: {
      agentId: "agent-1",
      createMemory: async (m: { id: string }) => {
        rows.set(m.id, m);
        return m.id;
      },
      getMemories: async () => [...rows.values()],
      getMemoryById: async (id: string) => rows.get(id) ?? null,
      getRoom: async (id: string) => ({ id, worldId: WORLD }),
      getRoomsForParticipants: async () => [ROOM],
      reportError: (scope: string, err: unknown) => {
        reported.push({ scope, err });
      },
      updateMemory: async () => true,
      deleteMemory: async () => undefined,
      getService: (name: string) => services[name] ?? null,
    },
  };
}

function ctx(over: Partial<RouteHandlerContext>): RouteHandlerContext {
  return {
    params: {},
    query: {},
    body: undefined,
    headers: {},
    method: "POST",
    path: "/api/transcripts",
    inProcess: true,
    ...over,
  } as RouteHandlerContext;
}

function createHandler() {
  const route = transcriptsRoutes.find(
    (x) => x.type === "POST" && x.path === "/api/transcripts",
  );
  if (!route?.routeHandler) throw new Error("no POST /api/transcripts route");
  return route.routeHandler;
}

function audioBase64Body(over: Record<string, unknown> = {}) {
  return {
    title: "Session",
    worldId: WORLD,
    roomId: ROOM,
    entityId: ENTITY,
    scope: "user-private",
    segments: [
      {
        id: "seg-1",
        speaker: "Speaker",
        text: "hello",
        startMs: 0,
        endMs: 100,
      },
    ],
    audioBase64: wavBytes().toString("base64"),
    ...over,
  };
}

describe("POST /api/transcripts audio persistence (media-write port)", () => {
  it("stores session WAV bytes through the port and serves the canonical URL", async () => {
    const { runtime } = fakeRuntime({
      [MEDIA_WRITE_PORT_SERVICE]: realFsPort(),
    });
    const bytes = wavBytes();
    const res = await createHandler()(
      ctx({ runtime: runtime as never, body: audioBase64Body() }) as never,
    );
    expect(res.status).toBe(201);
    const audioUrl = (res.body as { transcript: { audioUrl?: string } })
      .transcript.audioUrl;
    expect(audioUrl).toMatch(/^\/api\/media\/[a-f0-9]{64}\.wav$/);
    // Round-trip: the exact request bytes are on disk under the URL name.
    const fileName = audioUrl.slice("/api/media/".length);
    const onDisk = fs.readFileSync(path.join(stateDir, "media", fileName));
    expect(new Uint8Array(onDisk)).toEqual(new Uint8Array(bytes));
    expect(createHash("sha256").update(onDisk).digest("hex")).toBe(
      fileName.split(".")[0],
    );
  });

  it("is idempotent: replaying the same audioBase64 resolves to the same URL", async () => {
    const { runtime } = fakeRuntime({
      [MEDIA_WRITE_PORT_SERVICE]: realFsPort(),
    });
    const first = await createHandler()(
      ctx({ runtime: runtime as never, body: audioBase64Body() }) as never,
    );
    const second = await createHandler()(
      ctx({
        runtime: runtime as never,
        body: audioBase64Body({ title: "Replay" }),
      }) as never,
    );
    expect(
      (second.body as { transcript: { audioUrl: string } }).transcript.audioUrl,
    ).toBe(
      (first.body as { transcript: { audioUrl: string } }).transcript.audioUrl,
    );
  });

  it("fails closed with 503 + typed code when the host did not register the port", async () => {
    const { runtime, reported } = fakeRuntime();
    const mediaDir = path.join(stateDir, "media");
    const before = fs.existsSync(mediaDir)
      ? fs.readdirSync(mediaDir).length
      : 0;
    const res = await createHandler()(
      ctx({
        runtime: runtime as never,
        body: audioBase64Body(),
      }) as never,
    );
    expect(res.status).toBe(503);
    expect((res.body as { code?: string }).code).toBe(
      "MEDIA_WRITE_PORT_UNAVAILABLE",
    );
    // No plugin-local fallback write happened: nothing new hit the media dir.
    const after = fs.existsSync(mediaDir) ? fs.readdirSync(mediaDir).length : 0;
    expect(after).toBe(before);
    // The failure surfaced through the runtime error-reporting boundary.
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ scope: "transcripts.audio-persist" });
    expect(reported[0].err).toBeInstanceOf(MediaWritePortUnavailableError);
  });
});
