/**
 * Cross-package port for writing bytes into the single content-addressed media
 * store. The store itself is owned by the agent host
 * (`packages/agent/src/api/media-store.ts`): plugins must not duplicate its
 * algorithm, and they cannot import it directly because a plugin depending on
 * `@elizaos/agent` would invert the host→plugin dependency direction. Instead,
 * core declares this narrow contract (same shape as the
 * `PII_ENTITY_RECOGNIZER_SERVICE` port): the host registers a service under
 * `MEDIA_WRITE_PORT_SERVICE`, and a plugin that needs to persist bytes
 * resolves the port from its runtime and delegates. Callers supply only
 * bytes + MIME; naming, deduplication, eviction, and the served
 * `/api/media/<sha256>.<ext>` URL handle remain owned by the store.
 */

import { ElizaError } from "../errors.ts";

/** Service name under which the host registers the media-write port. */
export const MEDIA_WRITE_PORT_SERVICE = "media_write_port";

/** Result of a successful media write — the canonical capability handle. */
export interface MediaWriteResult {
  /** Served URL (`/api/media/<sha256>.<ext>`) for the stored bytes. */
  url: string;
  /** sha256 of the stored bytes, hex. */
  hash: string;
  /** Content-addressed file name (`<sha256>.<ext>`) inside the store. */
  fileName: string;
}

/** Shape a {@link MEDIA_WRITE_PORT_SERVICE} service must expose. */
export interface MediaWritePort {
  /**
   * Persist bytes into the content-addressed media store (idempotent) and
   * return the served URL. Must not throw for empty input; invalid arguments
   * and I/O failures throw typed errors owned by the store.
   */
  persistMedia(bytes: Uint8Array, mimeType: string): Promise<MediaWriteResult>;
}

/** The host did not register a {@link MEDIA_WRITE_PORT_SERVICE} service. */
export class MediaWritePortUnavailableError extends ElizaError {
  constructor(hostHint: string) {
    super(`media write port unavailable: ${hostHint}`, {
      code: "MEDIA_WRITE_PORT_UNAVAILABLE",
      context: { service: MEDIA_WRITE_PORT_SERVICE },
    });
  }
}

/** Resolve the media-write port from a runtime, failing closed when absent. */
export function requireMediaWritePort(runtime: {
  getService(name: string): unknown;
}): MediaWritePort {
  const service = runtime.getService(
    MEDIA_WRITE_PORT_SERVICE,
  ) as Partial<MediaWritePort> | null;
  if (!service || typeof service.persistMedia !== "function") {
    throw new MediaWritePortUnavailableError(
      "the host did not register the content-addressed media store service",
    );
  }
  return service as MediaWritePort;
}
