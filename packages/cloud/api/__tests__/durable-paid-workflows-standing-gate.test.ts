/**
 * Proves the durable paid workflow routes (R2 storage list/presign/object
 * mutation, tunnel auth-key mint, domain purchase, credential-broker
 * user-OAuth) stop at the shared standing boundary before any pricing,
 * receipt, provider, or settlement work, and that an admitted caller keeps the
 * synchronous settlement path. Harness: real route modules over mocked
 * collaborators (deterministic, no Worker bindings).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";

const ORG = "00000000-0000-4000-8000-000000021045";
const USER = "00000000-0000-4000-8000-000000021044";

interface Caller {
  user: { id: string; organization_id: string };
  apiKeyId: string | null;
}

let standingDecision: "admit" | "deny" = "admit";
const standingReads: string[] = [];
const requireGenerativeRouteCaller = mock(async (): Promise<Caller> => {
  standingReads.push("resolve");
  if (standingDecision === "deny") {
    throw new ApiError(403, "access_denied", "Organization is inactive", {
      reason: "organization_inactive",
    });
  }
  return {
    user: { id: USER, organization_id: ORG },
    apiKeyId: null,
  };
});

// Shared event ledger proving provider/receipt suppression.
const events: string[] = [];
const record = (name: string) => {
  events.push(name);
  return name;
};

const getServiceMethodCost = mock(async () => 0.0001);

// Storage collaborators.
class TestNativeStorageReadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const executeNativeStorageList = mock(async () => {
  record("storage:list-dispatch");
  return {
    operation: { id: "op-list-1" },
    body: { items: [] },
  };
});
const executeNativeStoragePresign = mock(async () => {
  record("storage:presign-dispatch");
  return {
    status: 200 as const,
    operation: {
      id: "op-presign-1",
      capability_id: "cap-1",
      capability_issued_at: new Date(),
      capability_expires_at: new Date(Date.now() + 60_000),
    },
    body: {},
  };
});
const executeNativeStorageGetOrHead = mock(async () => {
  record("storage:get-dispatch");
  return {
    status: 200 as const,
    operation: { id: "op-get-1" },
    headers: {
      contentType: "application/octet-stream",
      size: 1,
      etag: "etag",
      lastModified: new Date().toUTCString(),
    },
    object: { body: new ArrayBuffer(1) },
  };
});
const executeNativeStoragePut = mock(async () => {
  record("storage:put-dispatch");
  return { ok: true };
});
const executeNativeStorageDelete = mock(async () => {
  record("storage:delete-dispatch");
});
const resolveNativeStorageObject = mock(async () => ({
  deleted_at: null,
  provider_key: "tenant/legacy",
}));
const ensureNativeStorageQuotaReconciled = mock(async () => {
  record("storage:quota-reconcile");
});

mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeRouteCaller,
}));

// Legacy auth modules used before the standing boundary existed. They are not
// imported by the guarded routes; mocking them keeps the RED control (routes
// reverted to plain auth) behavioral rather than a module-load failure.
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: USER,
    organization_id: ORG,
  })),
}));
mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: { id: USER, organization_id: ORG },
    apiKey: null,
  })),
}));

mock.module("@/lib/services/proxy/pricing", () => ({
  getServiceMethodCost,
}));

mock.module("@/lib/services/storage/native-storage-read", () => ({
  executeNativeStorageList,
  executeNativeStoragePresign,
  executeNativeStorageGetOrHead,
  NativeStorageReadError: TestNativeStorageReadError,
}));

mock.module("@/lib/services/storage/native-storage-put", () => ({
  executeNativeStoragePut,
  executeNativeStorageDelete,
  resolveNativeStorageObject,
  calculateStoragePutPrice: () => 0.0002,
  ensureNativeStorageQuotaReconciled,
  NativeStoragePutError: class NativeStoragePutError extends Error {
    code = "UNKNOWN";
  },
}));

mock.module("@/db/repositories", () => ({
  orgStorageMutationsRepository: { listObjects: mock(async () => []) },
  StoragePutConflictError: class StoragePutConflictError extends Error {},
  StorageQuotaExceededError: class StorageQuotaExceededError extends Error {},
}));

mock.module("@/lib/services/credits", () => ({
  creditsService: {
    deductCredits: mock(async () => {
      record("credits:deduct");
      return { success: true, newBalance: 100 };
    }),
    refundCredits: mock(async () => {
      record("credits:refund");
    }),
  },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));

mock.module("@/api-app/storage-read-capability", () => ({
  mintStorageReadCapabilityUrl: mock(async () => "https://cap.example/cap-1"),
  StorageReadCapabilityConfigurationError: class StorageReadCapabilityConfigurationError extends Error {},
  validateStorageReadCapabilityConfiguration: mock(() => "cap.example"),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Tunnel collaborators.
mock.module("@/lib/services/headscale-client", () => ({
  HeadscaleClient: class {
    apiUrl: string;
    constructor(init: { apiUrl: string }) {
      this.apiUrl = init.apiUrl;
    }
    async createPreAuthKey() {
      record("tunnel:headscale-dispatch");
      return { key: "tskey-auth-test" };
    }
  },
}));

// Domain-buy collaborators (minimal standing-focused set: the route must stop
// before appsService.getById — the first post-auth step).
const appsGetById = mock(async () => {
  record("domains:apps-getById");
  return { id: "app-1", organization_id: ORG, name: "Demo" };
});
mock.module("@/lib/services/apps", () => ({
  appsService: { getById: appsGetById },
}));

// Credential-broker collaborators.
const callProvider = mock(async () => {
  record("broker:callProvider");
  return { status: 200, body: "{}" };
});
const refreshToken = mock(async () => {
  record("broker:refreshToken");
  return { refreshed: false };
});
mock.module("@/lib/services/oauth", () => ({
  credentialBroker: { callProvider, refreshToken },
  internalErrorResponse: (message: string) => ({ error: message }),
  OAuthError: class OAuthError extends Error {
    httpStatus = 400;
    toResponse() {
      return { error: this.message };
    }
  },
}));

const rateLimitMiddleware = async (_c: unknown, next: () => Promise<void>) =>
  next();
mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: { CRITICAL: {}, STRICT: {} },
  moneyRateLimit: () => rateLimitMiddleware,
  rateLimit: () => rateLimitMiddleware,
}));

mock.module("@/lib/auth/app-key-scope", () => ({
  isAppKeyOutOfScope: mock(async () => false),
}));

// Import the real route modules after mocks are registered.
const [
  { default: storageListRoute },
  { default: storagePresignRoute },
  { default: storageObjectsRoute },
  { default: tunnelAuthKeyRoute },
  { default: domainsBuyRoute },
  { default: connectionsBrokerRoute },
  { default: connectionsRefreshRoute },
] = await Promise.all([
  import("../v1/apis/storage/list/route"),
  import("../v1/apis/storage/presign/route"),
  import("../v1/apis/storage/objects/[...key]/route"),
  import("../v1/apis/tunnels/tailscale/auth-key/route"),
  import("../v1/apps/[id]/domains/buy/route"),
  import("../v1/connections/[id]/broker/route"),
  import("../v1/connections/[id]/refresh/route"),
]);

const app = new Hono();
app.route("/api/v1/apis/storage/list", storageListRoute);
app.route("/api/v1/apis/storage/presign", storagePresignRoute);
app.route("/api/v1/apis/storage/objects", storageObjectsRoute);
app.route("/api/v1/apis/tunnels/tailscale/auth-key", tunnelAuthKeyRoute);
app.route("/api/v1/apps/:id/domains/buy", domainsBuyRoute);
app.route("/api/v1/connections/:id/broker", connectionsBrokerRoute);
app.route("/api/v1/connections/:id/refresh", connectionsRefreshRoute);

const ENV = {
  NODE_ENV: "test",
  RATE_LIMIT_DISABLED: "true",
  BLOB: {
    list: async () => ({ objects: [] }),
    head: async () => ({}),
    get: async () => ({ body: new ArrayBuffer(1) }),
  },
  R2_PUBLIC_HOST: "cap.example",
  HEADSCALE_API_URL: "https://headscale.example",
  HEADSCALE_PUBLIC_URL: "https://headscale.example",
  HEADSCALE_API_KEY: "test-key",
  TUNNEL_AUTH_KEY_COST_USD: "0.07",
};

function resetHarness() {
  events.length = 0;
  standingReads.length = 0;
  standingDecision = "admit";
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json();
  expect(typeof body).toBe("object");
  return body as Record<string, unknown>;
}

beforeEach(resetHarness);

describe("standing denial suppresses durable paid workflow dispatch", () => {
  beforeEach(() => {
    standingDecision = "deny";
  });

  test("storage list: one standing read, no receipt or R2 enumeration", async () => {
    const response = await app.request("/api/v1/apis/storage/list", {}, ENV);
    expect(response.status).toBe(403);
    await expect(jsonBody(response)).resolves.toMatchObject({
      code: "access_denied",
      details: { reason: "organization_inactive" },
    });
    expect(standingReads).toEqual(["resolve"]);
    expect(events).toEqual([]);
    expect(executeNativeStorageList).not.toHaveBeenCalled();
  });

  test("storage presign: no receipt or capability mint", async () => {
    const response = await app.request(
      "/api/v1/apis/storage/presign",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Storage-Object-Key": "voice/message.ogg",
        },
        body: JSON.stringify({ operation: "get" }),
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(executeNativeStoragePresign).not.toHaveBeenCalled();
  });

  test("storage PUT: no quota, receipt, or R2 write", async () => {
    const response = await app.request(
      "/api/v1/apis/storage/objects/_",
      {
        method: "PUT",
        headers: {
          "X-Storage-Object-Key": "voice/message.ogg",
          "X-Content-Length": "1",
          "X-Content-SHA256":
            "0000000000000000000000000000000000000000000000000000000000000000",
          "Content-Type": "application/octet-stream",
        },
        body: "x",
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(executeNativeStoragePut).not.toHaveBeenCalled();
  });

  test("storage GET: no receipt or provider read", async () => {
    const response = await app.request(
      "/api/v1/apis/storage/objects/_",
      {
        headers: { "X-Storage-Object-Key": "voice/message.ogg" },
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(executeNativeStorageGetOrHead).not.toHaveBeenCalled();
  });

  test("storage HEAD and DELETE: denied before provider access", async () => {
    const head = await app.request(
      "/api/v1/apis/storage/objects/_",
      { method: "HEAD", headers: { "X-Storage-Object-Key": "k" } },
      ENV,
    );
    expect(head.status).toBe(403);
    const del = await app.request(
      "/api/v1/apis/storage/objects/_",
      { method: "DELETE", headers: { "X-Storage-Object-Key": "k" } },
      ENV,
    );
    expect(del.status).toBe(403);
    expect(events).toEqual([]);
  });

  test("tunnel auth-key: no credit charge and no Headscale dispatch", async () => {
    const response = await app.request(
      "/api/v1/apis/tunnels/tailscale/auth-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(events.join()).not.toContain("credits:deduct");
  });

  test("domain buy: stops before app lookup, idempotency, ledger, registrar", async () => {
    const response = await app.request(
      "/api/v1/apps/app-1/domains/buy",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domain: "example.com" }),
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(appsGetById).not.toHaveBeenCalled();
  });

  test("credential broker: provider call suppressed", async () => {
    const response = await app.request(
      "/api/v1/connections/conn-1/broker",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "GET", url: "https://api.example/x" }),
      },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(callProvider).not.toHaveBeenCalled();
  });

  test("credential refresh: provider call suppressed", async () => {
    const response = await app.request(
      "/api/v1/connections/conn-1/refresh",
      { method: "POST" },
      ENV,
    );
    expect(response.status).toBe(403);
    expect(events).toEqual([]);
    expect(refreshToken).not.toHaveBeenCalled();
  });
});

describe("admitted caller retains the synchronous workflow path", () => {
  test("storage list dispatches and returns the receipt header", async () => {
    const response = await app.request("/api/v1/apis/storage/list", {}, ENV);
    expect(response.status).toBe(200);
    expect(standingReads).toEqual(["resolve"]);
    expect(events).toContain("storage:list-dispatch");
    expect(response.headers.get("X-Storage-Receipt-Id")).toBe("op-list-1");
  });

  test("tunnel auth-key charges and mints through Headscale", async () => {
    const response = await app.request(
      "/api/v1/apis/tunnels/tailscale/auth-key",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      ENV,
    );
    expect(response.status).toBe(200);
    expect(events).toContain("credits:deduct");
    expect(events).toContain("tunnel:headscale-dispatch");
    const body = await jsonBody(response);
    expect(body.authKey).toBe("tskey-auth-test");
  });

  test("credential broker forwards the provider result", async () => {
    const response = await app.request(
      "/api/v1/connections/conn-1/broker",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "GET", url: "https://api.example/x" }),
      },
      ENV,
    );
    expect(response.status).toBe(200);
    expect(events).toContain("broker:callProvider");
  });
});
