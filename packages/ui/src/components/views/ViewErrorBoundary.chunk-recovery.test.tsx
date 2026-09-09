/**
 * Unit tests for the stale-deploy chunk self-heal at the app-views boundary.
 */
// @vitest-environment jsdom
//
// Pins the #15383/#30889 recovery contract for ViewErrorBoundary: a lazy-view
// chunk error must trigger exactly ONE cooldown-guarded reload (via the shared
// chunk-load-recovery util), the view must NOT be marked crashed while the
// reload is armed, and a non-chunk error must fall through to the crash card
// with zero reloads. The cooldown budget is shared with
// CloudRouteErrorBoundary.test.tsx through the same sessionStorage marker key.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetViewLifecycleForTests,
  viewLifecycleController,
} from "../../state/view-lifecycle";
import {
  __resetViewRuntimeTelemetryForTests,
  installViewRuntimeTelemetryRing,
} from "../../view-runtime-telemetry";
import { ViewErrorBoundary } from "./ViewErrorBoundary";

/** Must match CHUNK_RELOAD_AT_KEY in utils/chunk-load-recovery.ts. */
const RELOAD_MARKER_KEY = "eliza:chunk-reload-attempted-at";
const COOLDOWN_MS = 5 * 60 * 1000;

let reloadSpy: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  __resetViewLifecycleForTests();
  __resetViewRuntimeTelemetryForTests();
  installViewRuntimeTelemetryRing();
  window.sessionStorage.clear();
  reloadSpy = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy },
  });
  // jsdom logs the caught render error; silence the noise for a clean run.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

function ChunkBoom({ message }: { message: string }): React.JSX.Element {
  throw new Error(message);
}

const CHUNK_FAILURES = [
  [
    "javascript import",
    "Failed to fetch dynamically imported module: https://eliza.app/assets/BillingPage-Bx1v9qQ3.js",
  ],
  ["vite css preload", "Unable to preload CSS for /assets/login-old.css"],
] as const;

describe("ViewErrorBoundary stale-deploy chunk self-heal (#30951)", () => {
  it.each(CHUNK_FAILURES)(
    "reloads exactly once for a chunk-load error (%s) and does not mark the view crashed",
    (_label, message) => {
      window.sessionStorage.clear();
      render(
        <ViewErrorBoundary viewId="chunker">
          <ChunkBoom message={message} />
        </ViewErrorBoundary>,
      );
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      // The boundary returns before markCrashed when the reload is armed: the
      // whole document is about to navigate; the crash card must not flash.
      expect(viewLifecycleController.getPhase("chunker")).not.toBe("crashed");
    },
  );

  it("does not reload a second time inside the cooldown and falls through to the crash card", () => {
    window.sessionStorage.clear();
    const first = render(
      <ViewErrorBoundary viewId="chunker">
        <ChunkBoom message="Failed to fetch dynamically imported module: https://eliza.app/assets/second.js" />
      </ViewErrorBoundary>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    first.unmount();
    // Simulate the reloaded document: fresh boundary, same session storage —
    // the timestamped marker survives and blocks the second reload.
    render(
      <ViewErrorBoundary viewId="chunker">
        <ChunkBoom message="Failed to fetch dynamically imported module: https://eliza.app/assets/second.js" />
      </ViewErrorBoundary>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(viewLifecycleController.getPhase("chunker")).toBe("crashed");
    expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
  });

  it("re-arms one more attempt after the cooldown lapses", () => {
    // Seed a marker from before the cooldown window: the budget is available
    // again, so a fresh chunk failure reloads once more.
    const staleAttempt = Date.now() - (COOLDOWN_MS + 60_000);
    window.sessionStorage.setItem(RELOAD_MARKER_KEY, String(staleAttempt));
    render(
      <ViewErrorBoundary viewId="chunker">
        <ChunkBoom message="Failed to fetch dynamically imported module: https://eliza.app/assets/after-cooldown.js" />
      </ViewErrorBoundary>,
    );
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("does not reload for a non-chunk error and marks the view crashed", () => {
    window.sessionStorage.clear();
    render(
      <ViewErrorBoundary viewId="plaincrash">
        <ChunkBoom message="TypeError: Cannot read properties of null" />
      </ViewErrorBoundary>,
    );
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(viewLifecycleController.getPhase("plaincrash")).toBe("crashed");
    expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
    // The marker stays untouched: no self-heal budget was spent on a crash
    // that a reload cannot fix.
    expect(window.sessionStorage.getItem(RELOAD_MARKER_KEY)).toBeNull();
  });

  it.each(["getItem", "setItem"] as const)(
    "keeps recovery manual when sessionStorage.%s is denied",
    (operation) => {
      vi.spyOn(Storage.prototype, operation).mockImplementation(() => {
        throw new DOMException("Storage denied", "SecurityError");
      });
      render(
        <ViewErrorBoundary viewId="chunker">
          <ChunkBoom message="Failed to fetch dynamically imported module: https://eliza.app/assets/denied.js" />
        </ViewErrorBoundary>,
      );
      // J4: private-mode storage denial must NOT loop reloads — the manual
      // Retry card is the recovery path.
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(viewLifecycleController.getPhase("chunker")).toBe("crashed");
      expect(screen.getByTestId("view-error-boundary-fallback")).toBeTruthy();
    },
  );
});
