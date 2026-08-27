/**
 * Race regression tests for atomic consumption of pending confirmations.
 * The mock runtime simulates real adapter round-trips (every cache op awaits
 * a macrotask), which on the pre-fix read-then-delete implementation lets
 * two concurrent invocations interleave and both consume the same pending
 * record; the per-key mutex plus consumed tombstone must make consumption
 * single-winner. Harness is deterministic (no real timers raced outside the
 * mock's own setTimeout(0) boundaries). The affirmative race test is the
 * RED control for issue #29429: on pre-fix develop it produced
 * ["confirmed","confirmed"].
 */
import { describe, expect, it, vi } from "vitest";
import type { HandlerCallback } from "../types/components.js";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	gateDestructiveConfirmation,
	requireConfirmation,
} from "./confirmation.js";

function createDelayedMockRuntime() {
	const cacheStore = new Map<string, unknown>();
	const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
	return {
		getCache: vi.fn(async <T>(key: string): Promise<T | undefined> => {
			await tick();
			return cacheStore.get(key) as T | undefined;
		}),
		setCache: vi.fn(async (key: string, value: unknown): Promise<boolean> => {
			await tick();
			cacheStore.set(key, value);
			return true;
		}),
		deleteCache: vi.fn(async (key: string): Promise<boolean> => {
			await tick();
			return cacheStore.delete(key);
		}),
		cacheStore,
	} as unknown as IAgentRuntime & { cacheStore: Map<string, unknown> };
}

function message(text: string, id?: string): Memory {
	return {
		...(id !== undefined ? { id } : {}),
		entityId: "user-123",
		content: { text, source: "discord" },
	} as unknown as Memory;
}

function seedPending(runtime: { cacheStore: Map<string, unknown> }) {
	runtime.cacheStore.set(
		"confirmation:user-123:DELETE_ACCOUNT:account:user-123",
		{
			actionName: "DELETE_ACCOUNT",
			pendingKey: "account:user-123",
			prompt: "Delete account?",
			createdAt: Date.now(),
			ttlMs: 5 * 60_000,
			metadata: { accountId: "acc-1" },
		},
	);
}

function seedTombstone(
	runtime: { cacheStore: Map<string, unknown> },
	outcome: "confirmed" | "cancelled",
	consumedText = "yes",
) {
	runtime.cacheStore.set(
		"confirmation:user-123:DELETE_ACCOUNT:account:user-123",
		{
			consumed: true,
			outcome,
			consumedText,
			actionName: "DELETE_ACCOUNT",
			pendingKey: "account:user-123",
			createdAt: Date.now(),
			ttlMs: 5 * 60_000,
			metadata: { accountId: "acc-1" },
		},
	);
}

const confirmArgs = (runtime: IAgentRuntime, text = "yes") => ({
	runtime,
	message: message(text),
	actionName: "DELETE_ACCOUNT",
	pendingKey: "account:user-123",
	prompt: "Delete account?",
	metadata: { accountId: "acc-1" },
});

const argsWithMessage = (
	runtime: IAgentRuntime,
	msg: Memory,
	callback?: HandlerCallback,
) => ({
	runtime,
	message: msg,
	actionName: "DELETE_ACCOUNT",
	pendingKey: "account:user-123",
	prompt: "Delete account?",
	metadata: { accountId: "acc-1" },
	...(callback !== undefined ? { callback } : {}),
});

