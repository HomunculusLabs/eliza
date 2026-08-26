/**
 * Server-owned coding policy store: the one validated write path for the
 * unified backend/provider/account/model/fallback/approval document (#24099).
 *
 * Persistence uses the runtime character settings map (non-env, non-secret,
 * survives restart via the character document) under the stable
 * {@link CODING_POLICY_SETTING_KEY}. The service layers server-side authority
 * checks on top of the shared syntactic validator: an account referenced by a
 * route must actually exist in the live account bridge, and route providers
 * must be spawn-capable per the canonical capability resolver. Readiness is
 * derived per-route (backend spawn capability + pooled account health) and
 * returned alongside the policy — never persisted into it.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { ElizaError, logger } from "@elizaos/core";
import {
  CODING_POLICY_SETTING_KEY,
  type CodingAgentBackend,
  type CodingPolicy,
  type CodingPolicyIssue,
  type CodingPolicyRoute,
  codingProviderDescriptorForProvider,
  validateCodingPolicy,
} from "@elizaos/shared";
import { getCodingAccountBridge } from "./coding-account-selection.js";

export interface CodingPolicyRouteHealth {
  route: CodingPolicyRoute;
  /** Descriptor-level spawn capability for the route's provider. */
  spawnable: boolean;
  /** Canonical billing mode derived from the provider descriptor. */
  billingMode: string | null;
  /** Pooled account counts when the route references a pooled provider. */
  account?: {
    providerId: string;
    total: number;
    enabled: number;
    healthy: number;
    /** Present when the route pins a specific account id: whether the
     * provider's pool has ANY account. The bridge exposes pool counts, not
     * ids — the specific pin is verified at spawn time (fails closed). */
    poolHasAccounts?: boolean;
    /** Pin-resolution status for an accountId-bearing route. Aggregate pool
     * counts say nothing about the PINNED account (review r3, finding 5):
     * `ghost` — enumerated ids prove the pin does not exist (not ok);
     * `verified` — enumerated ids contain the pin (existence proven; health
     *   remains a spawn-time concern, selection fails closed);
     * `unverifiable` — the bridge cannot enumerate; existence is decided at
     *   spawn time (fails closed), and the route must not be presented as
     *   confirmed-healthy off sibling-account counts. */
    pinStatus?: "ghost" | "verified" | "unverifiable";
  };
  ok: boolean;
  problems: string[];
}

export interface CodingPolicyReadiness {
  /** True when at least one configured route is currently usable. */
  ready: boolean;
  /** Route-level detail in policy order (primary first). */
  routes: CodingPolicyRouteHealth[];
  /** Human-readable problems across routes (empty when ready). */
  problems: string[];
  /** The first currently-usable backend, if any. */
  effectiveBackend?: string;
}

export interface CodingPolicyLoadResult {
  /** Persisted policy, null when none is set. */
  policy: CodingPolicy | null;
  /** Non-fatal issues seen while loading a stored document. */
  issues: CodingPolicyIssue[];
}

