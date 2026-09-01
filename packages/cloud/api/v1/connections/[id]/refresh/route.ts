/**
 * Brokered token refresh endpoint for first-party plugins.
 *
 * POST /api/v1/connections/:id/refresh revalidates or refreshes the credential
 * behind an opaque connection ID and returns token metadata only (expiry,
 * scopes, whether a refresh happened). Raw token material is never exposed.
 *
 * Standing admission runs before the brokered provider call: one combined
 * cache read (cold continuation consumed inline), provider suppressed for a
 * denied account.
 */

import { Hono } from "hono";

import { requireGenerativeRouteCaller } from "@/api-app/lib/generative-route-auth";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { ApiError } from "@/lib/api/errors";
import {
  credentialBroker,
  internalErrorResponse,
  OAuthError,
} from "@/lib/services/oauth";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

type StandingCaller = Awaited<ReturnType<typeof requireGenerativeRouteCaller>>;

async function __hono_POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
  caller: StandingCaller,
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;

  try {
    const { user } = caller;
    organizationId = user.organization_id;

    const result = await credentialBroker.refreshToken({
      organizationId,
      userId: user.id,
      connectionId,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }
    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), { status: error.httpStatus });
    }
    logger.error("[API] POST /api/v1/connections/:id/refresh error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      internalErrorResponse("Connection token refresh failed"),
      {
        status: 500,
      },
    );
  }
}

const __hono_app = new Hono<AppEnv>();
__hono_app.post("/", async (c) => {
  let caller: StandingCaller;
  try {
    caller = await requireGenerativeRouteCaller(c, { compatibility: "raw" });
  } catch (error) {
    // error-policy:J1 transport boundary maps standing denials to the bounded
    // API contract before the credential-broker provider call. Standing
    // denials throw the cloud-worker ApiError — a different class from the
    // broker's own @/lib/api/errors ApiError handled in __hono_POST.
    return failureResponse(c, error);
  }
  return __hono_POST(
    c.req.raw,
    { params: Promise.resolve({ id: c.req.param("id")! }) },
    caller,
  );
});
export default __hono_app;
