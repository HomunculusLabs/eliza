/**
 * Behavioral tests for the coding policy service: the one atomic write path
 * (persist + authority checks), corrupt-document degrade on load, and
 * per-route readiness derivation against the capability descriptors and a
 * fake account bridge. Deterministic; no live server, no network.
 */

import type {
  CodingAgentSelectorBridge,
  CodingProviderAvailability,
  IAgentRuntime,
} from "@elizaos/core";
import { setCodingAgentSelectorBridge } from "@elizaos/core";
import { CODING_POLICY_SETTING_KEY } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assessCodingPolicyReadiness,
  loadCodingPolicy,
  writeCodingPolicy,
} from "../services/coding-policy-service.js";

function makeRuntime(): IAgentRuntime & {
  settings: Map<string, string>;
} {
  const settings = new Map<string, string>();
  const runtime = {
    settings,
    getSetting: (key: string) => settings.get(key) ?? null,
    setSetting: (key: string, value: string | boolean | null) => {
      if (value === null) settings.delete(key);
      else settings.set(key, String(value));
    },
  } as unknown as IAgentRuntime & { settings: Map<string, string> };
  return runtime;
}

function makeBridge(
  availability: Record<string, CodingProviderAvailability[]>,
  accountIds?: Record<string, string[]>,
): CodingAgentSelectorBridge {
  return {
    describe: () => availability,
    ...(accountIds ? { accountIds: (p: string) => accountIds[p] } : {}),
    select: vi.fn(async () => null),
  } as unknown as CodingAgentSelectorBridge;
}

const VALID = {
  version: 1,
  primary: { backend: "claude", providerId: "anthropic-subscription" },
  fallbacks: [{ backend: "codex", providerId: "openai-codex" }],
  approvalPreset: "standard",
};

afterEach(() => {
  setCodingAgentSelectorBridge(null);
});

describe("writeCodingPolicy", () => {
  it("persists a valid policy and returns the authoritative document", () => {
    const runtime = makeRuntime();
    const { policy, issues } = writeCodingPolicy(runtime, VALID);
    expect(issues).toEqual([]);
    expect(policy).toEqual(VALID);
    const stored = runtime.settings.get(CODING_POLICY_SETTING_KEY);
    expect(typeof stored === "string" && JSON.parse(stored)).toEqual(VALID);
  });

  it("rejects an invalid document without persisting anything", () => {
    const runtime = makeRuntime();
    const { policy, issues } = writeCodingPolicy(runtime, {
      ...VALID,
      approvalPreset: "nope",
    });
    expect(policy).toBeNull();
    expect(issues.length).toBeGreaterThan(0);
    expect(runtime.settings.has(CODING_POLICY_SETTING_KEY)).toBe(false);
  });

  it("blocks a pinned account when the provider has no connected account", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 0,
            enabled: 0,
            healthy: 0,
          },
        ],
      }),
    );
    const runtime = makeRuntime();
    const { policy, issues } = writeCodingPolicy(runtime, {
      ...VALID,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "ghost",
      },
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "missing_account")).toBe(true);
    expect(runtime.settings.has(CODING_POLICY_SETTING_KEY)).toBe(false);
  });

  it("allows a pinned account when the provider has connected accounts", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 1,
            enabled: 1,
            healthy: 1,
          },
        ],
      }),
    );
    const runtime = makeRuntime();
    const { policy, issues } = writeCodingPolicy(runtime, {
      ...VALID,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-a",
      },
    });
    expect(issues).toEqual([]);
    expect(policy?.primary.accountId).toBe("acct-a");
  });

  it("rejects a ghost pin when the bridge can enumerate account ids (r2 #2)", () => {
    setCodingAgentSelectorBridge(
      makeBridge(
        {
          claude: [
            {
              providerId: "anthropic-subscription",
              total: 1,
              enabled: 1,
              healthy: 1,
            },
          ],
        },
        { "anthropic-subscription": ["acct-real"] },
      ),
    );
    const { policy, issues } = writeCodingPolicy(makeRuntime(), {
      ...VALID,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-ghost",
      },
    });
    expect(policy).toBeNull();
    expect(
      issues.some(
        (issue) =>
          issue.code === "missing_account" &&
          issue.path === "primary.accountId" &&
          issue.message.includes("acct-ghost"),
      ),
    ).toBe(true);
  });

  it("degrades to the provider-level check when the bridge cannot enumerate ids", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 1,
            enabled: 1,
            healthy: 1,
          },
        ],
      }),
    );
    // No accountIds support: a would-be-ghost pin is NOT rejected here —
    // spawn-time selection stays the authoritative check (fails closed).
    const { policy, issues } = writeCodingPolicy(makeRuntime(), {
      ...VALID,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-unknown",
      },
    });
    expect(issues).toEqual([]);
    expect(policy?.primary.accountId).toBe("acct-unknown");
  });
});

