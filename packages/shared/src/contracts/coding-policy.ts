/**
 * Typed, strictly-validated coding policy contract: the single configuration
 * document that binds backend, provider/account, model roles, ordered
 * fallbacks, and approval preset for coding-agent spawns (#24099).
 *
 * Configured truth only — derived runtime state (executable preflight results,
 * account health, readiness) is NEVER persisted here; the server derives it
 * from the capability resolver (`coding-agent-capabilities.ts`) and the live
 * account bridge at read time. Validation is split the same way: this module
 * owns syntactic + descriptor-driven checks that need no runtime; the
 * orchestrator-side policy service owns authority checks (account existence,
 * current health) that do.
 */

import type { CodingAgentBackend } from "./coding-agent-capabilities.ts";
import {
  CODING_AGENT_BACKENDS,
  codingProviderDescriptorForProvider,
} from "./coding-agent-capabilities.ts";

export const CODING_POLICY_VERSION = 1 as const;

/** Canonical approval presets accepted on the policy document. */
export const CODING_POLICY_APPROVAL_PRESETS = [
  "readonly",
  "standard",
  "permissive",
  "autonomous",
] as const;

export type CodingPolicyApprovalPreset =
  (typeof CODING_POLICY_APPROVAL_PRESETS)[number];

/** Field-path error shape shared by both validation layers. */
export interface CodingPolicyIssue {
  /** Dotted path into the policy document (e.g. `fallbacks[1].model`). */
  path: string;
  /** Stable, machine-readable reason code. */
  code:
    | "unknown_field"
    | "invalid_type"
    | "unsupported_version"
    | "unsupported_backend"
    | "unsupported_provider"
    | "provider_backend_mismatch"
    | "provider_not_spawnable"
    | "missing_account"
    | "duplicate_route"
    | "empty_route"
    | "invalid_model"
    | "invalid_approval_preset"
    | "secret_rejected";
  message: string;
}

export interface CodingPolicyRoute {
  /** Spawn backend that executes this route. */
  backend: CodingAgentBackend;
  /** Linked-account provider binding the route's credential. */
  providerId: string;
  /** Pooled account id (required on account-backed routes). */
  accountId?: string;
  /** Model display name for the spawn; optional when the backend picks. */
  model?: string;
}

export interface CodingPolicy {
  version: typeof CODING_POLICY_VERSION;
  /** Primary execution route. */
  primary: CodingPolicyRoute;
  /** Ordered fallback routes tried when the primary route is unusable. */
  fallbacks: CodingPolicyRoute[];
  /** Approval preset applied to coding-agent spawns. */
  approvalPreset: CodingPolicyApprovalPreset;
  /** Model role overrides resolved from the primary route's provider. */
  modelPowerful?: string;
  modelFast?: string;
}

/** Top-level keys a valid policy may carry — anything else is rejected. */
const POLICY_TOP_KEYS = new Set([
  "version",
  "primary",
  "fallbacks",
  "approvalPreset",
  "modelPowerful",
  "modelFast",
]);

const ROUTE_KEYS = new Set(["backend", "providerId", "accountId", "model"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Key names whose presence means a secret leaked into the document. */
const SECRET_SHAPE_RE =
  /(?:api[_-]?key|secret|token|password|credential|private[_-]?key)/i;

function checkNoSecretShapedKeys(
  value: unknown,
  path: string,
  issues: CodingPolicyIssue[],
): void {
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      checkNoSecretShapedKeys(item, `${path}[${i}]`, issues);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_SHAPE_RE.test(key)) {
      issues.push({
        path: path === "" ? key : `${path}.${key}`,
        code: "secret_rejected",
        message: `Refusing to persist secret-shaped field "${key}" on the coding policy; use the encrypted Accounts flow instead.`,
      });
    }
    checkNoSecretShapedKeys(
      child,
      path === "" ? key : `${path}.${key}`,
      issues,
    );
  }
}

