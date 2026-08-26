/**
 * Verifies the Shared catch-all's LifeOps calendar capability gate: every
 * calendar HTTP method answers the typed `calendar_runtime_unavailable` 503
 * instead of the generic 404, the upgrade pointer targets the real
 * upgrade-tier endpoint, non-calendar unknown paths stay 404, and CORS
 * preflight advertises PATCH. Real route module mounted on a real Hono
 * router; the resolver, adapter, and CORS helpers are deterministic fakes
 * (same harness shape as route.auth-status.test.ts).
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "cccccccc-4444-4444-8444-444444444444";

mock.module("@/lib/mobile-push/types", () => ({
  MAX_MOBILE_PUSH_TOKEN_CHARACTERS: 4096,
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  // Real signature: (methods, origin) — echo the method list on a probe header.
  handleCorsOptions: (methods: string, _origin: string | undefined) =>
    new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Methods": methods },
    }),
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedPushList: async () => [],
  coordinateSharedPushRegister: async () => ({}),
  coordinateSharedPushUnregister: async () => ({}),
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent: async () => ({
    agent: {
      id: AGENT,
      organization_id: "org-1",
      user_id: "user-1",
      agent_name: "Eliza",
      execution_tier: "shared",
    },
    agentId: AGENT,
    orgId: "org-1",
    agentName: "Eliza",
    agentKind: "sandbox",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  resolveSharedRuntimeWorkerRequestContext: () => ({
    error: "unavailable",
    status: 503,
  }),
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestAgentEvents: () => ({}),
  sharedRestAgentStart: () => ({}),
  sharedRestAuthMe: () => ({}),
  sharedRestAuthStatus: () => ({}),
  sharedRestCharacter: () => ({}),
  sharedRestCommands: () => ({}),
  sharedRestConfig: () => ({}),
  sharedRestCustomActions: () => ({}),
  sharedRestFirstRun: () => ({}),
  sharedRestFirstRunStatus: () => ({}),
  sharedRestFirstRunSubmit: () => ({}),
  sharedRestGreeting: () => ({}),
  sharedRestOverlayPresence: () => ({}),
  sharedRestRuntimeMode: () => ({}),
  sharedRestStatus: () => ({}),
  sharedRestStreamSettings: () => ({}),
  sharedRestViewNavigate: () => ({}),
  sharedRestViews: () => ({}),
}));
mock.module("../../workflows/_shared", () => ({
  workflowRuntimeUnavailableResponse: () =>
    Response.json({ success: false }, { status: 409 }),
}));

const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", route);
const ENV = {
  ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
} as unknown as AppEnv["Bindings"];

function baseUrl(): string {
  return `http://cloud.local/api/v1/eliza/agents/${AGENT}/api`;
}

async function calendarGateResponse(
  method: string,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await app.request(
    `${baseUrl()}/${path}`,
    {
      method,
      headers: {
        "X-API-Key": "eliza_test",
        "Content-Type": "application/json",
      },
      body: ["GET", "DELETE"].includes(method) ? undefined : "{}",
    },
    ENV,
  );
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("Shared catch-all LifeOps calendar capability gate", () => {
  test("GET lifeops/calendar/feed answers the typed 503", async () => {
    const { status, body } = await calendarGateResponse(
      "GET",
      "lifeops/calendar/feed?side=owner",
    );
    expect(status).toBe(503);
    expect(body.code).toBe("calendar_runtime_unavailable");
    expect(body.capability).toBe("lifeops-calendar");
    expect(body.requiredExecutionTier).toBe("dedicated-always");
    expect(body.upgradeRequired).toBe(true);
    const upgrade = body.upgrade as { endpoint: string };
    expect(upgrade.endpoint).toBe(`/api/v1/eliza/agents/${AGENT}/upgrade-tier`);
    // Deliberately not retryable — the capability cannot appear on this tier.
    expect(body.retryable).toBeUndefined();
  });

  test("every calendar route family and method answers the gate", async () => {
    const cases: Array<[string, string]> = [
      ["GET", "lifeops/calendar/calendars"],
      ["GET", "lifeops/calendar/sources"],
      ["POST", "lifeops/calendar/sources"],
      ["PATCH", "lifeops/calendar/sources/src-1"],
      ["DELETE", "lifeops/calendar/sources/src-1"],
      ["POST", "lifeops/calendar/sources/src-1/sync"],
      ["GET", "lifeops/calendar/next-context"],
      ["POST", "lifeops/calendar/events"],
      ["PATCH", "lifeops/calendar/events/evt-1"],
      ["DELETE", "lifeops/calendar/events/evt-1"],
      ["PUT", "lifeops/calendar/calendars/primary/include"],
      ["GET", "lifeops/calendar/meeting-auto-join"],
      ["PUT", "lifeops/calendar/meeting-auto-join"],
    ];
    for (const [method, path] of cases) {
      const { status, body } = await calendarGateResponse(method, path);
      expect(status, `${method} ${path}`).toBe(503);
      expect(body.code, `${method} ${path}`).toBe(
        "calendar_runtime_unavailable",
      );
    }
  });

  test("a non-calendar unknown path stays a 404", async () => {
    const { status, body } = await calendarGateResponse(
      "GET",
      "lifeops/unknown-endpoint",
    );
    expect(status).toBe(404);
    expect(body.code).toBe("resource_not_found");
  });

  test("CORS preflight advertises PATCH", async () => {
    const response = await app.request(
      `${baseUrl()}/lifeops/calendar/events/evt-1`,
      {
        method: "OPTIONS",
        headers: { Origin: "https://app.example", "X-API-Key": "eliza_test" },
      },
      ENV,
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain(
      "PATCH",
    );
  });
});
