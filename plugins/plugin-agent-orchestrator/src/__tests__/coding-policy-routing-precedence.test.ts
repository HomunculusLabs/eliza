/**
 * Pins the spawn-adapter precedence introduced with the coding policy
 * (#24099): benchmark override > persisted coding policy > legacy env keys.
 * Also proves a corrupt stored policy degrades to legacy routing instead of
 * breaking spawn selection. Deterministic; resolvePinnedAdapter is pure.
 */

import { describe, expect, it } from "vitest";
import { resolvePinnedAdapter } from "../services/task-agent-routing.js";

function runtimeWith(settings: Record<string, string>) {
  return {
    getSetting: (key: string) => settings[key] ?? null,
  } as never;
}

// A whole-document-valid policy whose primary routes to a REAL spawn
// backend. NOTE: "kimi-coding" is inference-only (descriptor backend is
// null — the Kimi ACP CLI uses its own OAuth, not the coding-plan key), so
// a kimi primary is NOT expressible as a valid policy today. Codex via the
// openai-codex subscription descriptor is the canonical spawn route.
const POLICY = JSON.stringify({
  version: 1,
  primary: { backend: "codex", providerId: "openai-codex" },
  fallbacks: [],
  approvalPreset: "standard",
});

describe("resolvePinnedAdapter precedence (#24099)", () => {
  it("prefers the coding policy over legacy env keys", () => {
    const resolved = resolvePinnedAdapter(
      runtimeWith({
        ELIZA_CODING_POLICY: POLICY,
        ELIZA_ACP_DEFAULT_AGENT: "claude",
        ELIZA_DEFAULT_AGENT_TYPE: "codex",
      }),
    );
    expect(resolved).toBe("codex");
  });

  it("benchmark override still wins over the policy", () => {
    const resolved = resolvePinnedAdapter(
      runtimeWith({
        BENCHMARK_TASK_AGENT: "grok",
        ELIZA_CODING_POLICY: POLICY,
      }),
    );
    expect(resolved).toBe("grok");
  });

  it("falls back to legacy env keys when no policy is set", () => {
    const resolved = resolvePinnedAdapter(
      runtimeWith({ ELIZA_DEFAULT_AGENT_TYPE: "claude" }),
    );
    expect(resolved).toBe("claude");
  });

  it("degrades to legacy routing on a corrupt stored policy", () => {
    const resolved = resolvePinnedAdapter(
      runtimeWith({
        ELIZA_CODING_POLICY: "{corrupt",
        ELIZA_ACP_DEFAULT_AGENT: "codex",
      }),
    );
    expect(resolved).toBe("codex");
  });

  it("ignores a policy whose primary backend is unknown", () => {
    const resolved = resolvePinnedAdapter(
      runtimeWith({
        ELIZA_CODING_POLICY: JSON.stringify({
          version: 1,
          primary: { backend: "not-a-backend", providerId: "x" },
          fallbacks: [],
          approvalPreset: "standard",
        }),
        ELIZA_DEFAULT_AGENT_TYPE: "claude",
      }),
    );
    expect(resolved).toBe("claude");
  });
});
