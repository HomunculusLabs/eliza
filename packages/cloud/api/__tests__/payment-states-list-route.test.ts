/**
 * GET /api/v1/billing/payment-states contract tests (#26752 lossless
 * history, #30982 stable traversal): offset/limit parsing, the
 * bounded-offset guard, real total (never the page length), hasMore
 * arithmetic, exact service-argument forwarding, the server-owned
 * continuation envelope, and fail-closed 400s on malformed continuation
 * tokens. Auth middleware is stubbed to a fixed org; the route module is
 * real; the service is a mock returning real-shaped rows.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import * as authActual from "@/lib/auth/workers-hono-auth";
import * as rateLimitActual from "@/lib/middleware/rate-limit-hono-cloudflare";
import * as paymentHistoryActual from "@/lib/services/payment-history";

const ORG_A = "11111111-1111-4111-8111-111111111111";

const sampleRow = (id: string) => ({
  id,
  surface: "checkout_order",
  authorityId: id.split(":")[1] ?? "",
  receiptId: null,
  provider: "stripe",
  amountCents: 2500,
  currency: "USD",
  eventTime: "2026-08-23T12:00:00.000Z",
  eventTimeKind: "provider_settlement",
  paymentState: "succeeded",
  cumulativeRefundedChargeCurrency: 0,
  cumulativeDisputedChargeCurrency: 0,
  cumulativeClawbackCredits: 0,
  reinstatedCredits: 0,
  unrecoveredShortfallCredits: 0,
  disputeReinstated: false,
  policyEffect: null,
  supportState: "none",
});

// Page-shaped fake: rows 0..count-1 keyed "checkout_order:o<i>".
let fakeTotal = 0;
const listPaymentStates = mock(
  async (_organizationId: string, limit: number, offset: number) => {
    const rows: Array<ReturnType<typeof sampleRow>> = [];
    for (let i = offset; i < Math.min(offset + limit, fakeTotal); i++) {
      rows.push(sampleRow(`checkout_order:o${i}`));
    }
    return rows;
  },
);
const countPaymentStates = mock(async () => fakeTotal);

// #30982: first-page + continuation mocks. The fake traversal pages
// 50 rows at a time in the same id order the offset fake uses.
let fakeFirstPage: {
  rows: Array<ReturnType<typeof sampleRow>>;
  nextContinuation: string | null;
} = { rows: [], nextContinuation: null };
const listPaymentStatesFirstPage = mock(async () => fakeFirstPage);
const listPaymentStatesContinued = mock(
  async (
    _organizationId: string,
    _continuation: unknown,
    limit: number,
  ) => {
    // Deterministic page keyed by call order: continuation mocks continue
    // the fake traversal (page N rows) with one row less each call.
    const callIndex = listPaymentStatesContinued.mock.calls.length - 1;
    const rows = Array.from({ length: Math.min(limit, fakeTotal - callIndex * 50 - 50) }, (_, i) =>
      sampleRow(`checkout_order:c${callIndex}-${i}`),
    );
    const hasMore = callIndex * 50 + 50 + rows.length < fakeTotal;
    return {
      rows: rows.map((r) => r),
      nextContinuation: hasMore
        ? paymentHistoryActual.encodePaymentStatesContinuation({
            createdAtMicros: 1_772_659_261_000_000 + callIndex,
            surface: "checkout_order",
            id: `cont-${callIndex}`,
          })
        : null,
    };
  },
);

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  ...rateLimitActual,
  RateLimitPresets: { STANDARD: {}, STRICT: {} },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...authActual,
  requireUserOrApiKeyWithOrg: async () => ({
    organization_id: ORG_A,
  }),
}));

mock.module("@/lib/services/payment-history", () => ({
  ...paymentHistoryActual,
  paymentHistoryService: {
    listPaymentStates,
    countPaymentStates,
    listPaymentStatesFirstPage,
    listPaymentStatesContinued,
  },
}));

const listRoute = (await import("../v1/billing/payment-states/route")).default;
const app = new Hono().route("/api/v1/billing/payment-states", listRoute);

afterAll(() => {
  mock.module(
    "@/lib/middleware/rate-limit-hono-cloudflare",
    () => rateLimitActual,
  );
  mock.module("@/lib/auth/workers-hono-auth", () => authActual);
  mock.module("@/lib/services/payment-history", () => paymentHistoryActual);
});

beforeEach(() => {
  fakeTotal = 0;
  fakeFirstPage = { rows: [], nextContinuation: null };
  listPaymentStates.mockClear();
  countPaymentStates.mockClear();
  listPaymentStatesFirstPage.mockClear();
  listPaymentStatesContinued.mockClear();
});

async function list(query: string) {
  return app.request(`/api/v1/billing/payment-states${query}`, {
    method: "GET",
  });
}

describe("GET /api/v1/billing/payment-states (legacy offset contract preserved)", () => {
  test("forwards parsed limit/offset to the service and reports the REAL total", async () => {
    fakeTotal = 240;
    const res = await list("?limit=200&offset=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      states: Array<{ id: string }>;
      total: number;
      offset: number;
      hasMore: boolean;
    };
    expect(body.success).toBe(true);
    expect(listPaymentStates).toHaveBeenCalledWith(ORG_A, 200, 200);
    // total is the org's persisted count, NOT states.length — the page-2
    // response still reports 240.
    expect(body.total).toBe(240);
    expect(body.states.length).toBe(40);
    expect(body.offset).toBe(200);
    expect(body.hasMore).toBe(false);
  });

  test("rejects non-canonical limit and offset values with 400", async () => {
    for (const bad of [
      "?limit=0",
      "?limit=-5",
      "?limit=abc",
      "?offset=1.5",
      "?offset=-1",
      "?offset=0x10",
    ]) {
      const res = await list(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("Invalid");
    }
    expect(listPaymentStates).not.toHaveBeenCalled();
  });

  test("traversal is lossless: offsets beyond the former 10,000 bound are served, not rejected (#26752 P1)", async () => {
    const res = await list("?offset=10050");
    expect(res.status).toBe(200);
    expect(listPaymentStates).toHaveBeenCalledWith(
      expect.anything(),
      50,
      10050,
    );
    const body = (await res.json()) as { success: boolean; offset: number };
    expect(body.success).toBe(true);
    expect(body.offset).toBe(10050);
    const boundary = await list("?offset=10000");
    expect(boundary.status).toBe(200);
    const past = await list("?offset=20000");
    expect(past.status).toBe(200);
    const pastBody = (await past.json()) as {
      states: unknown[];
      hasMore: boolean;
    };
    expect(pastBody.states).toEqual([]);
    expect(pastBody.hasMore).toBe(false);
  });
});

describe("GET /api/v1/billing/payment-states (stable traversal, #30982)", () => {
  test("default first page returns the continuation envelope with limit+1 hasMore", async () => {
    fakeTotal = 120;
    fakeFirstPage = {
      rows: Array.from({ length: 50 }, (_, i) => sampleRow(`checkout_order:o${i}`)),
      nextContinuation: paymentHistoryActual.encodePaymentStatesContinuation({
        createdAtMicros: 1_772_659_261_000_000,
        surface: "checkout_order",
        id: "o49",
      }),
    };
    const res = await list(""); // no params: first page of the stable traversal
    expect(res.status).toBe(200);
    expect(listPaymentStatesFirstPage).toHaveBeenCalledWith(ORG_A, 50);
    expect(listPaymentStates).not.toHaveBeenCalled();
    const body = (await res.json()) as {
      success: boolean;
      states: unknown[];
      total: number;
      hasMore: boolean;
      nextContinuation: string | null;
    };
    expect(body.success).toBe(true);
    expect(body.states.length).toBe(50);
    expect(body.total).toBe(120);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextContinuation).toBe("string");
  });

  test("continuation pages call listPaymentStatesContinued with the DECODED token and limit", async () => {
    fakeTotal = 120;
    const token = paymentHistoryActual.encodePaymentStatesContinuation({
      createdAtMicros: 1_772_659_261_000_042,
      surface: "payment_request",
      id: "req-1",
    });
    const res = await list(`?continuation=${token}`);
    expect(res.status).toBe(200);
    expect(listPaymentStatesContinued).toHaveBeenCalledWith(
      ORG_A,
      { createdAtMicros: 1_772_659_261_000_042, surface: "payment_request", id: "req-1" },
      50,
    );
    const body = (await res.json()) as {
      success: boolean;
      states: unknown[];
      hasMore: boolean;
    };
    expect(body.success).toBe(true);
    // Continuation responses carry no racy total — hasMore comes from the
    // limit+1 probe via nextContinuation.
    expect("total" in body).toBe(false);
    expect(body.states.length).toBeGreaterThan(0);
  });

  test("malformed continuation tokens fail closed with 400, never a silent reset", async () => {
    for (const bad of [
      "?continuation=",
      "?continuation=!!!not-base64!!!",
      `?continuation=${Buffer.from("not json").toString("base64url")}`,
      `?continuation=${Buffer.from('{"c":1,"s":"bogus","i":"x"}').toString("base64url")}`,
    ]) {
      const res = await list(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/^Invalid continuation/);
    }
    expect(listPaymentStatesContinued).not.toHaveBeenCalled();
    expect(listPaymentStatesFirstPage).not.toHaveBeenCalled();
    expect(listPaymentStates).not.toHaveBeenCalled();
  });

  test("explicit ?offset=0 keeps the exact legacy envelope (offset callers unaffected)", async () => {
    fakeTotal = 3;
    const res = await list("?offset=0");
    expect(res.status).toBe(200);
    expect(listPaymentStates).toHaveBeenCalledWith(ORG_A, 50, 0);
    const body = (await res.json()) as {
      states: unknown[];
      total: number;
      offset: number;
      hasMore: boolean;
      nextContinuation?: unknown;
    };
    expect(body.offset).toBe(0);
    expect(body.total).toBe(3);
    expect("nextContinuation" in body).toBe(false);
  });
});
