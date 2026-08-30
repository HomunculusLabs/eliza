/**
 * Host-side implementation of the core media-write port: exposes the single
 * content-addressed media store (`packages/agent/src/api/media-store.ts`) to
 * plugins as a runtime service under `MEDIA_WRITE_PORT_SERVICE`, so plugin
 * code can persist bytes without importing agent internals (and without
 * duplicating the store algorithm, as plugin-local-inference used to do for
 * transcript audio). Registered during host boot next to the other
 * host-owned services; absence fails consumers closed.
 */

import {
  ElizaError,
  logger,
  MEDIA_WRITE_PORT_SERVICE,
  type MediaWriteResult,
  Service,
} from "@elizaos/core";
import { persistMediaBytes } from "../api/media-store.ts";

export class MediaWritePortService extends Service {
  static serviceType: string = MEDIA_WRITE_PORT_SERVICE;

  capabilityDescription =
    "Content-addressed media writes for plugins (single media store)";

  async stop(): Promise<void> {
    // Stateless port — nothing to release.
  }

  /**
   * Persist bytes into the content-addressed store. Delegates to the sync
   * store primitive wrapped as an async boundary so the port signature stays
   * stable if the store ever moves behind an I/O queue.
   */
  async persistMedia(
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<MediaWriteResult> {
    if (!(bytes instanceof Uint8Array)) {
      throw new ElizaError("media write requires byte input", {
        code: "MEDIA_STORE_WRITE_INVALID_INPUT",
        context: { received: typeof bytes },
      });
    }
    if (typeof mimeType !== "string" || mimeType.length === 0) {
      throw new ElizaError("media write requires a non-empty MIME type", {
        code: "MEDIA_STORE_WRITE_INVALID_INPUT",
        context: { received: mimeType },
      });
    }
    const result = persistMediaBytes(Buffer.from(bytes), mimeType);
    logger.debug(
      `[media-write-port] persisted ${result.fileName} (${bytes.byteLength} bytes, ${mimeType})`,
    );
    return result;
  }
}
