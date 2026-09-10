/**
 * Exercises the real planner loop's #30974 admission gate: after an explicit
 * `eliza_turn_scope` declaration, a later native batch that omits or corrupts
 * the declaration on any non-terminal call is rejected before any call
 * executes, the full rejected output stays in the model-facing repair
 * context, and repeated rejections terminate with a typed protocol error.
 * Deterministic model mocks; the planner loop and evaluator paths are real.
 */
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerRuntime } from "../planner-types";

function call(
	name: string,
	scope?: "more_work_pending" | "final" | string,
	args: Record<string, unknown> = {},
) {
	return {
		id: name.toLowerCase(),
		name,
		arguments: {
			...(scope === undefined ? {} : { eliza_turn_scope: scope }),
			...args,
		},
	};
}

function plan(toolCalls: ReturnType<typeof call>[]) {
	return { text: "", toolCalls };
}

function finish(messageToUser: string) {
	return JSON.stringify({
		thought: "Judge the complete recorded results.",
		success: true,
		decision: "FINISH",
		messageToUser,
	});
}

const continueWork = JSON.stringify({
	thought: "The declared follow-up work has not run yet.",
	success: false,
	decision: "CONTINUE",
});

function harness(args: {
	plans: Array<
		ReturnType<typeof plan> | { text: string; toolCalls: unknown[] } | string
	>;
	evaluations: string[];
}) {
	let plannerIndex = 0;
	let evaluatorIndex = 0;
	const executed: string[] = [];
	const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
		const response =
			type === ModelType.ACTION_PLANNER
				? args.plans[plannerIndex++]
				: type === ModelType.RESPONSE_HANDLER
					? args.evaluations[evaluatorIndex++]
					: undefined;
		if (response === undefined) {
			throw new Error(
				`Unexpected model call ${String(type)} after ${useModel.mock.calls
					.map(([calledType]) => String(calledType))
					.join(",")}`,
			);
		}
		return response;
	});
	const executeToolCall = vi.fn(async (tool: { name: string }) => {
		executed.push(tool.name);
		return {
			success: true,
			transcriptVisibility: "internal" as const,
			text: JSON.stringify({ operation: tool.name, completed: true }),
			effectReceipts: [
				{
					receiptId: `rcpt-${tool.name}`,
					operation: `${tool.name.toLowerCase()}.commit`,
					resource: { kind: "test", id: tool.name },
					artifacts: [],
					idempotency: { key: null, replayed: false },
					observedAt: "2026-09-10T00:00:00.000Z",
					outcome: "applied" as const,
					reason: "Test mutation.",
				},
			],
		};
	});
	const run = () =>
		runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "compound-turn",
				events: [
					{
						id: "current-message",
						type: "message",
						source: "user",
						createdAt: 1,
						message: {
							role: "user",
							content: "add gym session tuesday at 7am and confirm",
						},
					},
					{
						id: "handler",
						type: "message_handler",
						metadata: {
							plan: {
								intents: [],
							},
						},
					},
				],
			},
			config: {},
			executeToolCall,
		});
	return { run, useModel, executed };
}

/** The planner call made immediately AFTER a rejected batch (repair round). */
function repairRoundInput(useModel: ReturnType<typeof harness>["useModel"]) {
	const plannerCalls = useModel.mock.calls.filter(
		([type]) => type === ModelType.ACTION_PLANNER,
	);
	const serialized = plannerCalls.map(([, params]) =>
		JSON.stringify(params ?? {}),
	);
	const repairIndex = serialized.findIndex((text) =>
		text.includes("missing the required eliza_turn_scope"),
	);
	return repairIndex === -1 ? undefined : serialized[repairIndex];
}

function rejectedSteps(result: { trajectory: { steps: unknown[] } }) {
	return result.trajectory.steps.filter(
		(step) =>
			(step as { rejectionReason?: string }).rejectionReason ===
			"missing_or_invalid_turn_scope",
	);
}