/** Read the persisted policy without side effects. */
export function loadCodingPolicy(
  runtime: IAgentRuntime,
): CodingPolicyLoadResult {
  const raw = runtime.getSetting(CODING_POLICY_SETTING_KEY);
  if (typeof raw !== "string" || raw.trim() === "") {
    return { policy: null, issues: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a corrupt stored document
    // is surfaced as an explicit invalid result (repairable via PUT), never
    // fabricated into a healthy-looking default policy.
    return {
      policy: null,
      issues: [
        {
          path: "",
          code: "invalid_type",
          message:
            "Stored coding policy is not valid JSON; it was ignored. Re-write the policy to repair it.",
        },
      ],
    };
  }
  const { policy, issues } = validateCodingPolicy(parsed);
  return { policy, issues };
}

/** Authority checks the shared validator cannot perform (live account pool). */
function authorityIssuesForRoute(
  _runtime: IAgentRuntime,
  route: CodingPolicyRoute,
  path: string,
): CodingPolicyIssue[] {
  const issues: CodingPolicyIssue[] = [];
  // Provider-level authority only applies to routes that pin an account.
  if (route.accountId === undefined) return issues;
  const bridge = getCodingAccountBridge();
  if (!bridge) {
    issues.push({
      path: `${path}.accountId`,
      code: "missing_account",
      message: `Route pins account "${route.accountId}" but no account bridge is available; the pin is verified at spawn time, which fails closed.`,
    });
    return issues;
  }
  try {
    // ID-level verification when the producer can enumerate accounts: a
    // ghost pin is rejected here instead of persisting a "validated"
    // document referencing a nonexistent account (review r2 finding 2).
    // Minimal producers without accountIds degrade to the provider-level
    // pool check below; spawn-time selection stays authoritative either way.
    let enumerable = false;
    if (typeof bridge.accountIds === "function") {
      // `undefined` is the bridge's documented "enumeration unsupported (for
      // this provider)" signal, not an empty pool: only a defined result
      // proves enumeration, and only an EMPTY defined result proves the
      // provider has no accounts (review r3, undefined-degrade finding).
      const ids = bridge.accountIds(route.providerId);
      if (ids !== undefined) {
        enumerable = true;
        if (!ids.includes(route.accountId)) {
          issues.push({
            path: `${path}.accountId`,
            code: "missing_account",
            message: `No account "${route.accountId}" exists for provider "${route.providerId}"; connect it through Accounts or pin one of: ${ids.join(", ") || "(none connected)"}.`,
          });
          return issues;
        }
      }
    }
    // Provider-level pool check (the only check a minimal bridge can make).
    const availability = bridge.describe()[route.backend] ?? [];
    const row = availability.find(
      (entry) => entry.providerId === route.providerId,
    );
    if (!row || row.total === 0) {
      issues.push({
        path: `${path}.accountId`,
        code: "missing_account",
        message: `No connected account for provider "${route.providerId}" (backend "${route.backend}"); connect one through Accounts.${
          enumerable
            ? ""
            : " The specific pin is verified at spawn time, which fails closed."
        }`,
      });
      return issues;
    }
  } catch (error) {
    // error-policy:J4 user-facing degrade — the bridge failing its describe
    // pass must not block a policy write on a transient fault; the account
    // pin is validated again at spawn time where selection is authoritative.
    logger.warn(
      `[coding-policy] account bridge describe failed during validation of ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return issues;
}

export interface CodingPolicyWriteResult {
  policy: CodingPolicy | null;
  issues: CodingPolicyIssue[];
}

/**
 * The one atomic write path: strict validation (shared syntactic layer +
 * descriptor checks + account authority), then persistence via
 * `runtime.setSetting`. Returns the authoritative post-write state — never a
 * bare success boolean, so callers cannot report success while the stored
 * document differs from the request.
 */
export function writeCodingPolicy(
  runtime: IAgentRuntime,
  candidate: unknown,
): CodingPolicyWriteResult {
  const { policy, issues } = validateCodingPolicy(candidate);
  if (!policy) {
    return { policy: null, issues };
  }
  const authority: CodingPolicyIssue[] = [
    ...authorityIssuesForRoute(runtime, policy.primary, "primary"),
    ...policy.fallbacks.flatMap((route, i) =>
      authorityIssuesForRoute(runtime, route, `fallbacks[${i}]`),
    ),
  ];
  // Authority issues block the write only when the pinned account provably
  // does not exist; transient bridge faults degrade to a warning above.
  const blocking = authority.filter(
    (issue) => issue.code === "missing_account",
  );
  if (blocking.length > 0) {
    return { policy: null, issues: [...issues, ...authority] };
  }
  try {
    runtime.setSetting(CODING_POLICY_SETTING_KEY, JSON.stringify(policy));
  } catch (error) {
    // error-policy:J2 context-adding rethrow — persistence failures are a
    // coded, actionable error for the PUT boundary to translate, never a
    // silent no-op that would let a "validated" write vanish.
    throw new ElizaError("Failed to persist the coding policy", {
      code: "CODING_POLICY_PERSIST_FAILED",
      context: { settingKey: CODING_POLICY_SETTING_KEY },
      cause: error,
      severity: "fatal",
    });
  }
  return { policy, issues: [...issues, ...authority] };
}

/** Derive per-route health for the persisted (or given) policy. */
export function assessCodingPolicyReadiness(
  _runtime: IAgentRuntime,
  policy: CodingPolicy,
): CodingPolicyReadiness {
  const bridge = getCodingAccountBridge();
  const availability = (() => {
    try {
      return bridge?.describe() ?? null;
    } catch {
      // error-policy:J4 user-facing degrade — readiness reports the routes as
      // unverifiable rather than crashing the settings surface.
      return null;
    }
  })();
  const routes: CodingPolicyRouteHealth[] = [];
  const problems: string[] = [];
  let effectiveBackend: string | undefined;
  for (const [route, path] of [
    [policy.primary, "primary"] as const,
    ...policy.fallbacks.map((r, i) => [r, `fallbacks[${i}]`] as const),
  ]) {
    const descriptor = codingProviderDescriptorForProvider(route.providerId);
    const routeProblems: string[] = [];
    const spawnable =
      descriptor?.spawnSupport === true && descriptor.backend !== null;
    if (!descriptor) {
      routeProblems.push(`Unknown provider "${route.providerId}".`);
    } else if (!spawnable) {
      routeProblems.push(
        descriptor.unsupportedReason ??
          `Provider "${route.providerId}" has no spawn backend.`,
      );
    }
    let account: CodingPolicyRouteHealth["account"];
    if (descriptor?.accountKind === "subscription") {
      const rows = availability?.[route.backend] ?? [];
      const row = rows.find((entry) => entry.providerId === route.providerId);
      account = row
        ? {
            providerId: route.providerId,
            total: row.total,
            enabled: row.enabled,
            healthy: row.healthy,
            ...(route.accountId !== undefined
              ? { poolHasAccounts: row.total > 0 }
              : {}),
          }
        : {
            providerId: route.providerId,
            total: 0,
            enabled: 0,
            healthy: 0,
          };
      if (route.accountId !== undefined) {
        // Pin-level honesty (review r3, finding 5): aggregate `healthy` counts
        // describe the PROVIDER's pool, never the pinned account. Resolve the
        // pin itself when the bridge can enumerate; a proven ghost is a
        // blocking problem, an existing pin is verified-but-health-unknown,
        // and an unenumerable bridge reports the pin as unverifiable — never
        // as confirmed-usable off a sibling account's health.
        let ids: string[] | undefined;
        try {
          ids =
            typeof bridge?.accountIds === "function"
              ? bridge.accountIds(route.providerId)
              : undefined;
        } catch {
          // error-policy:J4 user-facing degrade — enumeration failing reads
          // as "unverifiable", matching a bridge without the accessor.
          ids = undefined;
        }
        if (ids === undefined) {
          account.pinStatus = "unverifiable";
          routeProblems.push(
            `Pinned account "${route.accountId}" cannot be verified against the live pool; it is checked at spawn time, which fails closed.`,
          );
        } else if (!ids.includes(route.accountId)) {
          account.pinStatus = "ghost";
          routeProblems.push(
            `Pinned account "${route.accountId}" does not exist for provider "${route.providerId}"; reconnect it or pin one of: ${ids.join(", ") || "(none connected)"}.`,
          );
        } else {
          // Existence is proven, but the bridge exposes no per-account health:
          // aggregate sibling health must not certify the PIN as usable (r4
          // finding 2). The route stays not-ok with an explicit pin-level
          // caveat; spawn-time selection remains the health authority.
          account.pinStatus = "verified";
          routeProblems.push(
            `Pinned account "${route.accountId}" exists but per-account health is not observable; usability is decided at spawn time, which fails closed.`,
          );
        }
        if (account.healthy === 0) {
          routeProblems.push(
            `No healthy pooled account for provider "${route.providerId}" (backend "${route.backend}").`,
          );
        }
      } else if (account.healthy === 0) {
        routeProblems.push(
          `No healthy pooled account for provider "${route.providerId}" (backend "${route.backend}").`,
        );
      }
    }
    const ok = routeProblems.length === 0;
    if (!ok) {
      for (const problem of routeProblems) {
        problems.push(`${path}: ${problem}`);
      }
    } else if (effectiveBackend === undefined) {
      effectiveBackend = route.backend;
    }
    routes.push({
      route,
      spawnable,
      billingMode: descriptor?.billingMode ?? null,
      ...(account !== undefined ? { account } : {}),
      ok,
      problems: routeProblems,
    });
  }
  return {
    ready: routes.some((route) => route.ok),
    routes,
    problems,
    ...(effectiveBackend !== undefined ? { effectiveBackend } : {}),
  };
}

/**
 * The validated spawn backend for pinned-adapter routing: the policy's
 * PRIMARY route, and only when the whole stored document passes strict
 * validation — a document whose fallbacks or preset are invalid is not a
 * policy in force, and routing must not cherry-pick its primary while
 * GET /policy reports the same document as broken (review r1, finding 3).
 * Returns null when no valid policy exists; callers then fall to legacy
 * env keys. Benchmark overrides stay above policy — see task-agent-routing.
 */
export function resolveCodingPolicyPrimaryBackend(
  runtime: IAgentRuntime,
): CodingAgentBackend | null {
  const { policy } = loadCodingPolicy(runtime);
  if (!policy) return null;
  return policy.primary.backend;
}

/**
 * Spawn-time consumption of the unified policy (#24099, review r3 finding 3):
 * the whole-document-validated policy steers the spawn's approval preset,
 * model, and account selection — not just the routing backend pin. Returns
 * null when no whole-valid policy exists (legacy defaults remain in force).
 *
 * `candidateRoutes` returns the policy routes whose backend matches the
 * spawn's agentType, in policy order (primary first, then fallbacks): the
 * spawn walks them exactly like readiness does, pinning to each route's
 * accountId when set and letting ordered fallback carry to the next route
 * when a pin is not selectable. Callers keep their own strategy/env patch
 * merge; this function is pure policy resolution, no bridge side effects.
 */
export interface CodingPolicySpawnPin {
  /** Policy routes matching the spawn backend, in policy order. */
  routes: CodingPolicyRoute[];
  /** Approval preset from the validated policy document. */
  approvalPreset: string;
  /** Model from the first route that carries one, in policy order. */
  model: string | undefined;
}

export function resolveCodingPolicySpawnPin(
  runtime: IAgentRuntime,
  backend: string,
): CodingPolicySpawnPin | null {
  const { policy } = loadCodingPolicy(runtime);
  if (!policy) return null;
  const routes = [policy.primary, ...policy.fallbacks].filter(
    (route) => route.backend === backend,
  );
  return {
    routes,
    approvalPreset: policy.approvalPreset,
    model: routes.find((route) => route.model !== undefined)?.model,
  };
}
