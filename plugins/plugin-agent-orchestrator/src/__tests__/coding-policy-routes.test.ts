/**
 * Exercises the coding-policy HTTP routes (#24099): GET/PUT
 * /api/coding-agents/policy against real route-handler invocation with
 * deterministic runtime doubles — malformed-JSON 400 (J3), per-field 400
 * issue shape, corrupt stored document degrade, persistence-failure 500
 * (J1), and the success shape with derived readiness. No live server.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { IAgentRuntime } from "@elizaos/core";
import { setCodingAgentSelectorBridge } from "@elizaos/core";
import { CODING_POLICY_SETTING_KEY } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAgentRoutes } from "../api/agent-routes.js";

type Ctx = Parameters<typeof handleAgentRoutes>[3];

function makeRuntime(
  opts: { throwOnSet?: boolean } = {},
): IAgentRuntime & { settings: Map<string, string> } {
  const settings = new Map<string, string>();
  const runtime = {
    settings,
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string | boolean | null) => {
      if (opts.throwOnSet) throw new Error("disk full");
      if (value === null) settings.delete(key);
      else settings.set(key, String(value));
    },
  } as unknown as IAgentRuntime & { settings: Map<string, string> };
  return runtime;
}

/**
 * Request whose stream carries RAW WIRE BYTES — parseBody falls back to
 * reading the stream, so malformed JSON hits the real J3 rejection path
 * (lesson from review r2 finding 4: a pre-materialized req.body only
 * exercises the pre-parsed object shortcut, not wire parsing).
 */
function wireRequest(method: string, raw: string): IncomingMessage {
  const listeners: Record<string, Array<(chunk?: unknown) => void>> = {};
  const req = {
    method,
    headers: {},
    on(event: string, cb: (chunk?: unknown) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(cb);
      return req;
    },
    destroy() {},
  } as unknown as IncomingMessage;
  // Emit after the current tick so parseBody attaches its listeners first.
  setTimeout(() => {
    for (const cb of listeners.data ?? []) cb(Buffer.from(raw, "utf8"));
    for (const cb of listeners.end ?? []) cb();
  }, 0);
  return req;
}

/**
 * Pre-parsed-body request for the happy-path shapes the runtime dispatcher
 * would have already materialized.
 */
function request(
  method: string,
  body?: unknown,
): IncomingMessage & { body?: unknown } {
  return {
    method,
    headers: {},
    ...(body !== undefined ? { body } : {}),
  } as unknown as IncomingMessage & { body?: unknown };
}

function response(): {
  res: ServerResponse;
  status: () => number | undefined;
  payload: () => unknown;
} {
  let status: number | undefined;
  let sent: unknown;
  const res = {
    writeHead(code: number) {
      status = code;
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        try {
          sent = JSON.parse(chunk);
        } catch {
          sent = chunk;
        }
      }
      return this;
    },
  } as unknown as ServerResponse;
  return { res, status: () => status, payload: () => sent };
}

function ctx(runtime: IAgentRuntime): Ctx {
  return { runtime } as unknown as Ctx;
}

const VALID = {
  version: 1,
  primary: { backend: "claude", providerId: "anthropic-subscription" },
  fallbacks: [{ backend: "codex", providerId: "openai-codex" }],
  approvalPreset: "standard",
};

function healthyBridge() {
  setCodingAgentSelectorBridge({
    describe: () => ({
      claude: [
        {
          providerId: "anthropic-subscription",
          total: 1,
          enabled: 1,
          healthy: 1,
        },
      ],
      codex: [{ providerId: "openai-codex", total: 1, enabled: 1, healthy: 1 }],
    }),
    select: vi.fn(async () => null),
  } as never);
}

afterEach(() => {
  setCodingAgentSelectorBridge(null);
});