/**
 * Obvious key-shaped secret values a caller may have pasted into a free-text
 * field (model name, account label). Defense in depth on top of the
 * key-NAME rejection: the persisted document is echoed by GET and `model`
 * flows into spawn argv, so a value that IS a key must never persist.
 */
const SECRET_VALUE_RE = /\bsk-[A-Za-z0-9_-]{16,}\b/;

function checkNoSecretShapedValues(
  value: unknown,
  path: string,
  issues: CodingPolicyIssue[],
): void {
  if (typeof value === "string") {
    if (SECRET_VALUE_RE.test(value)) {
      issues.push({
        path,
        code: "secret_rejected",
        message: `${path || "value"} looks like a pasted API key; the coding policy never stores credentials — use the encrypted Accounts flow.`,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      checkNoSecretShapedValues(item, `${path}[${i}]`, issues);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    checkNoSecretShapedValues(
      child,
      path === "" ? key : `${path}.${key}`,
      issues,
    );
  }
}

function validateRoute(
  value: unknown,
  path: string,
  issues: CodingPolicyIssue[],
): CodingPolicyRoute | null {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: "invalid_type",
      message: `${path} must be an object.`,
    });
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!ROUTE_KEYS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        code: "unknown_field",
        message: `Unknown field "${key}" on ${path}; coding policy routes accept exactly ${[...ROUTE_KEYS].join(", ")}.`,
      });
    }
  }
  const backend = value.backend;
  if (
    typeof backend !== "string" ||
    !(CODING_AGENT_BACKENDS as readonly string[]).includes(backend)
  ) {
    issues.push({
      path: `${path}.backend`,
      code: "unsupported_backend",
      message: `${path}.backend must be one of ${CODING_AGENT_BACKENDS.join(", ")}.`,
    });
    return null;
  }
  const providerId = value.providerId;
  if (typeof providerId !== "string" || !providerId.trim()) {
    issues.push({
      path: `${path}.providerId`,
      code: "unsupported_provider",
      message: `${path}.providerId must be a non-empty provider id from the capability resolver.`,
    });
    return null;
  }
  const descriptor = codingProviderDescriptorForProvider(providerId);
  if (!descriptor) {
    issues.push({
      path: `${path}.providerId`,
      code: "unsupported_provider",
      message: `${path}.providerId "${providerId}" has no capability descriptor; providers without executable preflight stay visibly unsupported.`,
    });
    return null;
  }
  if (descriptor.backend !== backend) {
    issues.push({
      path: `${path}.providerId`,
      code: "provider_backend_mismatch",
      message: `Provider "${providerId}" does not route to backend "${backend}" (descriptor routes to ${descriptor.backend ?? "no backend"}).`,
    });
    return null;
  }
  if (!descriptor.spawnSupport || descriptor.backend === null) {
    issues.push({
      path: `${path}.providerId`,
      code: "provider_not_spawnable",
      message: `Provider "${providerId}" is not spawn-capable: ${descriptor.unsupportedReason ?? "no spawn backend"}.`,
    });
    return null;
  }
  const route: CodingPolicyRoute = { backend, providerId };
  if (value.accountId !== undefined) {
    if (typeof value.accountId !== "string" || !value.accountId.trim()) {
      issues.push({
        path: `${path}.accountId`,
        code: "invalid_type",
        message: `${path}.accountId must be a non-empty string when present.`,
      });
      return null;
    }
    route.accountId = value.accountId;
  }
  if (value.model !== undefined) {
    if (typeof value.model !== "string" || !value.model.trim()) {
      issues.push({
        path: `${path}.model`,
        code: "invalid_model",
        message: `${path}.model must be a non-empty string when present.`,
      });
      return null;
    }
    route.model = value.model;
  }
  return route;
}

export interface CodingPolicyValidation {
  policy: CodingPolicy | null;
  issues: CodingPolicyIssue[];
}

/**
 * Pure syntactic + descriptor-driven validation of a candidate coding policy.
 * Rejects unknown fields (no silent drops), secret-shaped keys, provider /
 * backend mismatches, non-spawnable providers, duplicate routes, and
 * unsupported versions. Server-side authority checks (does the account exist?
 * is it healthy?) belong to the orchestrator policy service, not here.
 */
