/**
 * Cross-tab signal when a device-code / CLI Cloud login session finishes.
 *
 * The opener (local first-run or hosted shell) polls until authenticated; the
 * auth surface (popup or tab on elizacloud) may also complete via
 * `/auth/cli-login`. Orphaned intermediate tabs (e.g. Steward `/login` left
 * open after nested OAuth) do not share `window.opener`, so `postMessage` alone
 * cannot dismiss them. BroadcastChannel reaches every same-origin Cloud tab so
 * they can show a terminal "done" state instead of a live sign-in form.
 *
 * Localhost openers do not share origin with Cloud, so they still rely on
 * polling + `window.opener` postMessage; this channel is for Cloud-origin
 * surfaces talking to each other.
 */

export const CLOUD_AUTH_COMPLETE_MESSAGE_TYPE = "eliza-cloud-auth-complete";

export const CLOUD_AUTH_COMPLETE_CHANNEL = "eliza-cloud-auth-complete";

// BroadcastChannel does not replay: an orphaned /login?returnTo=/auth/cli-login
// document that mounts (or reloads) after the completing tab published the
// event misses it and falls back to the live sign-in form even though the CLI
// session already finished (#30014). This durable, session-keyed marker gives
// late subscribers a replay source. It lives in localStorage — NOT
// sessionStorage — because the completing popup and the stranded /login tab
// are distinct top-level browsing contexts; only a same-origin shared storage
// is visible to both. It is presentation-only — it may suppress sign-in UI,
// never authorize anything. CLI sessions are server-issued single-use ids
// with a ~10-minute lifetime; the TTL here mirrors that window, and future
// timestamps are rejected so a falsified clock cannot pin a stale terminal
// state.
const CLOUD_AUTH_COMPLETE_STORAGE_PREFIX = "eliza.cloud.auth.complete.v1";
const CLOUD_AUTH_COMPLETE_TTL_MS = 10 * 60_000;

function cloudAuthCompleteStorageKey(sessionId: string): string {
  return `${CLOUD_AUTH_COMPLETE_STORAGE_PREFIX}:${sessionId.trim()}`;
}

/**
 * Persist a completion marker for a finished CLI/device session. Called right
 * before the broadcast publish so live and late consumers observe the same
 * transition. Best-effort: storage can be unavailable in private browsing,
 * where the BroadcastChannel live path still works.
 */
function persistCloudAuthComplete(sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      cloudAuthCompleteStorageKey(trimmed),
      String(Date.now()),
    );
  } catch (error) {
    void error;
    // error-policy:J4 marker persistence failing degrades to the designed
    // live-signal path (BroadcastChannel + opener poll); sign-in stays usable.
  }
}

/**
 * True when this origin has a non-expired completion marker for the given
 * session — i.e. the session already finished and a late-mounted login
 * surface must render its terminal state instead of sign-in options. Reading
 * is storage-mechanism-agnostic (any same-origin context sees the marker).
 */
export function hasPersistedCloudAuthComplete(sessionId: string): boolean {
  const trimmed = sessionId.trim();
  if (!trimmed || typeof window === "undefined") return false;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(cloudAuthCompleteStorageKey(trimmed));
  } catch (error) {
    void error;
    // error-policy:J4 storage unavailable — fail closed to "not completed" so
    // the live sign-in form renders rather than a fabricated terminal state.
    return false;
  }
  if (stored === null) return false;
  const completedAt = Number(stored);
  if (!Number.isFinite(completedAt)) return false;
  const age = Date.now() - completedAt;
  // A future timestamp cannot be a legitimate completion record; treat it as
  // invalid so a falsified clock cannot pin a terminal state indefinitely.
  // The read is pure: it never removes anything. hasPersistedCloudAuthComplete
  // runs inside React state initializers during render, so a mutating read
  // would violate render purity. Stale markers are simply ignored on read and
  // bounded by the same TTL check on every subsequent read; explicit cleanup
  // lives in clearStaleCloudAuthCompleteMarkers.
  if (age < 0 || age > CLOUD_AUTH_COMPLETE_TTL_MS) {
    return false;
  }
  return true;
}

/**
 * Remove completion markers whose recorded timestamp has fallen outside the
 * TTL window (expired or future/falsified). This is the only mutating path
 * besides publishing: render-path reads stay pure, so stale-marker hygiene
 * runs where a write is already legitimate.
 */
