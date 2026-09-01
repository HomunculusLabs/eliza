/**
 * Unit coverage for the `canRespond` readiness signal surviving parse of the WS
 * status event and feeding deriveAgentReady. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import { parseAgentStatusEvent } from "./parsers";
import { deriveAgentReady } from "./types";

describe("parseAgentStatusEvent — canRespond readiness signal", () => {
  it("carries canRespond:true through from the WS status event", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: undefined,
      startedAt: 1000,
      canRespond: true,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.canRespond).toBe(true);
    // A dedicated cloud agent reports no locally-detected model; readiness must
    // come from the server-authoritative canRespond, not running+model.
    expect(deriveAgentReady(parsed)).toBe(true);
  });

  it("carries canRespond:false through (running but no provider) so the composer stays gated", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "gpt-oss-120b",
      canRespond: false,
    });
    expect(parsed?.canRespond).toBe(false);
    expect(deriveAgentReady(parsed)).toBe(false);
  });

  it("omits canRespond when the server doesn't report it (back-compat fallback to running+model)", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "gpt-oss-120b",
    });
    expect(parsed?.canRespond).toBeUndefined();
    // Falls back to running+model.
    expect(deriveAgentReady(parsed)).toBe(true);
  });

  it("ignores a non-boolean canRespond payload", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "m",
      canRespond: "yes" as unknown as boolean,
    });
    expect(parsed?.canRespond).toBeUndefined();
  });
});

describe("parseAgentStatusEvent — chat-brain model validation (#30228)", () => {
  it("carries a well-formed modelValidation through so the composer can say 'configured model unavailable'", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "m",
      modelValidation: {
        status: "invalid_model",
        invalid: [{ key: "ELIZAOS_CLOUD_LARGE_MODEL", model: "gone-model" }],
        checkedAt: 123,
      },
    });
    expect(parsed?.modelValidation).toEqual({
      status: "invalid_model",
      invalid: [{ key: "ELIZAOS_CLOUD_LARGE_MODEL", model: "gone-model" }],
      checkedAt: 123,
    });
  });

  it("drops the whole field when ANY invalid member is malformed (no silent deletion)", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "m",
      modelValidation: {
        status: "invalid_model",
        invalid: [
          { key: "ELIZAOS_CLOUD_LARGE_MODEL", model: "gone-model" },
          { key: 42, model: "no" },
          "junk",
        ],
        checkedAt: 5,
      },
    });
    expect(parsed?.modelValidation).toBeUndefined();
  });

  it("keeps a valid_model payload with an empty invalid array", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "m",
      modelValidation: { status: "valid_model", invalid: [], checkedAt: 9 },
    });
    expect(parsed?.modelValidation).toEqual({
      status: "valid_model",
      invalid: [],
      checkedAt: 9,
    });
  });

  it("drops the whole field on an unknown status or non-record payload (untrusted wire data)", () => {
    for (const bad of [
      { status: "bogus", invalid: [], checkedAt: 1 },
      "nope",
      7,
      null,
    ]) {
      const parsed = parseAgentStatusEvent({
        type: "status",
        state: "running",
        agentName: "Eliza",
        model: "m",
        modelValidation: bad as unknown as object,
      });
      expect(parsed?.modelValidation).toBeUndefined();
    }
  });

  it("drops the whole field when required invalid/checkedAt members are missing (no fabricated DTO values)", () => {
    for (const bad of [
      { status: "invalid_model" },
      { status: "invalid_model", invalid: [] },
      { status: "invalid_model", checkedAt: 1 },
      { status: "valid_model", invalid: "nope", checkedAt: 1 },
      { status: "valid_model", invalid: [], checkedAt: "1" },
    ]) {
      const parsed = parseAgentStatusEvent({
        type: "status",
        state: "running",
        agentName: "Eliza",
        model: "m",
        modelValidation: bad as unknown as object,
      });
      expect(parsed?.modelValidation).toBeUndefined();
    }
  });

  it("omits modelValidation when the server doesn't report it (back-compat)", () => {
    const parsed = parseAgentStatusEvent({
      type: "status",
      state: "running",
      agentName: "Eliza",
      model: "gpt-oss-120b",
    });
    expect(parsed?.modelValidation).toBeUndefined();
  });
});
