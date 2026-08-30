/**
 * Media-write port contract tests (deterministic, mocked runtime lookups):
 * the resolver returns a registered port by service name and fails closed
 * with the typed unavailable error when the host did not register one or the
 * service does not expose persistMedia.
 */

import { describe, expect, it } from "vitest";
import {
  MEDIA_WRITE_PORT_SERVICE,
  MediaWritePortUnavailableError,
  requireMediaWritePort,
} from "./port.js";

describe("requireMediaWritePort", () => {
  it("returns the service when the host registered a valid port", () => {
    const port = {
      persistMedia: async () => ({
        url: "/api/media/x.wav",
        hash: "x",
        fileName: "x.wav",
      }),
    };
    const runtime = {
      getService: (name: string) =>
        name === MEDIA_WRITE_PORT_SERVICE ? port : null,
    };
    expect(requireMediaWritePort(runtime)).toBe(port);
  });

  it("fails closed with a typed error when no service is registered", () => {
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

  it("rejects a registered service that does not expose persistMedia", () => {
    const runtime = { getService: () => ({ somethingElse: true }) };
    expect(() => requireMediaWritePort(runtime)).toThrow(
      MediaWritePortUnavailableError,
    );
  });
});
