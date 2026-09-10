/**
 * Headless "adopt a remote agent during first-run" use case.
 *
 * Device + desktop remote-connect-at-URL onboarding (deep link and the Settings
 * "Connect a remote agent" entry) funnels through here AFTER the client base has
 * been pointed at the remote (`applyLaunchConnection({ kind: "remote" })`).
 *
 * Adoption is strictly read-only against the host (#30988): connecting a device
 * must never reconfigure where the host runs. The remote's first-run status is
 * probed; an already-configured host is adopted as-is, and a host that has not
 * finished its own setup is reported as needing explicit setup — the device then
 * surfaces that host's onboarding instead of fabricating a completed config. A
 * probe failure (unreachable or unauthorized) is a visible connection error:
 * no setup write, no device-local completion, no queued-chat release.
 *
 * It is intentionally dependency-injected (the client surface is the only
 * dependency) so it can be unit-tested without the React shell or a live server.
 */

import type { UiLanguage } from "../i18n";
import { releasePendingFirstRunText } from "./first-run-pending-text";

/**
 * Normalizes a user- or link-supplied remote agent address into a canonical
 * `http(s)://host[:port]` URL, throwing a friendly message on anything invalid.
 * A bare `host:port` is upgraded to `https://`. Trailing slashes, query, and
 * hash are stripped so the same host always yields one identity.
 */
export function normalizeRemoteAgentUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a remote agent URL.");
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    // error-policy:J3 untrusted user input — explicit invalid signal
    throw new Error("Enter a valid remote agent URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Remote agents must use HTTP or HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

/** The minimal client surface this use case needs (a subset of `ElizaClient`). */
export interface RemoteFirstRunClient {
  getFirstRunStatus(): Promise<{ complete: boolean }>;
}

export interface AdoptRemoteAgentFirstRunInput {
  /** The remote agent URL — already normalized/applied by the caller. */
  apiBase: string;
  /** Optional pre-shared access token for a pairing-disabled remote. */
  token?: string | null;
  /** Drives the default character preset language; defaults to English. */
  uiLanguage?: UiLanguage;
}

export interface AdoptRemoteAgentFirstRunResult {
  /** True when the remote already reported a completed first-run. */
  alreadyComplete: boolean;
  /**
   * True when the remote is reachable but has NOT finished its own first-run.
   * The caller must route the user to that host's explicit setup — adoption
   * never writes a config, so it cannot make an unconfigured host ready.
   */
  hostNeedsSetup: boolean;
}

/**
 * Inspects the connected remote's first-run state without writing anything to
 * it. Throws a visible connection error when the status probe fails — an
 * unreachable or unauthorized remote must not be adopted.
 */
export async function adoptRemoteAgentFirstRun(
  client: RemoteFirstRunClient,
  _input?: AdoptRemoteAgentFirstRunInput,
): Promise<AdoptRemoteAgentFirstRunResult> {
  let status: { complete: boolean };
  try {
    status = await client.getFirstRunStatus();
  } catch (err) {
    // error-policy:J2 context-adding rethrow — the probe failure is the
    // connection failure the user must see; nothing was written and the
    // caller's completion/release must not run.
    throw new Error(
      "Could not verify the remote agent is reachable and configured.",
      { cause: err },
    );
  }

  if (status.complete === true) {
    return { alreadyComplete: true, hostNeedsSetup: false };
  }
  return { alreadyComplete: false, hostNeedsSetup: true };
}

/**
 * Adopts the remote and — only once the remote itself reports a completed
 * first-run — commits the local first-run gate and releases any typed
 * onboarding requests to the real composer. A remote that still needs setup
 * performs neither: the user is routed to that host's explicit onboarding, so
 * model readiness is never fabricated. A failed adoption (probe error)
 * performs neither local completion nor release.
 */
export async function completeRemoteAgentFirstRun(
  client: RemoteFirstRunClient,
  input: AdoptRemoteAgentFirstRunInput | undefined,
  completeFirstRun: () => void,
): Promise<AdoptRemoteAgentFirstRunResult> {
  const result = await adoptRemoteAgentFirstRun(client, input);
  if (!result.alreadyComplete) {
    return result;
  }
  completeFirstRun();
  releasePendingFirstRunText();
  return result;
}
