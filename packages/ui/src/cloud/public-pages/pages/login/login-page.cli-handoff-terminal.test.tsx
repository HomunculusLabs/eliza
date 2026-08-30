/**
 * Terminal handoff contract for the CLI login flow (#30014): the durable
 * session completion marker must make a late-mounted (or reloaded)
 * `/login?returnTo=/auth/cli-login?session=…` document initialize in its
 * terminal state instead of falling back to the live sign-in form, and the
 * marker itself must be session-keyed and TTL-bounded. The Steward section,
 * router, and i18n are doubled; the signal module under test is real.
 */
// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://elizacloud.ai/login"}

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./steward-login-section", () => ({
  default: () => <div>Steward login options</div>,
}));

vi.mock("../../../shell/CloudI18nProvider", () => ({
  useCloudT: () => (_key: string, opts?: { defaultValue?: string }) =>
    opts?.defaultValue ?? _key,
}));

vi.mock("../../lib/use-page-title", () => ({ usePageTitle: () => {} }));

import {
  hasPersistedCloudAuthComplete,
  publishCloudAuthComplete,
} from "../../../auth/cloud-auth-complete-signal";
import LoginPage from "./login-page";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("durable CLI completion marker", () => {
  it("is recorded when a session completion is published", () => {
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(false);
    publishCloudAuthComplete("sess-1");
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(true);
  });

  it("is session-keyed: completion of another session does not satisfy this one", () => {
    publishCloudAuthComplete("sess-other");
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(false);
  });

  it("expires after its TTL and stops reporting completion", () => {
    publishCloudAuthComplete("sess-1");
    // Backdate the recorded timestamp past the TTL.
    const key = "eliza.cloud.auth.complete.v1:sess-1";
    localStorage.setItem(key, String(Date.now() - 11 * 60_000));
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(false);
    // Expired markers are cleaned up on read.
    expect(localStorage.getItem(key)).toBeNull();
  });

  it("rejects future timestamps instead of pinning a terminal state", () => {
    localStorage.setItem(
      "eliza.cloud.auth.complete.v1:sess-1",
      String(Date.now() + 60 * 60_000),
    );
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(false);
    expect(
      localStorage.getItem("eliza.cloud.auth.complete.v1:sess-1"),
    ).toBeNull();
  });

  it("fails closed on a malformed marker", () => {
    localStorage.setItem(
      "eliza.cloud.auth.complete.v1:sess-1",
      "not-a-timestamp",
    );
    expect(hasPersistedCloudAuthComplete("sess-1")).toBe(false);
  });
});

describe("login page terminal handoff (#30014)", () => {
  it("initializes terminally when the CLI session already completed (late mount)", () => {
    publishCloudAuthComplete("sess-1");
    render(
      <MemoryRouter
        initialEntries={[
          `/login?returnTo=${encodeURIComponent(
            "/auth/cli-login?session=sess-1",
          )}`,
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );
    expect(screen.getByText("You're signed in")).toBeTruthy();
    // The sign-in form must NOT render — that is the exact regression from
    // the issue: a completed CLI session falling back to sign-in options.
    expect(screen.queryByText("Steward login options")).toBeNull();
  });

  it("stays on the sign-in form when the returnTo carries a different session", async () => {
    publishCloudAuthComplete("sess-other");
    render(
      <MemoryRouter
        initialEntries={[
          `/login?returnTo=${encodeURIComponent(
            "/auth/cli-login?session=sess-1",
          )}`,
        ]}
      >
        <LoginPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Steward login options")).toBeTruthy();
    expect(screen.queryByText("You're signed in")).toBeNull();
  });

  it("stays on the sign-in form without a CLI returnTo", async () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Steward login options")).toBeTruthy();
  });
});