export function validateCodingPolicy(input: unknown): CodingPolicyValidation {
  const issues: CodingPolicyIssue[] = [];
  if (!isPlainObject(input)) {
    issues.push({
      path: "",
      code: "invalid_type",
      message: "Coding policy must be a JSON object.",
    });
    return { policy: null, issues };
  }
  for (const key of Object.keys(input)) {
    if (!POLICY_TOP_KEYS.has(key)) {
      issues.push({
        path: key,
        code: "unknown_field",
        message: `Unknown field "${key}"; coding policy accepts exactly ${[...POLICY_TOP_KEYS].join(", ")}.`,
      });
    }
  }
  checkNoSecretShapedKeys(input, "", issues);
  checkNoSecretShapedValues(input, "", issues);
  if (input.version !== CODING_POLICY_VERSION) {
    issues.push({
      path: "version",
      code: "unsupported_version",
      message: `Coding policy version must be ${CODING_POLICY_VERSION}.`,
    });
  }
  const primary = validateRoute(input.primary, "primary", issues);
  const rawFallbacks = input.fallbacks;
  if (!Array.isArray(rawFallbacks)) {
    issues.push({
      path: "fallbacks",
      code: "invalid_type",
      message: "fallbacks must be an ordered array of routes.",
    });
  }
  const fallbacks: CodingPolicyRoute[] = [];
  if (Array.isArray(rawFallbacks)) {
    for (const [i, entry] of rawFallbacks.entries()) {
      const route = validateRoute(entry, `fallbacks[${i}]`, issues);
      if (route) fallbacks.push(route);
    }
    // Route identity is (backend, providerId, accountId) — a duplicated
    // identity makes the fallback order ambiguous.
    const seen = new Set<string>();
    const all = primary ? [primary, ...fallbacks] : fallbacks;
    for (const [i, route] of all.entries()) {
      const key = `${route.backend}|${route.providerId}|${route.accountId ?? ""}`;
      if (seen.has(key)) {
        issues.push({
          path: i === 0 ? "primary" : `fallbacks[${i - 1}]`,
          code: "duplicate_route",
          message: `Route ${key} appears more than once; fallback order must be unambiguous.`,
        });
      }
      seen.add(key);
    }
  }
  const rawApprovalPreset = input.approvalPreset;
  let approvalPreset: CodingPolicyApprovalPreset | null = null;
  if (
    typeof rawApprovalPreset === "string" &&
    (CODING_POLICY_APPROVAL_PRESETS as readonly string[]).includes(
      rawApprovalPreset,
    )
  ) {
    approvalPreset = rawApprovalPreset as CodingPolicyApprovalPreset;
  } else {
    issues.push({
      path: "approvalPreset",
      code: "invalid_approval_preset",
      message: `approvalPreset must be one of ${CODING_POLICY_APPROVAL_PRESETS.join(", ")}.`,
    });
  }
  const optionalModel = (key: "modelPowerful" | "modelFast") => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim()) {
      issues.push({
        path: key,
        code: "invalid_model",
        message: `${key} must be a non-empty string when present.`,
      });
      return undefined;
    }
    return value;
  };
  const modelPowerful = optionalModel("modelPowerful");
  const modelFast = optionalModel("modelFast");

  // approvalPreset === null always records an issue above; the issues.length
  // gate below therefore also catches it — no separate late branch is needed.
  if (
    issues.length > 0 ||
    !primary ||
    !Array.isArray(rawFallbacks) ||
    approvalPreset === null
  ) {
    return { policy: null, issues };
  }
  return {
    policy: {
      version: CODING_POLICY_VERSION,
      primary,
      fallbacks,
      approvalPreset,
      modelPowerful,
      modelFast,
    },
    issues,
  };
}

/** Stable runtime setting key the orchestrator persists the policy under. */
export const CODING_POLICY_SETTING_KEY = "ELIZA_CODING_POLICY";