describe("GET /api/coding-agents/policy (#24099)", () => {
  it("returns null policy and no issues when nothing is persisted", async () => {
    const res = response();
    expect(
      await handleAgentRoutes(
        request("GET"),
        res.res,
        "/api/coding-agents/policy",
        ctx(makeRuntime()),
      ),
    ).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.payload()).toEqual({ policy: null });
  });

  it("returns the persisted policy with derived readiness", async () => {
    healthyBridge();
    const runtime = makeRuntime();
    runtime.setSetting(CODING_POLICY_SETTING_KEY, JSON.stringify(VALID));
    const res = response();
    await handleAgentRoutes(
      request("GET"),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(200);
    const payload = res.payload() as {
      policy: { primary: { backend: string } };
      readiness: { ready: boolean; effectiveBackend?: string };
    };
    expect(payload.policy.primary.backend).toBe("claude");
    expect(payload.readiness.ready).toBe(true);
    expect(payload.readiness.effectiveBackend).toBe("claude");
  });

  it("degrades with an explicit issue on a corrupt stored document", async () => {
    const runtime = makeRuntime();
    runtime.setSetting(CODING_POLICY_SETTING_KEY, "{corrupt");
    const res = response();
    await handleAgentRoutes(
      request("GET"),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(200);
    const payload = res.payload() as { policy: unknown; issues: unknown[] };
    expect(payload.policy).toBeNull();
    expect(payload.issues.length).toBeGreaterThan(0);
  });
});

describe("PUT /api/coding-agents/policy (#24099)", () => {
  it("rejects malformed wire JSON with a 400 via the real J3 parse path", async () => {
    const res = response();
    expect(
      await handleAgentRoutes(
        wireRequest("PUT", '{"version": 1, "primary":'),
        res.res,
        "/api/coding-agents/policy",
        ctx(makeRuntime()),
      ),
    ).toBe(true);
    expect(res.status()).toBe(400);
    expect(res.payload()).toEqual({ error: "Invalid JSON body" });
  });

  it("returns per-field issues with 400 and persists nothing on an invalid document", async () => {
    const runtime = makeRuntime();
    const res = response();
    await handleAgentRoutes(
      request("PUT", {
        version: 1,
        primary: { backend: "claude" },
        fallbacks: [],
        approvalPreset: "standard",
        apiKey: "sk-ant-leak",
      }),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(400);
    const payload = res.payload() as {
      policy: unknown;
      issues: Array<{ path: string; code: string }>;
    };
    expect(payload.policy).toBeNull();
    const paths = payload.issues.map((issue) => issue.path);
    expect(paths).toContain("primary.providerId");
    expect(paths).toContain("apiKey");
    expect(runtime.settings.has(CODING_POLICY_SETTING_KEY)).toBe(false);
  });

  it("persists a valid document and returns the authoritative post-write state", async () => {
    healthyBridge();
    const runtime = makeRuntime();
    const res = response();
    await handleAgentRoutes(
      request("PUT", VALID),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(200);
    const payload = res.payload() as {
      policy: typeof VALID;
      readiness: { ready: boolean };
    };
    expect(payload.policy).toEqual(VALID);
    expect(payload.readiness).toBeDefined();
    expect(
      JSON.parse(runtime.getSetting(CODING_POLICY_SETTING_KEY) as string),
    ).toEqual(VALID);
  });

  it("translates a persistence failure into a structured 500 (J1)", async () => {
    healthyBridge();
    const runtime = makeRuntime({ throwOnSet: true });
    const res = response();
    await handleAgentRoutes(
      request("PUT", VALID),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(500);
  });

  it("blocks a pinned account on a provider with no connected accounts", async () => {
    const runtime = makeRuntime();
    const res = response();
    await handleAgentRoutes(
      request("PUT", {
        ...VALID,
        primary: {
          ...VALID.primary,
          accountId: "ghost",
        },
      }),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    expect(res.status()).toBe(400);
    const payload = res.payload() as {
      issues: Array<{ code: string; path: string }>;
    };
    expect(
      payload.issues.some(
        (issue) =>
          issue.code === "missing_account" &&
          issue.path === "primary.accountId",
      ),
    ).toBe(true);
  });
});

describe("writeCodingPolicy bridge fault tolerance (#24099)", () => {
  it("degrades to a non-blocking warning when the bridge describe() throws", async () => {
    setCodingAgentSelectorBridge({
      describe: () => {
        throw new Error("bridge down");
      },
      select: vi.fn(async () => null),
    } as never);
    const runtime = makeRuntime();
    const res = response();
    await handleAgentRoutes(
      request("PUT", {
        ...VALID,
        primary: { ...VALID.primary, accountId: "pinned" },
      }),
      res.res,
      "/api/coding-agents/policy",
      ctx(runtime),
    );
    // Transient bridge fault does not block the write (spawn-time check
    // is authoritative) — 200, not 400.
    expect(res.status()).toBe(200);
  });
});

describe("coding policy route registration (#24099)", () => {
  it("declares GET+PUT /api/coding-agents/policy in CODING_AGENT_ROUTE_PATHS so the runtime registry mounts them", async () => {
    const { CODING_AGENT_ROUTE_PATHS } = await import("../setup-routes.js");
    const declared = CODING_AGENT_ROUTE_PATHS.filter(
      (r) => r.path === "/api/coding-agents/policy",
    ).map((r) => r.type);
    expect(declared).toContain("GET");
    expect(declared).toContain("PUT");
    // GET must precede the /:agentId template in registration order or the
    // parameterized route shadows the static policy read.
    const agentIdIdx = CODING_AGENT_ROUTE_PATHS.findIndex(
      (r) => r.path === "/api/coding-agents/:agentId",
    );
    const policyGetIdx = CODING_AGENT_ROUTE_PATHS.findIndex(
      (r) => r.path === "/api/coding-agents/policy" && r.type === "GET",
    );
    expect(policyGetIdx).toBeGreaterThanOrEqual(0);
    expect(agentIdIdx).toBeGreaterThanOrEqual(0);
    expect(policyGetIdx).toBeLessThan(agentIdIdx);
  });
});
