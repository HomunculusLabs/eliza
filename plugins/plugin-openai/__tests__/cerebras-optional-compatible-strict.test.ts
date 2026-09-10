/**
 * Covers the #30983 Cerebras upgrade of optional-property-compatible tools:
 * `strict:false` + `strictOptionalCompatible` tools must join the strict
 * request (wire flag true, sanitized schema path, declared optionals kept,
 * required args like eliza_turn_scope enforced), while explicit non-strict
 * callers keep the raw pass-through and the request-wide downgrade.
 * Deterministic unit harness over the real normalization seam.
 */
import { describe, expect, it } from "vitest";
import { __INTERNAL_normalizeNativeToolsForCall } from "../models/text";

const SCOPE = { type: "string", enum: ["final", "more_work_pending"] };

const optionalCompatibleAggregator = {
  name: "CALENDAR",
  type: "function",
  description: "aggregator umbrella",
  strict: false,
  strictOptionalCompatible: true,
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create_event", "list_events"] },
      title: { type: "string" },
      starts_at: { type: "string" },
      eliza_turn_scope: SCOPE,
    },
    required: ["op", "eliza_turn_scope"],
    additionalProperties: false,
  },
};

const strictSibling = {
  name: "MEMORY",
  type: "function",
  description: "memory lookup",
  strict: true,
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, eliza_turn_scope: SCOPE },
    required: ["query", "eliza_turn_scope"],
    additionalProperties: false,
  },
};

const explicitNonStrict = {
  name: "LEGACY",
  type: "function",
  description: "explicit non-strict native caller",
  strict: false,
  parameters: {
    type: "object",
    properties: { anything: { type: "string" } },
    required: ["anything"],
    additionalProperties: false,
  },
};

function schemaOf(tool: unknown): Record<string, unknown> {
  const t = tool as { inputSchema?: { jsonSchema?: unknown } };
  return t.inputSchema?.jsonSchema as Record<string, unknown>;
}

describe("normalizeNativeToolsForCall optional_compatible upgrade (#30983)", () => {
  it("aggregator joins the strict request: wire flag true for every tool", () => {
    const out = __INTERNAL_normalizeNativeToolsForCall(
      [optionalCompatibleAggregator, strictSibling],
      { cerebrasMode: true, sanitizeUnicode: true }
    );
    expect(out.tools?.CALENDAR?.strict).toBe(true);
    expect(out.tools?.MEMORY?.strict).toBe(true);
  });

  it("aggregator schema takes the strict path and keeps required scope enforced", () => {
    const out = __INTERNAL_normalizeNativeToolsForCall([optionalCompatibleAggregator], {
      cerebrasMode: true,
      sanitizeUnicode: true,
    });
    const schema = schemaOf(out.tools?.CALENDAR);
    expect(schema.required).toEqual(["op", "eliza_turn_scope"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("unused operation fields stay optional (no placeholder forcing)", () => {
    const out = __INTERNAL_normalizeNativeToolsForCall([optionalCompatibleAggregator], {
      cerebrasMode: true,
      sanitizeUnicode: true,
    });
    const schema = schemaOf(out.tools?.CALENDAR);
    const required = schema.required as string[];
    expect(required).not.toContain("title");
    expect(required).not.toContain("starts_at");
    expect((schema.properties as Record<string, unknown>).title).toEqual({
      type: "string",
    });
  });

  it("explicit non-strict native caller remains unchanged, including downgrade", () => {
    const out = __INTERNAL_normalizeNativeToolsForCall([explicitNonStrict, strictSibling], {
      cerebrasMode: true,
      sanitizeUnicode: true,
    });
    expect(out.tools?.LEGACY?.strict).toBe(false);
    expect(out.tools?.MEMORY?.strict).toBe(false);
    // Raw pass-through keeps the exact declared schema shape.
    const schema = schemaOf(out.tools?.LEGACY);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["anything"]);
  });

  it("non-Cerebras transports keep the non-strict fallback for the aggregator", () => {
    const out = __INTERNAL_normalizeNativeToolsForCall([optionalCompatibleAggregator], {
      cerebrasMode: false,
      sanitizeUnicode: true,
    });
    const tool = out.tools?.CALENDAR as { strict?: boolean };
    expect(tool.strict).toBe(false);
  });
});
