/**
 * Behavioral tests for the coding policy contract validator: acceptance of a
 * valid document, strict rejection (unknown fields, mismatched provider/
 * backend pairs, non-spawnable providers, duplicates, secrets), and the
 * derived backend ordering. Harness is deterministic — pure functions from
 * `@elizaos/shared`, no runtime or network.
 */
import { describe, expect, it } from "vitest";
import {
  CODING_POLICY_VERSION,
  type CodingPolicy,
  codingPolicyRouteBackends,
  validateCodingPolicy,
} from "./coding-policy.ts";

const VALID_POLICY: CodingPolicy = {
  version: CODING_POLICY_VERSION,
  primary: { backend: "claude", providerId: "anthropic-subscription" },
  fallbacks: [{ backend: "codex", providerId: "openai-codex" }],
  approvalPreset: "standard",
};

describe("validateCodingPolicy", () => {
  it("accepts a minimal valid policy", () => {
    const { policy, issues } = validateCodingPolicy(VALID_POLICY);
    expect(issues).toEqual([]);
    expect(policy).toEqual(VALID_POLICY);
  });

  it("accepts optional model roles and account pins", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        accountId: "work-claude",
        model: "claude-sonnet-4",
      },
      modelPowerful: "claude-opus",
      modelFast: "claude-haiku",
    });
    expect(issues).toEqual([]);
    expect(policy?.primary.accountId).toBe("work-claude");
    expect(policy?.modelPowerful).toBe("claude-opus");
  });

  it("rejects unknown top-level fields instead of dropping them", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      health: { ready: true },
    });
    expect(policy).toBeNull();
    expect(
      issues.some((i) => i.code === "unknown_field" && i.path === "health"),
    ).toBe(true);
  });

  it("rejects unknown route fields", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      primary: {
        backend: "claude",
        providerId: "anthropic-subscription",
        apiKey: "sk-leak",
      },
    });
    expect(policy).toBeNull();
    expect(
      issues.some(
        (i) => i.path === "primary.apiKey" && i.code === "secret_rejected",
      ),
    ).toBe(true);
  });

  it("rejects a provider that does not route to the named backend", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      primary: { backend: "codex", providerId: "anthropic-subscription" },
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "provider_backend_mismatch")).toBe(
      true,
    );
  });

  it("rejects a provider with no spawn backend as visibly unsupported", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      primary: { backend: "claude", providerId: "zai-coding" },
    });
    expect(policy).toBeNull();
    expect(
      issues.some(
        (i) =>
          i.code === "provider_backend_mismatch" ||
          i.code === "provider_not_spawnable",
      ),
    ).toBe(true);
  });

  it("rejects an unknown provider id", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      fallbacks: [{ backend: "claude", providerId: "not-a-provider" }],
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "unsupported_provider")).toBe(true);
  });

  it("rejects duplicate routes across primary and fallbacks", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      fallbacks: [{ backend: "claude", providerId: "anthropic-subscription" }],
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "duplicate_route")).toBe(true);
  });

  it("rejects an unsupported version", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      version: 99,
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "unsupported_version")).toBe(true);
  });

  it("rejects an invalid approval preset", () => {
    const { policy, issues } = validateCodingPolicy({
      ...VALID_POLICY,
      approvalPreset: "yolo",
    });
    expect(policy).toBeNull();
    expect(issues.some((i) => i.code === "invalid_approval_preset")).toBe(true);
  });

  it("rejects a non-object document", () => {
    const { policy, issues } = validateCodingPolicy("claude");
    expect(policy).toBeNull();
    expect(issues[0]?.code).toBe("invalid_type");
  });

  it("collects issues from every invalid route, not just the first", () => {
    const { issues } = validateCodingPolicy({
      ...VALID_POLICY,
      fallbacks: [
        { backend: "claude", providerId: "zai-coding" },
        { backend: "grok", providerId: "anthropic-subscription" },
      ],
    });
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("fallbacks[0].providerId");
    expect(paths).toContain("fallbacks[1].providerId");
  });
});

describe("codingPolicyRouteBackends", () => {
  it("returns primary first, then fallbacks in order", () => {
    expect(
      codingPolicyRouteBackends({
        ...VALID_POLICY,
        fallbacks: [
          { backend: "codex", providerId: "openai-codex" },
          { backend: "kimi", providerId: "kimi-coding" },
        ],
      }),
    ).toEqual(["claude", "codex", "kimi"]);
  });
});
