/**
 * Unit coverage for adopting a remote agent's first-run state (URL
 * normalization, read-only status probe, adoption outcomes). Client injected,
 * no live agent. Regression target #30988: adoption must never submit a
 * first-run payload to the connected host.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adoptRemoteAgentFirstRun,
  completeRemoteAgentFirstRun,
  normalizeRemoteAgentUrl,
  type RemoteFirstRunClient,
} from "./adopt-remote-first-run";
import { setPendingFirstRunTextReleaseHandler } from "./first-run-pending-text";

afterEach(() => setPendingFirstRunTextReleaseHandler(null));

describe("normalizeRemoteAgentUrl", () => {
  it("keeps a valid http URL and strips the trailing slash", () => {
    expect(normalizeRemoteAgentUrl("http://127.0.0.1:31337/")).toBe(
      "http://127.0.0.1:31337",
    );
  });

  it("upgrades a bare host to https", () => {
    expect(normalizeRemoteAgentUrl("agent.example.com")).toBe(
      "https://agent.example.com",
    );
  });

  it("strips query and hash so one host has one identity", () => {
    expect(normalizeRemoteAgentUrl("https://agent.example.com/?x=1#frag")).toBe(
      "https://agent.example.com",
    );
  });

  it("throws on an empty value", () => {
    expect(() => normalizeRemoteAgentUrl("   ")).toThrow(
      /enter a remote agent url/i,
    );
  });

  it("rejects a non-http(s) protocol", () => {
    expect(() => normalizeRemoteAgentUrl("ftp://agent.example.com")).toThrow(
      /http or https/i,
    );
  });
});

function makeClient(overrides: Partial<RemoteFirstRunClient> = {}): {
  client: RemoteFirstRunClient;
  getFirstRunStatus: ReturnType<typeof vi.fn>;
  submitFirstRun: ReturnType<typeof vi.fn>;
} {
  const getFirstRunStatus = vi.fn(async () => ({ complete: false }));
  const submitFirstRun = vi.fn(async () => undefined);
  // The injected double carries submitFirstRun even though the real client
  // surface no longer needs it, so a regression that reintroduces the
  // completion write FAILS these assertions instead of throwing at the
  // call site.
  const client = {
    getFirstRunStatus,
    submitFirstRun,
    ...overrides,
  } as unknown as RemoteFirstRunClient;
  return { client, getFirstRunStatus, submitFirstRun };
}

describe("adoptRemoteAgentFirstRun", () => {
  it("adopts a configured remote without any setup write", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: true })),
    });

    const result = await adoptRemoteAgentFirstRun(client, {
      apiBase: "https://agent.example.com",
    });

    expect(result).toEqual({ alreadyComplete: true, hostNeedsSetup: false });
    expect(submitFirstRun).not.toHaveBeenCalled();
  });

  it("#30988: never submits a first-run payload to an incomplete host — reports it instead", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    });

    const result = await adoptRemoteAgentFirstRun(client, {
      apiBase: "http://127.0.0.1:31337",
    });

    expect(result).toEqual({ alreadyComplete: false, hostNeedsSetup: true });
    expect(submitFirstRun).not.toHaveBeenCalled();
  });

  it("#30988: a failed status probe is a visible error with NO setup write", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("network down");
      }),
    });

    await expect(
      adoptRemoteAgentFirstRun(client, { apiBase: "http://127.0.0.1:31337" }),
    ).rejects.toThrow(/could not verify the remote agent/i);
    expect(submitFirstRun).not.toHaveBeenCalled();
  });

  it("#30988: an unauthorized probe surfaces as the same visible error", async () => {
    const { client, submitFirstRun } = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("401 Unauthorized");
      }),
    });

    await expect(
      adoptRemoteAgentFirstRun(client, {
        apiBase: "https://agent.example.com",
      }),
    ).rejects.toThrow(/could not verify the remote agent/i);
    expect(submitFirstRun).not.toHaveBeenCalled();
  });
});

describe("completeRemoteAgentFirstRun", () => {
  it("completes locally and releases typed onboarding intent only for a configured remote", async () => {
    const order: string[] = [];
    const { client } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: true })),
    });
    setPendingFirstRunTextReleaseHandler(() => void order.push("release"));

    await completeRemoteAgentFirstRun(
      client,
      { apiBase: "https://agent.example.com" },
      () => void order.push("complete"),
    );

    expect(order).toEqual(["complete", "release"]);
  });

  it("#30988: an incomplete host performs neither local completion nor queued-text release", async () => {
    const complete = vi.fn();
    const release = vi.fn();
    const { client } = makeClient({
      getFirstRunStatus: vi.fn(async () => ({ complete: false })),
    });
    setPendingFirstRunTextReleaseHandler(release);

    const result = await completeRemoteAgentFirstRun(
      client,
      { apiBase: "http://127.0.0.1:31337" },
      complete,
    );

    expect(result).toEqual({ alreadyComplete: false, hostNeedsSetup: true });
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("does not complete or release when the probe fails", async () => {
    const complete = vi.fn();
    const release = vi.fn();
    const { client } = makeClient({
      getFirstRunStatus: vi.fn(async () => {
        throw new Error("remote unreachable");
      }),
    });
    setPendingFirstRunTextReleaseHandler(release);

    await expect(
      completeRemoteAgentFirstRun(
        client,
        { apiBase: "http://127.0.0.1:31337" },
        complete,
      ),
    ).rejects.toThrow(/could not verify the remote agent/i);
    expect(complete).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
