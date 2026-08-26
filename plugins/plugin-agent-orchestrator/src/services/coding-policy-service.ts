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
import { logger } from "@elizaos/core";
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
      enumerable = true;
      const ids = bridge.accountIds(route.providerId) ?? [];
      if (!ids.includes(route.accountId)) {
        issues.push({
          path: `${path}.accountId`,
          code: "missing_account",
          message: `No account "${route.accountId}" exists for provider "${route.providerId}"; connect it through Accounts or pin one of: ${ids.join(", ") || "(none connected)"}.`,
        });
        return issues;
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
  runtime.setSetting(CODING_POLICY_SETTING_KEY, JSON.stringify(policy));
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
      if (account.healthy === 0) {
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
