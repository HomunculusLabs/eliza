/**
 * Brokered provider-call endpoint for first-party plugins.
 *
 * POST /api/v1/connections/:id/broker executes one provider API request using
 * the credential behind an opaque connection ID. Inbound Eliza auth/cookies
 * are never forwarded upstream: the broker builds the provider request from
 * the validated JSON body and injects the provider credential server-side.
 * Raw token material never appears in the response.
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

interface BrokerRequestBody {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

function parseBrokerBody(raw: unknown): BrokerRequestBody | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.method !== "string" || typeof candidate.url !== "string")
    return null;
  if (candidate.body !== undefined && typeof candidate.body !== "string")
    return null;
  if (candidate.headers !== undefined) {
    if (
      !candidate.headers ||
      typeof candidate.headers !== "object" ||
      Array.isArray(candidate.headers)
    ) {
      return null;
    }
    for (const value of Object.values(
      candidate.headers as Record<string, unknown>,
    )) {
      if (typeof value !== "string") return null;
    }
  }
  return {
    method: candidate.method,
    url: candidate.url,
    headers: candidate.headers as Record<string, string> | undefined,
    body: candidate.body as string | undefined,
  };
}

type StandingCaller = Awaited<ReturnType<typeof requireGenerativeRouteCaller>>;

async function __hono_POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  caller: StandingCaller,
) {
  const { id: connectionId } = await params;
  let organizationId: string | undefined;

  try {
    const { user } = caller;
    organizationId = user.organization_id;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      // error-policy:J3 untrusted-input sanitizing — malformed JSON becomes an
      // explicit 400, never a pass-through default.
      return Response.json(
        { error: "Request body must be valid JSON" },
        { status: 400 },
      );
    }

    const body = parseBrokerBody(rawBody);
    if (!body) {
      return Response.json(
        {
          error:
            "Body must include string `method` and `url`; `headers`/`body` optional",
        },
        { status: 400 },
      );
    }

    const result = await credentialBroker.callProvider({
      organizationId,
      userId: user.id,
      connectionId,
      request: body,
    });

    return Response.json(result);
  } catch (error) {
    if (error instanceof ApiError) {
      return Response.json(error.toJSON(), { status: error.status });
    }
    if (error instanceof OAuthError) {
      return Response.json(error.toResponse(), { status: error.httpStatus });
    }
    logger.error("[API] POST /api/v1/connections/:id/broker error", {
      organizationId,
      connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      internalErrorResponse("Brokered provider request failed"),
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