describe("turn-scope admission after an explicit pending declaration (#30974)", () => {
	it("rejects a scope-less batch before execution and runs the corrected batch once", async () => {
		const h = harness({
			plans: [
				plan([call("READ", "more_work_pending")]),
				plan([call("NAVIGATE"), call("CONFIRM")]),
				plan([call("NAVIGATE", "final")]),
			],
			evaluations: [
				finish("Everything was completed and confirmed."),
				finish("Everything was completed and confirmed."),
			],
		});
		const result = await h.run();
		// READ executed in batch 1; the scope-less batch 2 was rejected whole;
		// only the corrected batch 3 executed.
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("Everything was completed and confirmed.");
		// Trajectory records the rejected batch as never-executed evidence.
		const steps = rejectedSteps(result);
		expect(steps).toHaveLength(1);
		expect(
			(
				steps[0] as { rejectedToolCalls?: { name: string }[] }
			).rejectedToolCalls?.map((c) => c.name),
		).toEqual(["NAVIGATE", "CONFIRM"]);
	});

	it("rejects a batch mixing valid and invalid scope declarations whole", async () => {
		const h = harness({
			plans: [
				plan([call("READ", "more_work_pending")]),
				plan([call("NAVIGATE", "final"), call("CONFIRM")]),
				plan([call("NAVIGATE", "final")]),
			],
			evaluations: [
				finish("Everything was completed and confirmed."),
				finish("Everything was completed and confirmed."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("Everything was completed and confirmed.");
		expect(rejectedSteps(result)).toHaveLength(1);
	});

	it("rejects an unrecognized scope value with the same whole-batch rule", async () => {
		const h = harness({
			plans: [
				plan([call("READ", "more_work_pending")]),
				plan([call("NAVIGATE", "done")]),
				plan([call("NAVIGATE", "final")]),
			],
			evaluations: [
				finish("Everything was completed."),
				finish("Everything was completed."),
			],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("Everything was completed.");
		expect(rejectedSteps(result)).toHaveLength(1);
	});

	it("does not execute any call from repeatedly invalid batches and stops with a typed protocol error", async () => {
		const h = harness({
			plans: [
				plan([call("READ", "more_work_pending")]),
				plan([call("NAVIGATE")]),
				plan([call("NAVIGATE")]),
				plan([call("NAVIGATE")]),
			],
			evaluations: [finish("Everything was completed.")],
		});
		await expect(h.run()).rejects.toMatchObject({
			code: "PLANNER_TURN_SCOPE_PROTOCOL",
		});
		// Only the first, valid batch executed — rejected batches mutated nothing.
		expect(h.executed).toEqual(["READ"]);
	});

	it("does not require scope on the turn's first undeclared batch", async () => {
		const h = harness({
			plans: [plan([call("READ")]), plan([call("NAVIGATE", "final")])],
			evaluations: [continueWork, finish("Everything was completed.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ", "NAVIGATE"]);
		expect(result.finalMessage).toBe("Everything was completed.");
		expect(rejectedSteps(result)).toHaveLength(0);
	});

	it("leaves JSON-lane batches exempt after a native pending declaration", async () => {
		const h = harness({
			// The JSON lane declares scope top-level via `completed`, never via
			// per-call arguments — the admission gate must stay inert for it
			// (issue criterion: keep existing JSON planner contracts).
			plans: [
				plan([call("READ", "more_work_pending")]),
				JSON.stringify({
					thought: "Checking the calendar.",
					action: "CALENDAR_READ",
					completed: false,
				}),
				JSON.stringify({
					thought: "All work is done.",
					messageToUser: "Everything was completed.",
					completed: true,
				}),
			],
			evaluations: [
				continueWork,
				finish("Everything was completed."),
				finish("Everything was completed."),
			],
		});
		const result = await h.run();
		expect(rejectedSteps(result)).toHaveLength(0);
		expect(result.finalMessage).toBe("Everything was completed.");
	});

	it("preserves the complete rejected model output and arguments in the repair context", async () => {
		const payload = { detail: "x".repeat(500) };
		const h = harness({
			plans: [
				plan([call("READ", "more_work_pending")]),
				plan([call("NAVIGATE", undefined, payload)]),
				plan([call("NAVIGATE", "final", payload)]),
			],
			evaluations: [
				finish("Everything was completed."),
				finish("Everything was completed."),
			],
		});
		await h.run();
		// The repair instruction round (planner call after the rejection) must
		// contain the complete rejected arguments — uncapped, unsummarized.
		const repair = repairRoundInput(h.useModel);
		expect(repair).toBeDefined();
		expect(repair).toContain("missing the required eliza_turn_scope");
		expect(repair).toContain("NAVIGATE");
		expect(repair).toContain(payload.detail);
	});

	it("terminal REPLY after a pending declaration stays exempt from the scope rule", async () => {
		const h = harness({
			// Round 2's REPLY is a proposed answer: the pending rule converts
			// its evaluator FINISH to CONTINUE (native REPLY is not proof the
			// pending work is done). Round 3 explicitly releases scope with a
			// settled-work repeat, finishing with the round-2 evaluator reply.
			plans: [
				plan([call("READ", "more_work_pending")]),
				{
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "The record was read." },
						},
					],
				},
				plan([call("READ", "final")]),
			],
			evaluations: [continueWork, finish("The record was read.")],
		});
		const result = await h.run();
		expect(h.executed).toEqual(["READ"]);
		expect(result.finalMessage).toBe("The record was read.");
		expect(rejectedSteps(result)).toHaveLength(0);
	});
});
