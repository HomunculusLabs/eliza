/**
 * GET /api/v1/billing/payment-states
 * Server-authoritative purchase payment states (receipts, refund/dispute
 * reversals) for the authenticated organization's billing history surface.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  decodePaymentStatesContinuation,
  paymentHistoryService,
} from "@/lib/services/payment-history";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";
import { parsePaginationParam } from "../../pagination";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const limitResult = parsePaginationParam(c.req.query("limit"), "limit", 50);
    if (!limitResult.ok) {
      return c.json({ success: false, error: limitResult.error }, 400);
    }
    // Traversal is lossless by design (#26752 review P1): the service's page
    // window is one SQL UNION ranked by the authority rows' own keys and
    // hydrates ONLY the page's rows, so page cost does not grow with offset
    // and an org's full persisted history must stay reachable from the list
    // surface. A depth cap would strand the tail behind a permanent 400 the
    // card cannot step past (its next offset is rows-already-shown), and the
    // detail route cannot repair discoverability because the client has no
    // id for rows it cannot list. Per-request work stays bounded by `limit`
    // (≤ PAYMENT_STATES_MAX_PAGE) and the route's rate limit.
    //
    // #30982: `continuation` selects the stable keyset traversal. A purchase
    // inserted concurrently no longer shifts any rank boundary, so pages can
    // neither duplicate nor omit rows. Malformed tokens are an explicit 400
    // (fail-closed), never a silent reset to the first page — the client's
    // rows-already-shown would then be permanently wrong.
    const continuationRaw = c.req.query("continuation");
    if (continuationRaw !== undefined) {
      if (continuationRaw.trim() === "") {
        return c.json(
          {
            success: false,
            error: "Invalid continuation: empty value",
          },
          400,
        );
      }
      const decoded = decodePaymentStatesContinuation(continuationRaw);
      if (!decoded.ok) {
        return c.json({ success: false, error: decoded.error }, 400);
      }
      const page = await paymentHistoryService.listPaymentStatesContinued(
        user.organization_id,
        decoded.value,
        limitResult.value,
      );
      return c.json({
        success: true,
        states: page.rows,
        nextContinuation: page.nextContinuation,
        hasMore: page.nextContinuation !== null,
      });
    }
    // Legacy offset path — preserved deliberately for existing offset
    // callers (#30982 acceptance): explicit `offset` keeps the exact
    // pre-#30982 contract (states + total + offset + offset-derived hasMore).
    const offsetResult = parsePaginationParam(
      c.req.query("offset"),
      "offset",
      0,
    );
    if (!offsetResult.ok) {
      return c.json({ success: false, error: offsetResult.error }, 400);
    }
    if (offsetResult.value > 0 || c.req.query("offset") !== undefined) {
      const [states, total] = await Promise.all([
        paymentHistoryService.listPaymentStates(
          user.organization_id,
          limitResult.value,
          offsetResult.value,
        ),
        paymentHistoryService.countPaymentStates(user.organization_id),
      ]);
      return c.json({
        success: true,
        states,
        total,
        offset: offsetResult.value,
        hasMore: offsetResult.value + states.length < total,
      });
    }
    const firstPage = await paymentHistoryService.listPaymentStatesFirstPage(
      user.organization_id,
      limitResult.value,
    );
    // `total` is the org's real persisted purchase count (both authority
    // surfaces), never the returned page's length — clients size "refresh"
    // affordances off it. The stable traversal's hasMore comes from the
    // limit+1 probe, not this racy total.
    const total = await paymentHistoryService.countPaymentStates(
      user.organization_id,
    );
    return c.json({
      success: true,
      states: firstPage.rows,
      total,
      nextContinuation: firstPage.nextContinuation,
      hasMore: firstPage.nextContinuation !== null,
    });
  } catch (error) {
    // error-policy:J1 boundary translation: the transport boundary returns a
    // structured failure instead of leaking the raw service error.
    logger.error(
      "[Billing Payment States API] Error listing payment states",
      error,
    );
    return failureResponse(c, error);
  }
});

export default app;