describe("loadCodingPolicy", () => {
  it("returns null when nothing is persisted", () => {
    const { policy, issues } = loadCodingPolicy(makeRuntime());
    expect(policy).toBeNull();
    expect(issues).toEqual([]);
  });

  it("degrades with an explicit issue on a corrupt stored document", () => {
    const runtime = makeRuntime();
    runtime.setSetting(CODING_POLICY_SETTING_KEY, "{not json");
    const { policy, issues } = loadCodingPolicy(runtime);
    expect(policy).toBeNull();
    expect(issues[0]?.message).toContain("not valid JSON");
  });

  it("round-trips a written policy", () => {
    const runtime = makeRuntime();
    writeCodingPolicy(runtime, VALID);
    const { policy, issues } = loadCodingPolicy(runtime);
    expect(issues).toEqual([]);
    expect(policy).toEqual(VALID);
  });
});

describe("assessCodingPolicyReadiness", () => {
  it("reports ready with route detail when accounts are healthy", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 2,
            enabled: 2,
            healthy: 1,
          },
        ],
        codex: [
          { providerId: "openai-codex", total: 1, enabled: 1, healthy: 1 },
        ],
      }),
    );
    const readiness = assessCodingPolicyReadiness(
      makeRuntime(),
      // The runtime arg is only used for loading; pass the policy-bearing
      // runtime shape via the direct policy parameter below.
      {
        version: 1,
        primary: { backend: "claude", providerId: "anthropic-subscription" },
        fallbacks: [{ backend: "codex", providerId: "openai-codex" }],
        approvalPreset: "standard",
      },
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.effectiveBackend).toBe("claude");
    expect(readiness.routes).toHaveLength(2);
    expect(readiness.routes[0]?.billingMode).toBe("subscription-coding-cli");
  });

  it("fails over to a healthy fallback and reports the degraded primary", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 1,
            enabled: 1,
            healthy: 0,
          },
        ],
        codex: [
          { providerId: "openai-codex", total: 1, enabled: 1, healthy: 1 },
        ],
      }),
    );
    const readiness = assessCodingPolicyReadiness(makeRuntime(), {
      version: 1,
      primary: { backend: "claude", providerId: "anthropic-subscription" },
      fallbacks: [{ backend: "codex", providerId: "openai-codex" }],
      approvalPreset: "standard",
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.effectiveBackend).toBe("codex");
    expect(readiness.problems[0]).toContain("anthropic-subscription");
  });

  it("marks a non-spawnable provider route not-ok with its unsupported reason", () => {
    setCodingAgentSelectorBridge(makeBridge({}));
    const readiness = assessCodingPolicyReadiness(makeRuntime(), {
      version: 1,
      primary: { backend: "claude", providerId: "anthropic-subscription" },
      fallbacks: [{ backend: "claude", providerId: "zai-coding" }],
      approvalPreset: "standard",
    });
    const zai = readiness.routes[1];
    expect(zai?.ok).toBe(false);
    expect(zai?.problems.join(" ")).toContain("inference");
  });

  it("is not ready when every route is unhealthy", () => {
    setCodingAgentSelectorBridge(
      makeBridge({
        claude: [
          {
            providerId: "anthropic-subscription",
            total: 0,
            enabled: 0,
            healthy: 0,
          },
        ],
      }),
    );
    const readiness = assessCodingPolicyReadiness(makeRuntime(), {
      version: 1,
      primary: { backend: "claude", providerId: "anthropic-subscription" },
      fallbacks: [],
      approvalPreset: "standard",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.effectiveBackend).toBeUndefined();
  });
});
