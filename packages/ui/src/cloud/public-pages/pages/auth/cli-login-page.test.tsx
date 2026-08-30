/** Verifies CliLoginPage through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * `CliLoginPage` device-login flow: an unauthenticated visitor is redirected
 * straight to /login (no CLI interstitial) with a per-session guard so it never
 * loops; an authenticated visitor is held on a confirmation interstitial that
 * names the requesting client — a bare clicked link must never mint a key, only
 * the explicit Authorize gesture POSTs /complete (then notifies the opener and
 * returns app-launched sessions to their sanitized return target, keeping the
 * success screen as the terminal/manual fallback), while Cancel abandons the
 * flow with no POST; a missing session id or a completion failure renders the
 * error panel with no POST. The router, session-auth hook, api-client, Steward
 * provider, and i18n are doubled.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- collaborator doubles (hoisted so vi.mock factories can close over them) ---

const navigateMock = vi.hoisted(() => vi.fn());
const searchParamsRef = vi.hoisted(() => ({
  current: new URLSearchParams("session=sess-1"),
}));
vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsRef.current, vi.fn()],
}));

const sessionAuthRef = vi.hoisted(() => ({
  current: {
    ready: true,
    authenticated: false,
    user: null as { id: string; email: string } | null,
  },
}));
vi.mock("../../../lib/use-session-auth", () => ({
  useSessionAuth: () => sessionAuthRef.current,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api-client", () => {
  // Mirror the real ApiError signature (status, code, message, body?) so the
  // page's `error instanceof ApiError && error.status === 401` check works.
  class ApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string,
      public readonly body?: unknown,
    ) {
      super(message);
      this.name = "ApiError";
    }
  }
  return { apiFetch: apiFetchMock, ApiError };
});

const clearStaleStewardSession = vi.hoisted(() => vi.fn());
vi.mock("../../../shell/StewardProvider", () => ({
  clearStaleStewardSession,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import { ApiError } from "../../../lib/api-client";
import CliLoginPage from "./cli-login-page";

const SESSION_ID = "bbbbbbbb-2222-4333-8444-cccccccccccc";
const SECOND_SESSION_ID = "aaaaaaaa-1111-4222-8333-dddddddddddd";
const GUARD_KEY = "eliza-cloud-cli-login-autosignin:sess-1";
const TRUSTED_APP_LAUNCH_KEY = `eliza-cloud-cli-login-trusted-app-launch:${SESSION_ID}`;
const APP_RETURN_TO = `http://127.0.0.1:2138/?elizaCloudLogin=complete&elizaCloudLoginSession=${SESSION_ID}`;
const SIGN_IN_HREF = `/login?returnTo=${encodeURIComponent(
  "/auth/cli-login?session=sess-1",
)}`;
const originalLocationDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "location",
);
const testSessionStorage = window.sessionStorage;
let currentDocumentReferrer = "";

function resetSessionAuth() {
  sessionAuthRef.current = {
    ready: true,
    authenticated: false,
    user: null,
  };
}

function authenticate(): void {
  sessionAuthRef.current = {
    ready: true,
    authenticated: true,
    user: { id: "u1", email: "a@b.co" },
  };
}

function stubLocationReplace(): ReturnType<typeof vi.fn> {
  const replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...window.location,
      origin: "https://elizacloud.ai",
      replace,
    },
  });
  return replace;
}

function restoreLocation(): void {
  if (originalLocationDescriptor) {
    Object.defineProperty(window, "location", originalLocationDescriptor);
  }
}

beforeEach(() => {
  navigateMock.mockReset();
  apiFetchMock.mockReset();
  clearStaleStewardSession.mockReset();
  searchParamsRef.current = new URLSearchParams("session=sess-1");
  resetSessionAuth();
  testSessionStorage.clear();
  localStorage.clear();
  currentDocumentReferrer = "";
  vi.spyOn(document, "referrer", "get").mockImplementation(
    () => currentDocumentReferrer,
  );
});

afterEach(() => {
  restoreLocation();
  cleanup();
  vi.restoreAllMocks();
  delete (window as { opener?: unknown }).opener;
});

describe("CliLoginPage", () => {
  it("auto-redirects an unauthenticated visitor straight to /login (no CLI interstitial) and arms the per-session guard", async () => {
    // No window.opener (not script-closable): the page must never offer a
    // "Close Window" button nor call window.close().
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    expect((window as { opener?: unknown }).opener).toBeUndefined();

    render(<CliLoginPage />);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(SIGN_IN_HREF, {
        replace: true,
      }),
    );
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(testSessionStorage.getItem(GUARD_KEY)).toBe("1");
    // Renders the neutral "Signing in" state, never the old CLI panel/button.
    expect(screen.getByText("Signing in")).toBeTruthy();
    expect(screen.queryByText("CLI Authentication")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign In" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("does NOT redirect again when the guard is already set — shows the manual sign-in fallback (loop-safety)", async () => {
    testSessionStorage.setItem(GUARD_KEY, "1");

    render(<CliLoginPage />);

    // Give any effect a tick to (not) fire.
    await Promise.resolve();
    expect(navigateMock).not.toHaveBeenCalled();
    const link = screen.getByRole("link", { name: /sign in/i });
    expect(link.getAttribute("href")).toBe(SIGN_IN_HREF);
  });

  it("holds an authenticated visitor on the confirmation interstitial — a bare clicked link never mints a key", async () => {
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });

    render(<CliLoginPage />);

    expect(
      screen.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeTruthy();
    // The interstitial names the requesting client (generic form when the
    // flow carries no returnTo) and no completion POST has fired on load.
    expect(screen.getByText(/command-line application/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    await Promise.resolve();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("names the requesting client's host on the interstitial when returnTo is present", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    authenticate();

    render(<CliLoginPage />);

    expect(screen.getByText(/"localhost:2138"/)).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("finishes a matching localhost Eliza app launch without a second authorization click", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: SESSION_ID,
      returnTo: APP_RETURN_TO,
    });
    currentDocumentReferrer = "http://127.0.0.1:2138/";
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    delete (window as { opener?: unknown }).opener;
    const replace = stubLocationReplace();
    vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    expect(screen.getByText("Returning to Eliza")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
    await waitFor(() =>
      expect(apiFetchMock).toHaveBeenCalledWith(
        `/api/auth/cli-session/${SESSION_ID}/complete`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() => expect(replace).toHaveBeenCalledWith(APP_RETURN_TO));
    expect(testSessionStorage.getItem(TRUSTED_APP_LAUNCH_KEY)).toBeNull();
  });

  it("does not trust a copied app callback link without the matching localhost referrer", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: SESSION_ID,
      returnTo: APP_RETURN_TO,
    });
    currentDocumentReferrer = "https://attacker.example/forward";
    authenticate();

    render(<CliLoginPage />);

    expect(
      screen.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(testSessionStorage.getItem(TRUSTED_APP_LAUNCH_KEY)).toBeNull();
  });

  it("does not trust a localhost referrer when the callback names another session", () => {
    searchParamsRef.current = new URLSearchParams({
      session: SESSION_ID,
      returnTo: APP_RETURN_TO.replace(SESSION_ID, SECOND_SESSION_ID),
    });
    currentDocumentReferrer = "http://127.0.0.1:2138/";
    authenticate();

    render(<CliLoginPage />);

    expect(
      screen.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("remembers the trusted local launch across the hosted login round trip", async () => {
    searchParamsRef.current = new URLSearchParams({
      session: SESSION_ID,
      returnTo: APP_RETURN_TO,
    });
    currentDocumentReferrer = "http://127.0.0.1:2138/chat";

    const first = render(<CliLoginPage />);
    await waitFor(() =>
      expect(testSessionStorage.getItem(TRUSTED_APP_LAUNCH_KEY)).toBe("1"),
    );
    first.unmount();

    currentDocumentReferrer = "https://staging.eliza.app/login";
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    delete (window as { opener?: unknown }).opener;
    const replace = stubLocationReplace();
    vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
    await waitFor(() => expect(replace).toHaveBeenCalledWith(APP_RETURN_TO));
    expect(testSessionStorage.getItem(TRUSTED_APP_LAUNCH_KEY)).toBeNull();
  });

  it("requires fresh confirmation after a session link changes away and back", async () => {
    const user = userEvent.setup();
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });

    const { rerender } = render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));

    searchParamsRef.current = new URLSearchParams("session=sess-2");
    rerender(<CliLoginPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
      ).toBeTruthy(),
    );

    // Swapping back to the already-completed session now lands on the
    // terminal success state via the durable completion marker (#30014):
    // a consumed session must not be re-authorized (a second Authorize would
    // attempt a second mint against a consumed session).
    searchParamsRef.current = new URLSearchParams("session=sess-1");
    rerender(<CliLoginPage />);
    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Authorize" })).toBeNull();
    await Promise.resolve();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    // The fresh session still requires its own explicit Authorize gesture.
    searchParamsRef.current = new URLSearchParams("session=sess-2");
    rerender(<CliLoginPage />);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Authorize CLI Sign-In?" }),
      ).toBeTruthy(),
    );
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  });

  it("Cancel abandons the flow with no POST and a distinct cancelled state", async () => {
    const user = userEvent.setup();
    authenticate();

    render(<CliLoginPage />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Sign-In Cancelled")).toBeTruthy();
    expect(screen.getByText(/No API key was created/)).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("completes authenticated terminal/manual sessions with the success fallback after Authorize", async () => {
    const user = userEvent.setup();
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const postMessage = vi.fn();
    // No live opener — terminal success UI (manual close), not auto-close.
    Object.defineProperty(window, "opener", {
      value: null,
      configurable: true,
    });
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/auth/cli-session/sess-1/complete",
      expect.objectContaining({ method: "POST" }),
    );
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(postMessage).not.toHaveBeenCalled();
    // #30014 terminal contract: an ordinary tab (no opener, not the named
    // popup) cannot script-close, so it must render the truthful destination
    // action instead of a no-op Close window button.
    expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
    const continueLink = screen.getByRole("link", {
      name: "Continue to Eliza",
    });
    expect(continueLink.getAttribute("href")).toBe("/join");
    expect(
      screen.queryByRole("link", { name: "Continue to dashboard" }),
    ).toBeNull();
    expect(screen.queryByText("API Key Details")).toBeNull();
    expect(screen.queryByText("ek_live_abc")).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("with a live opener, notifies and closes without navigating returnTo (no second app shell)", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const postMessage = vi.fn();
    Object.defineProperty(window, "opener", {
      value: { postMessage, closed: false },
      configurable: true,
    });
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: "eliza-cloud-auth-complete", sessionId: "sess-1" },
      "http://localhost:2138",
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Opener owns continuation — returnTo must not load a second localhost.
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText("Returning to app")).toBeNull();
  });

  it("named cloud-auth popup without opener stays terminal (no returnTo second shell)", async () => {
    // COOP / opener closed mid-flight: window.name still identifies the handoff
    // surface, but hasLiveOpener would be false. Must not location.replace.
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    Object.defineProperty(window, "opener", {
      value: null,
      configurable: true,
    });
    const originalName = window.name;
    window.name = "eliza-cloud-auth";
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    try {
      render(<CliLoginPage />);
      await user.click(screen.getByRole("button", { name: "Authorize" }));

      await waitFor(() =>
        expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
      );
      expect(replace).not.toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Returning to app")).toBeNull();
    } finally {
      window.name = originalName;
    }
  });

  it("without an opener, redirects authenticated app-launched sessions to sanitized returnTo", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    delete (window as { opener?: unknown }).opener;
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "http://localhost:2138/chat?firstRun=1",
      ),
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Returning to app")).toBeTruthy();
    expect(screen.queryByText("Authentication Complete!")).toBeNull();
  });

  it("allows the production apex app as a returnTo target", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "https://elizacloud.ai/chat?elizaCloudLogin=complete",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const replace = stubLocationReplace();
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "https://elizacloud.ai/chat?elizaCloudLogin=complete",
      ),
    );
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Returning to app")).toBeTruthy();
    expect(screen.queryByText("Authentication Complete!")).toBeNull();
  });

  it("ignores untrusted returnTo origins and keeps the success fallback", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "https://evil.example.test/chat",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const replace = stubLocationReplace();

    render(<CliLoginPage />);
    // An untrusted returnTo is sanitized away, so the interstitial falls back
    // to the generic client description.
    expect(screen.getByText(/command-line application/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders a safe keyboard-reachable recovery action when the session id is missing", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams("");

    render(<CliLoginPage />);

    expect(screen.getByRole("main")).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Authentication Error",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText("Invalid authentication link. Missing session ID."),
    ).toBeTruthy();
    const recovery = screen.getByRole("link", { name: "Sign In Again" });
    expect(recovery.getAttribute("href")).toBe("/login");
    await user.tab();
    expect(document.activeElement).toBe(recovery);
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
  });

  it("surfaces a completion failure as the error panel", async () => {
    const user = userEvent.setup();
    authenticate();
    apiFetchMock.mockRejectedValue(new Error("boom"));

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() =>
      expect(screen.getByText("Authentication Error")).toBeTruthy(),
    );
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Window" })).toBeNull();
  });

  it("clears the stale Steward session on a 401 during completion", async () => {
    const user = userEvent.setup();
    authenticate();
    apiFetchMock.mockRejectedValue(new ApiError(401, "unauthorized", "nope"));

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() => expect(clearStaleStewardSession).toHaveBeenCalled());
  });

  // --- #30014: terminal contract for non-closable tabs ---

  it("swaps the success Close button for the /join fallback when a close attempt is refused", async () => {
    const user = userEvent.setup();
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    // Named popup: a script-opened surface, so Close renders first.
    Object.defineProperty(window, "opener", {
      value: null,
      configurable: true,
    });
    const originalName = window.name;
    window.name = "eliza-cloud-auth";
    // Refused close: window.closed stays false after window.close().
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    Object.defineProperty(window, "closed", {
      configurable: true,
      get: () => false,
    });

    try {
      render(<CliLoginPage />);
      await user.click(screen.getByRole("button", { name: "Authorize" }));

      await waitFor(() =>
        expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
      );
      // Completion auto-attempted the close; it was refused — the panel must
      // now offer the truthful fallback action, not the dead Close button.
      expect(closeSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.getByRole("link", { name: "Continue to Eliza" }),
        ).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
    } finally {
      window.name = originalName;
      delete (window as { closed?: boolean }).closed;
    }
  });

  it("gives an ordinary cancelled tab the /join action instead of a no-op Close button", async () => {
    const user = userEvent.setup();
    authenticate();
    // Ordinary tab: no opener, no popup name.
    delete (window as { opener?: unknown }).opener;
    const originalName = window.name;
    window.name = "";

    try {
      render(<CliLoginPage />);
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      expect(screen.getByText("Sign-In Cancelled")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Close window" })).toBeNull();
      const continueLink = screen.getByRole("link", {
        name: "Continue to Eliza",
      });
      expect(continueLink.getAttribute("href")).toBe("/join");
      expect(apiFetchMock).not.toHaveBeenCalled();
    } finally {
      window.name = originalName;
    }
  });

  it("notifies the opener before attempting the popup close (ordering)", async () => {
    const user = userEvent.setup();
    searchParamsRef.current = new URLSearchParams({
      session: "sess-1",
      returnTo: "http://localhost:2138/chat?firstRun=1",
    });
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    const order: string[] = [];
    const postMessage = vi.fn(() => order.push("postMessage"));
    Object.defineProperty(window, "opener", {
      value: {
        postMessage,
        closed: false,
      },
      configurable: true,
    });
    vi.spyOn(window, "close").mockImplementation(() => order.push("close"));

    render(<CliLoginPage />);
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    await waitFor(() => expect(order).toEqual(["postMessage", "close"]));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("initializes terminally from the durable marker WITHOUT minting (late reload)", async () => {
    // Another tab completed this session; this tab then loads (or reloads)
    // the /auth/cli-login surface directly. It must render the terminal
    // success state and never POST /complete — the marker is presentational.
    const { publishCloudAuthComplete } = await import(
      "../../../auth/cloud-auth-complete-signal"
    );
    // Clear marker pollution from other tests, then publish this session.
    localStorage.clear();
    publishCloudAuthComplete("sess-1");
    authenticate();

    render(<CliLoginPage />);

    expect(screen.getByText("Authentication Complete!")).toBeTruthy();
    // No Authorize interstitial, no completion POST — reading the marker
    // must never mint a key.
    expect(screen.queryByText("Authorize CLI Sign-In?")).toBeNull();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("keeps completion idempotent: a broadcast echo for the same session does not re-POST", async () => {
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    Object.defineProperty(window, "opener", {
      value: null,
      configurable: true,
    });
    const originalName = window.name;
    window.name = "eliza-cloud-auth";
    // jsdom's real window.close() would tear the shared test window down.
    vi.spyOn(window, "close").mockImplementation(() => {});

    try {
      const { publishCloudAuthComplete } = await import(
        "../../../auth/cloud-auth-complete-signal"
      );
      render(<CliLoginPage />);
      await waitFor(() =>
        expect(screen.getByText("Authorize CLI Sign-In?")).toBeTruthy(),
      );
      // Another tab finished this session while this popup sat on the
      // interstitial.
      publishCloudAuthComplete("sess-1");
      await waitFor(() =>
        expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
      );
      // No Authorize gesture happened here, so no POST was ever made.
      expect(apiFetchMock).not.toHaveBeenCalled();
      // A duplicate broadcast for the same session changes nothing.
      publishCloudAuthComplete("sess-1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(apiFetchMock).not.toHaveBeenCalled();
      expect(screen.getByText("Authentication Complete!")).toBeTruthy();
    } finally {
      window.name = originalName;
    }
  });

  it("never re-POSTs a trusted tab whose session already completed elsewhere (durable marker wins)", async () => {
    // Regression (#30014 rebase review): a tab with a session-scoped
    // trusted-app-launch marker (remembered across the hosted login round
    // trip) reloads AFTER another tab already completed the session. The
    // durable completion marker must render terminal success WITHOUT the
    // completion effect firing a second /complete POST.
    const { publishCloudAuthComplete } = await import(
      "../../../auth/cloud-auth-complete-signal"
    );
    localStorage.clear();
    // This tab remembered the trusted local launch for this session.
    testSessionStorage.setItem(TRUSTED_APP_LAUNCH_KEY, "1");
    // ...and another tab completed the session while this one was away.
    publishCloudAuthComplete("sess-1");
    authenticate();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    vi.spyOn(window, "close").mockImplementation(() => {});

    render(<CliLoginPage />);

    // Terminal success from the marker, no Authorize interstitial…
    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );
    expect(
      screen.queryByRole("heading", { name: "Authorize CLI Sign-In?" }),
    ).toBeNull();
    // …and crucially no completion POST even though trustedAppLaunch would
    // otherwise let the effect skip the explicit Authorize gate.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("stays terminal (no POST) even when the durable marker expires while authentication is pending", async () => {
    // Regression (#30014 rebase review r2): the marker initializes
    // completion as terminal success; if authentication resolves AFTER the
    // marker's TTL window, the completion effect must still not fire —
    // terminal success is permanent for the presented session.
    const markerKey = "eliza.cloud.auth.complete.v1:sess-1";
    localStorage.setItem(markerKey, String(Date.now()));
    testSessionStorage.setItem(TRUSTED_APP_LAUNCH_KEY, "1");
    // Auth is not ready yet when the surface mounts terminal.
    sessionAuthRef.current = { ready: false, authenticated: false, user: null };
    apiFetchMock.mockResolvedValue({
      json: async () => ({ keyPrefix: "ek_live_abc" }),
    });
    vi.spyOn(window, "close").mockImplementation(() => {});

    const { rerender } = render(<CliLoginPage />);
    await waitFor(() =>
      expect(screen.getByText("Authentication Complete!")).toBeTruthy(),
    );

    // The marker ages out of its TTL while auth is still pending, then
    // authentication resolves — the POST path must remain closed.
    localStorage.setItem(markerKey, String(Date.now() - 11 * 60_000));
    authenticate();
    rerender(<CliLoginPage />);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.getByText("Authentication Complete!")).toBeTruthy();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

describe("CliLoginPage short-viewport scroll", () => {
  // Every CliLoginPanel state (confirm, success "Authentication Complete!",
  // error) is a full-viewport centered card. On short screens (Light Phone III,
  // 1080×1240) a flex `justify-center` pins the card center above scrollTop 0,
  // hiding the action buttons below an unreachable fold. The panel must be
  // `overflow-y-auto` with the card `my-auto`. jsdom can't measure layout, so
  // scan the source — same idiom as login-page.safe-area.test.tsx.
  const SRC = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "cli-login-page.tsx"),
    "utf8",
  );

  it("makes the panel region scroll instead of clipping when it exceeds the viewport", () => {
    expect(
      /min-h-\[100dvh\][^"]*overflow-y-auto/.test(SRC),
      "the CliLoginPanel wrapper must be overflow-y-auto to scroll when taller than the viewport",
    ).toBe(true);
  });

  it("centers the card with my-auto (not a parent justify-center that clips the top)", () => {
    expect(
      /\bmy-auto\b[^"]*\bmax-w-md\b/.test(SRC),
      "the panel card must center via my-auto so its top stays reachable while scrolling",
    ).toBe(true);
    expect(
      /min-h-\[100dvh\][^"]*items-center justify-center/.test(SRC),
      "the panel must not use the top-clipping items-center justify-center centering",
    ).toBe(false);
  });
});
