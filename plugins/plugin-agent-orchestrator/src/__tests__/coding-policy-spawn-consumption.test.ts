/**
 * Behavioral tests for unified-policy spawn consumption and readiness pin
 * honesty (#24099 review r3 findings 3+5): the whole-valid policy steers the
 * spawn's approval preset, model, and ordered pinned-account walk (with policy
 * provenance stamped onto the durable session record), readiness never
 * presents a pinned route as confirmed-healthy off sibling-account counts, and
 * `accountIds() === undefined` degrades to the provider-level check. Deterministic;
 * real AcpService + InMemorySessionStore + fake account bridge, no network.
 */

import type { CodingAgentSelection } from "@elizaos/core";
import { setCodingAgentSelectorBridge } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import {
  assessCodingPolicyReadiness,
  resolveCodingPolicySpawnPin,
  writeCodingPolicy,
} from "../services/coding-policy-service.js";
import { InMemorySessionStore } from "../services/session-store.ts";

function makeRuntime(settings: Record<string, string> = {}) {
  return {
    agentId: "00000000-0000-4000-8000-00000002409",
    character: { name: "Tester" },
    getSetting: (key: string) => settings[key],
    setSetting: (key: string, value: string) => {
      settings[key] = value;
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getService: () => null,
  };
}

function selectionFor(accountId: string): CodingAgentSelection {
  return {
    providerId: "anthropic-subscription",
    accountId,
    label: `label-${accountId}`,
    envPatch: { [`FAKE_TOKEN_${accountId}`]: "1" },
  } as unknown as CodingAgentSelection;
}

function makeSelectingBridge(
  selectable: string[],
  availability: Record<
    string,
    { providerId: string; total: number; enabled: number; healthy: number }[]
  >,
  accountIds?: Record<string, string[] | undefined>,
) {
  const calls: { agentType: string; opts: Record<string, unknown> }[] = [];
  const bridge = {
    describe: () => availability,
    ...(accountIds ? { accountIds: (p: string) => accountIds[p] } : {}),
    select: async (agentType: string, opts?: { accountIds?: string[] }) => {
      calls.push({ agentType, opts: opts ?? {} });
      const pin = opts?.accountIds?.[0];
      if (pin && selectable.includes(pin)) return selectionFor(pin);
      if (!pin && selectable.length > 0) return selectionFor(selectable[0]);
      return null;
    },
  };
  return {
    bridge,
    calls,
    install() {
      setCodingAgentSelectorBridge(bridge as never);
    },
  };
}

const HEALTHY_CLAUDE = [
  {
    providerId: "anthropic-subscription",
    total: 2,
    enabled: 2,
    healthy: 1,
  },
];

afterEach(() => {
  setCodingAgentSelectorBridge(null);
});

describe("writeCodingPolicy: accountIds undefined degrades (r3 undefined-finding)", () => {
  it("degrades to the provider-level check when accountIds returns undefined", () => {
    setCodingAgentSelectorBridge(
      makeSelectingBridge(
        [],
        { claude: HEALTHY_CLAUDE },
        { "anthropic-subscription": undefined },
      ).bridge as never,
    );
    // Enumeration unsupported for this provider: a pin is NOT rejected as a
    // ghost (only a defined-but-absent id proves that) and the message must
    // still carry the spawn-time-fails-closed caveat.
    const { policy, issues } = writeCodingPolicy(makeRuntime() as never, {
      version: 1,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-maybe",
      },
      fallbacks: [],
      approvalPreset: "standard",
    });
    expect(issues).toEqual([]);
    expect(policy?.primary.accountId).toBe("acct-maybe");
  });

  it("rejects a pin only when enumeration returned a defined list without it", () => {
    setCodingAgentSelectorBridge(
      makeSelectingBridge(
        [],
        { claude: HEALTHY_CLAUDE },
        { "anthropic-subscription": ["acct-real"] },
      ).bridge as never,
    );
    const { policy, issues } = writeCodingPolicy(makeRuntime() as never, {
      version: 1,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-ghost",
      },
      fallbacks: [],
      approvalPreset: "standard",
    });
    expect(policy).toBeNull();
    expect(issues.some((issue) => issue.code === "missing_account")).toBe(true);
  });
});

describe("assessCodingPolicyReadiness: pinned-route honesty (r3 finding 5)", () => {
  const POLICY = {
    version: 1,
    primary: {
      backend: "claude",
      providerId: "anthropic-subscription",
      accountId: "acct-pinned",
    },
    fallbacks: [],
    approvalPreset: "standard",
  };

  it("marks a ghost pin not-ok even when a sibling account is healthy", () => {
    setCodingAgentSelectorBridge(
      makeSelectingBridge(
        [],
        { claude: HEALTHY_CLAUDE },
        {
          "anthropic-subscription": ["acct-other"],
        },
      ).bridge as never,
    );
    const readiness = assessCodingPolicyReadiness(
      makeRuntime() as never,
      POLICY,
    );
    expect(readiness.routes[0]?.ok).toBe(false);
    expect(readiness.routes[0]?.account?.pinStatus).toBe("ghost");
    expect(readiness.problems.join(" ")).toContain("acct-pinned");
    expect(readiness.ready).toBe(false);
  });

  it("verifies an existing pin but never claims its health from aggregate counts", () => {
    setCodingAgentSelectorBridge(
      makeSelectingBridge(
        [],
        { claude: HEALTHY_CLAUDE },
        {
          "anthropic-subscription": ["acct-pinned", "acct-other"],
        },
      ).bridge as never,
    );
    const readiness = assessCodingPolicyReadiness(
      makeRuntime() as never,
      POLICY,
    );
    expect(readiness.routes[0]?.account?.pinStatus).toBe("verified");
    // Aggregate pool health (healthy:1) must not be reported as the pin's.
    expect(readiness.routes[0]?.problems.join(" ")).not.toContain("No healthy");
  });

  it("marks a pinned route unverifiable — never confirmed-healthy — without enumeration", () => {
    setCodingAgentSelectorBridge(
      makeSelectingBridge([], { claude: HEALTHY_CLAUDE }).bridge as never,
    );
    const readiness = assessCodingPolicyReadiness(
      makeRuntime() as never,
      POLICY,
    );
    expect(readiness.routes[0]?.account?.pinStatus).toBe("unverifiable");
    expect(readiness.routes[0]?.ok).toBe(false);
    expect(readiness.routes[0]?.problems.join(" ")).toContain(
      "cannot be verified",
    );
  });
});