describe("atomic confirmation consumption", () => {
	it("two concurrent affirmatives yield exactly one confirmed outcome", async () => {
		const runtime = createDelayedMockRuntime();
		seedPending(runtime);

		const decisions = await Promise.all([
			requireConfirmation(confirmArgs(runtime)),
			requireConfirmation(confirmArgs(runtime)),
		]);

		const statuses = decisions.map((d) => d.status).sort();
		expect(statuses).toEqual(["cancelled", "confirmed"]);
		expect(decisions.filter((d) => d.status === "confirmed")).toHaveLength(1);
		const loser = decisions.find((d) => d.status === "cancelled");
		expect(loser?.alreadyConsumed).toBe(true);
		expect(loser?.metadata).toEqual({ accountId: "acc-1" });
	});

	it("redelivered initiating message does not consume the pending it created", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn();
		// One physical message (same id) delivered twice — duplicate delivery.
		const initiating = message("delete my account", "msg-init-1");

		const decisions = await Promise.all([
			requireConfirmation(argsWithMessage(runtime, initiating, callback)),
			requireConfirmation(argsWithMessage(runtime, initiating, callback)),
		]);

		// Both deliveries report pending; the prompt was emitted exactly
		// once and the stash remains an actionable pending record.
		expect(callback).toHaveBeenCalledTimes(1);
		expect(decisions.map((d) => d.status)).toEqual(["pending", "pending"]);
		const [record] = runtime.cacheStore.values();
		expect((record as { consumed?: boolean }).consumed).toBeUndefined();

		// The pending prompt is still answerable by the user's next message.
		const answer = await requireConfirmation(confirmArgs(runtime, "yes"));
		expect(answer.status).toBe("confirmed");
	});

	it("duplicate affirmative after a user veto stays cancelled without alreadyConsumed", async () => {
		const runtime = createDelayedMockRuntime();
		seedPending(runtime);

		// User vetoes; a racing duplicate of the veto lands right after.
		const decisions = await Promise.all([
			requireConfirmation(confirmArgs(runtime, "no, stop")),
			requireConfirmation(confirmArgs(runtime, "no, stop")),
		]);

		expect(decisions.every((d) => d.status === "cancelled")).toBe(true);
		// The winner vetoed — the duplicate is a plain cancel, not
		// "already in progress".
		expect(decisions.every((d) => d.alreadyConsumed !== true)).toBe(true);
	});

	it("tombstone of a confirmed winner reports already-consumed instead of re-prompting", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn();
		seedTombstone(runtime, "confirmed");

		const decision = await requireConfirmation({
			...confirmArgs(runtime),
			callback,
		});

		expect(decision.status).toBe("cancelled");
		expect(decision.alreadyConsumed).toBe(true);
		expect(callback).not.toHaveBeenCalled();
	});

	it("tombstone of a cancelled winner reports a plain cancel", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn();
		seedTombstone(runtime, "cancelled");

		const decision = await requireConfirmation({
			...confirmArgs(runtime),
			callback,
		});

		expect(decision.status).toBe("cancelled");
		expect(decision.alreadyConsumed).toBeUndefined();
		expect(callback).not.toHaveBeenCalled();
	});

	it("expired tombstone returns the key to fresh (new pending prompt)", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn();
		runtime.cacheStore.set(
			"confirmation:user-123:DELETE_ACCOUNT:account:user-123",
			{
				consumed: true,
				outcome: "confirmed",
				actionName: "DELETE_ACCOUNT",
				pendingKey: "account:user-123",
				createdAt: Date.now() - 10 * 60_000,
				ttlMs: 5 * 60_000,
				metadata: { accountId: "acc-1" },
			},
		);

		const decision = await requireConfirmation({
			...confirmArgs(runtime, "delete my account"),
			callback,
		});

		expect(decision.status).toBe("pending");
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("tombstone never locks out a genuinely new request", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn();
		// User vetoed "yes" a moment ago; a DIFFERENT follow-up request must
		// re-prompt immediately, not be held out for the tombstone TTL.
		seedTombstone(runtime, "cancelled", "no, stop");

		const decision = await requireConfirmation({
			...confirmArgs(runtime, "delete my account"),
			callback,
		});

		expect(decision.status).toBe("pending");
		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("callback failure unwinds the pending stash and surfaces the error", async () => {
		const runtime = createDelayedMockRuntime();
		const callback = vi.fn(async () => {
			throw new Error("channel down");
		});

		await expect(
			requireConfirmation({
				...confirmArgs(runtime, "delete my account"),
				callback,
			}),
		).rejects.toThrow("confirmation prompt delivery failed");

		// No invisible pending record survives a failed prompt delivery:
		// the next invocation must start fresh and re-emit the prompt.
		expect(runtime.cacheStore.size).toBe(0);
		const retry = await requireConfirmation({
			...confirmArgs(runtime, "delete my account"),
			callback: vi.fn(),
		});
		expect(retry.status).toBe("pending");
	});

	it("gateDestructiveConfirmation threads alreadyConsumed to the caller", async () => {
		const runtime = createDelayedMockRuntime();
		seedTombstone(runtime, "confirmed");

		const gated = await gateDestructiveConfirmation(confirmArgs(runtime));

		expect(gated.status).toBe("cancelled");
		expect(gated.alreadyConsumed).toBe(true);
	});

	it("sequential single-threaded flow is unchanged", async () => {
		const runtime = createDelayedMockRuntime();
		const first = await requireConfirmation(
			confirmArgs(runtime, "delete my account"),
		);
		expect(first.status).toBe("pending");

		const second = await requireConfirmation(confirmArgs(runtime, "yes"));
		expect(second.status).toBe("confirmed");
		expect(second.metadata).toEqual({ accountId: "acc-1" });
		expect(second.alreadyConsumed).toBeUndefined();
	});
});
