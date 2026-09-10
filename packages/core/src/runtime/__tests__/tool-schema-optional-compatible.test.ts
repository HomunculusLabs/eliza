/**
 * Covers the #30983 optional-property-compatible strict declaration at the
 * Action-to-tool boundary: actions declaring `toolSchemaStrict:
 * "optional_compatible"` must emit `strict:false` plus the typed
 * `strictOptionalCompatible` marker, legacy `false` must stay bare, and
 * defaults must stay fully strict. Deterministic unit harness over the real
 * conversion helpers.
 */
import { describe, expect, it } from "vitest";
import {
	actionToolStrictness,
	actionToTool,
	buildPlannerToolsFromTieredActions,
} from "../../actions/to-tool";
import type { Action } from "../../types";
import { withTurnScopeToolArg } from "../planner-loop";

const aggregatorAction = {
	name: "CALENDAR",
	description: "calendar umbrella",
	parameters: [
		{
			name: "op",
			required: true,
			schema: { type: "string", enum: ["create_event", "list_events"] },
		},
		{ name: "title", required: false, schema: { type: "string" } },
	],
	toolSchemaStrict: "optional_compatible",
} as unknown as Action;

describe("actionToolStrictness (#30983)", () => {
	it("maps optional_compatible to non-strict wire flag plus marker", () => {
		expect(
			actionToolStrictness({ toolSchemaStrict: "optional_compatible" }),
		).toEqual({ strict: false, strictOptionalCompatible: true });
	});

	it("keeps legacy false bare (no marker)", () => {
		expect(actionToolStrictness({ toolSchemaStrict: false })).toEqual({
			strict: false,
		});
	});

	it("defaults to strict and omits the marker", () => {
		expect(actionToolStrictness({})).toEqual({ strict: true });
		expect(actionToolStrictness({ toolSchemaStrict: true })).toEqual({
			strict: true,
		});
	});
});

describe("planner tool emission (#30983)", () => {
	it("flat ToolDefinition carries the marker next to strict:false", () => {
		const [tool] = buildPlannerToolsFromTieredActions([
			aggregatorAction as never,
		]);
		expect(tool.strict).toBe(false);
		expect(tool.strictOptionalCompatible).toBe(true);
	});

	it("nested actionToTool envelope carries the marker", () => {
		const tool = actionToTool(aggregatorAction);
		expect(tool.function.strict).toBe(false);
		expect(tool.function.strictOptionalCompatible).toBe(true);
	});

	it("plain strict actions gain no marker", () => {
		const plain = { ...aggregatorAction, toolSchemaStrict: undefined };
		const [tool] = buildPlannerToolsFromTieredActions([plain as never]);
		expect(tool.strict).toBe(true);
		expect(tool.strictOptionalCompatible).toBeUndefined();
	});

	it("withTurnScopeToolArg preserves the marker while adding the scope arg", () => {
		const [tool] = buildPlannerToolsFromTieredActions([
			aggregatorAction as never,
		]);
		const scopedList = withTurnScopeToolArg([tool]);
		expect(scopedList).toBeDefined();
		const [scoped] = scopedList ?? [];
		expect(scoped.strict).toBe(false);
		expect(scoped.strictOptionalCompatible).toBe(true);
		const required = (scoped.parameters as { required?: string[] }).required;
		expect(required).toContain("eliza_turn_scope");
		// Optional op fields must stay optional: only declared-required keys.
		expect(required).toEqual(["op", "eliza_turn_scope"]);
	});
});