describe("resolveCodingPolicySpawnPin", () => {
  it("returns matching routes in policy order with preset and first model", () => {
    // Write path requires a bridge to authorize pinned accounts.
    const harness = makeSelectingBridge(
      [],
      { claude: HEALTHY_CLAUDE },
      {
        "anthropic-subscription": ["acct-a", "acct-b"],
      },
    );
    harness.install();
    const runtime = makeRuntime() as never;
    writeCodingPolicy(runtime, {
      version: 1,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-a",
        model: "claude-x",
      },
      fallbacks: [
        {
          backend: "claude",
          providerId: "anthropic-subscription",
          accountId: "acct-b",
        },
        { backend: "codex", providerId: "openai-codex" },
      ],
      approvalPreset: "readonly",
    });
    const pin = resolveCodingPolicySpawnPin(runtime, "claude");
    expect(pin?.routes.map((route) => route.accountId)).toEqual([
      "acct-a",
      "acct-b",
    ]);
    expect(pin?.approvalPreset).toBe("readonly");
    expect(pin?.model).toBe("claude-x");
    // Non-matching backend gets zero routes (ambient strategy stays in force).
    expect(resolveCodingPolicySpawnPin(runtime, "kimi")?.routes).toEqual([]);
  });

  it("returns null when no whole-valid policy is stored", () => {
    expect(
      resolveCodingPolicySpawnPin(makeRuntime() as never, "claude"),
    ).toBeNull();
  });
});

describe("AcpService.spawnSession policy consumption (r3 finding 3)", () => {
  function serviceWithPolicy(policy: unknown) {
    const settings: Record<string, string> = { ELIZA_ACP_TRANSPORT: "cli" };
    const runtime = makeRuntime(settings) as never;
    if (policy) {
      writeCodingPolicy(runtime, policy);
    }
    const store = new InMemorySessionStore();
    const svc = new AcpService(runtime, { store });
    (svc as unknown as { started: boolean }).started = true;
    (
      svc as unknown as {
        runAcpx: () => Promise<{
          code: number;
          stdout: string;
          stderr: string;
        }>;
      }
    ).runAcpx = async () => ({ code: 0, stdout: "", stderr: "" });
    return { svc, store, settings };
  }

  const POLICY = {
    version: 1,
    primary: {
      backend: "claude",
      providerId: "anthropic-subscription",
      accountId: "acct-pinned",
    },
    fallbacks: [
      {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "acct-fallback",
      },
    ],
    approvalPreset: "readonly",
  };

  it("authenticates as the pinned primary account and stamps policy provenance", async () => {
    const harness = makeSelectingBridge(
      ["acct-fallback"],
      { claude: HEALTHY_CLAUDE },
      {
        "anthropic-subscription": ["acct-pinned", "acct-fallback"],
      },
    );
    harness.install();
    const { svc, store } = serviceWithPolicy(POLICY);
    const result = await svc.spawnSession({ agentType: "claude" });
    // Selection walked past the unselectable primary pin to the fallback pin.
    expect(
      harness.calls
        .filter((call) => call.opts.accountIds !== undefined)
        .map((call) => call.opts.accountIds),
    ).toEqual([["acct-pinned"], ["acct-fallback"]]);
    const session = await store.get(result.sessionId);
    expect(session?.metadata?.account?.accountId).toBe("acct-fallback");
    expect(session?.approvalPreset).toBe("readonly");
    expect(session?.metadata?.codingPolicyRoute).toEqual({
      backend: "claude",
      providerId: "anthropic-subscription",
      accountId: "acct-fallback",
    });
    expect(session?.metadata?.codingPolicyPreset).toBe("readonly");
  });

  it("falls back to the ambient strategy when no policy routes match the backend", async () => {
    const harness = makeSelectingBridge(["acct-any"], {
      claude: HEALTHY_CLAUDE,
    });
    harness.install();
    const { svc, store } = serviceWithPolicy({
      ...POLICY,
      primary: {
        ...POLICY.primary,
        backend: "codex",
        providerId: "openai-codex",
      },
      fallbacks: [],
    });
    const result = await svc.spawnSession({ agentType: "claude" });
    expect(
      harness.calls.some((call) => call.opts.accountIds !== undefined),
    ).toBe(false);
    const session = await store.get(result.sessionId);
    expect(session?.metadata?.codingPolicyRoute).toBeUndefined();
  });

  it("keeps an explicit caller preset above the policy preset", async () => {
    const harness = makeSelectingBridge(
      ["acct-pinned"],
      { claude: HEALTHY_CLAUDE },
      {
        "anthropic-subscription": ["acct-pinned"],
      },
    );
    harness.install();
    const { svc, store } = serviceWithPolicy(POLICY);
    const result = await svc.spawnSession({
      agentType: "claude",
      approvalPreset: "permissive",
    });
    const session = await store.get(result.sessionId);
    expect(session?.approvalPreset).toBe("permissive");
  });
});