export function clearStaleCloudAuthCompleteMarkers(): void {
  if (typeof window === "undefined") return;
  const now = Date.now();
  // Match the full prefix-with-separator so a future marker family sharing a
  // basename (e.g. ...v2) is never swept by this pass.
  const scopedPrefix = `${CLOUD_AUTH_COMPLETE_STORAGE_PREFIX}:`;
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(scopedPrefix)) continue;
      const stored = window.localStorage.getItem(key);
      const completedAt = Number(stored);
      if (!Number.isFinite(completedAt)) {
        window.localStorage.removeItem(key);
        continue;
      }
      const age = now - completedAt;
      if (age < 0 || age > CLOUD_AUTH_COMPLETE_TTL_MS) {
        window.localStorage.removeItem(key);
      }
    }
  } catch (error) {
    void error;
    // error-policy:J4 cleanup is hygiene, never correctness — stale markers
    // are already ignored by reads; failing to remove them changes nothing.
  }
}

export type CloudAuthCompleteMessage = {
  type: typeof CLOUD_AUTH_COMPLETE_MESSAGE_TYPE;
  sessionId: string;
};

export function isCloudAuthCompleteMessage(
  data: unknown,
  sessionId?: string,
): data is CloudAuthCompleteMessage {
  if (!data || typeof data !== "object") return false;
  const message = data as { type?: unknown; sessionId?: unknown };
  if (message.type !== CLOUD_AUTH_COMPLETE_MESSAGE_TYPE) return false;
  if (typeof message.sessionId !== "string" || !message.sessionId.trim()) {
    return false;
  }
  if (sessionId !== undefined && message.sessionId !== sessionId) return false;
  return true;
}

export function publishCloudAuthComplete(sessionId: string): void {
  const trimmed = sessionId.trim();
  if (!trimmed || typeof window === "undefined") return;
  persistCloudAuthComplete(trimmed);
  // Publishing is the natural non-render maintenance point: every completion
  // pass removes markers that have aged out of the TTL window so the prefix
  // cannot accumulate unbounded stale keys (#30014).
  clearStaleCloudAuthCompleteMarkers();
  const payload: CloudAuthCompleteMessage = {
    type: CLOUD_AUTH_COMPLETE_MESSAGE_TYPE,
    sessionId: trimmed,
  };
  try {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CLOUD_AUTH_COMPLETE_CHANNEL);
    channel.postMessage(payload);
    channel.close();
  } catch (error) {
    void error;
    // error-policy:J6 broadcast is best-effort; opener poll still completes login.
  }
}

/**
 * Subscribe to same-origin Cloud auth completion. Returns an unsubscribe fn.
 * No-ops when BroadcastChannel is unavailable (SSR / old engines).
 */
export function subscribeCloudAuthComplete(
  onComplete: (message: CloudAuthCompleteMessage) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined"
  ) {
    return () => {};
  }
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CLOUD_AUTH_COMPLETE_CHANNEL);
  } catch (error) {
    void error;
    return () => {};
  }
  const handler = (event: MessageEvent) => {
    if (!isCloudAuthCompleteMessage(event.data)) return;
    onComplete(event.data);
  };
  channel.addEventListener("message", handler);
  return () => {
    try {
      channel.removeEventListener("message", handler);
      channel.close();
    } catch (error) {
      void error;
      // error-policy:J6 teardown only.
    }
  };
}

/**
 * True when this browsing context is already the device-code auth surface
 * (named popup or opened from the app). Nested OAuth must stay same-tab so we
 * do not leave the Steward sign-in form stranded in a sibling tab.
 *
 * `popupName` defaults to the Cloud login popup name (`eliza-cloud-auth`);
 * callers may pass {@link CLOUD_LOGIN_POPUP_NAME} explicitly to avoid a
 * packages-layer import cycle.
 */
export function isCloudAuthHandoffSurface(
  popupName = "eliza-cloud-auth",
): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.name === popupName) return true;
  } catch (error) {
    void error;
  }
  try {
    const opener = window.opener as Window | null;
    if (opener && !opener.closed) return true;
  } catch (error) {
    void error;
  }
  return false;
}
