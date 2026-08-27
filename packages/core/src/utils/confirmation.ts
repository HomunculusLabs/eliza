/**
 * Unified confirmation helper for destructive actions.
 *
 * Destructive actions (delete X, clear Y, uninstall Z, send public post,
 * sign transaction, etc.) should not fire on the first invocation.
 * Instead they should:
 *   1. Stash a pending-confirmation record in the runtime cache.
 *   2. Emit a callback message describing the operation and asking the
 *      user to confirm.
 *   3. On the next turn, if the user message reads as "yes", proceed;
 *      otherwise cancel.
 *
 * This module centralizes that pattern so every destructive action
 * follows the same UX, the same TTL behavior, and the same cancel
 * semantics. Consumption of a pending record is single-winner within one
 * runtime process (per-key mutex + consumed tombstone; see
 * `requireConfirmation`).
 *
 * Usage:
 *   const decision = await requireConfirmation({
 *     runtime,
 *     message,
 *     actionName: "DELETE_LINEAR_ISSUE",
 *     pendingKey: `delete:${issueId}`,
 *     prompt: `Permanently delete issue ${humanId}? This cannot be undone.`,
 *     callback,
 *   });
 *   if (decision.status === "pending") {
 *     return { success: true, data: { awaitingUserInput: true } };
 *   }
 *   if (decision.status === "cancelled") {
 *     return { success: true, text: "Cancelled." };
 *   }
 *   // status === "confirmed" — proceed with the destructive op
 */

import { unwrapUserMessageText } from "../security/incoming-message-security";
import type { HandlerCallback } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";

const DEFAULT_TTL_MS = 5 * 60_000;

/**
 * Default broad multilingual yes detector. A single opening quote/bracket may
 * precede the token. Non-ASCII tokens terminate at Unicode punctuation,
 * symbols, whitespace, or end-of-input instead of relying on ASCII `\b`.
 * Consumers can pass a custom `confirmRegex` for a stricter contract.
 */
const DEFAULT_CONFIRM_REGEX =
	/^\s*[\p{Pi}\p{Ps}]?(?:(yes|yeah|yep|y|ok|okay|sure|confirm|confirmed|do it|go ahead|proceed|approve|approved|si|oui|ja|hai)\b|(sí|はい|确认|確認|확인)(?=[\s\p{P}\p{S}]|$))/iu;

export type ConfirmationStatus = "pending" | "confirmed" | "cancelled";

interface PendingConfirmation {
	readonly actionName: string;
	readonly pendingKey: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly metadata?: Record<string, unknown>;
	/**
	 * Identity of the message that initiated this pending confirmation.
	 * A redelivered duplicate of the initiating message (same id AND same
	 * text) must not consume the record it just created — the prompt it
	 * emitted must stay answerable. Ids are not guaranteed present and are
	 * not guaranteed unique across callers, so the initiating text is
	 * stored alongside as a secondary discriminator.
	 */
	readonly initiatingMessageId?: string;
	readonly initiatingText?: string;
}

/**
 * Tombstone written in place of a consumed pending record. Suppresses only
 * duplicates of the consuming message (canonical extracted-text equality —
 * `unwrapUserMessageText()` trims and may unwrap the security envelope —
 * plus id equality when both sides carry ids), so a racing redelivered
 * affirmative or veto-duplicate sees the winner's outcome instead of
 * re-stashing a fresh prompt a stray "yes" would re-confirm, while a
 * genuinely NEW request (different text) falls through to fresh immediately
 * and is never locked out.
 */
interface ConsumedConfirmation {
	readonly consumed: true;
	/** What the consuming invocation decided: user confirmed or vetoed. */
	readonly outcome: "confirmed" | "cancelled";
	/** Canonical user text of the consuming invocation (always present). */
	readonly consumedText: string;
	/** Id of the consuming message, when the source provides ids. */
	readonly consumedMessageId?: string;
	readonly actionName: string;
	readonly pendingKey: string;
	readonly createdAt: number;
	readonly ttlMs: number;
	readonly metadata?: Record<string, unknown>;
}

type CachedConfirmationRecord = PendingConfirmation | ConsumedConfirmation;

function isConsumedRecord(
	record: CachedConfirmationRecord | undefined | null,
): record is ConsumedConfirmation {
	return (
		record !== undefined &&
		record !== null &&
		(record as ConsumedConfirmation).consumed === true
	);
}

/**
 * Per-cacheKey promise-chain mutexes serializing every cache interaction in
 * this module. Correctness of single-winner consume derives entirely from
 * this lock: the cache interface (`getCache`/`setCache`/`deleteCache` all
 * boolean-or-value, no compare-and-delete) cannot elect a winner on its own —
 * on the SQL adapter the delete boolean means "transaction didn't throw", and
 * on the in-memory adapter it is a constant `true`.
 */
const confirmationKeyLocks = new Map<string, Promise<void>>();

function withConfirmationKeyLock<T>(
	cacheKey: string,
	section: () => Promise<T>,
): Promise<T> {
	const previous = confirmationKeyLocks.get(cacheKey) ?? Promise.resolve();
	// Run the section whichever way the predecessor settled.
	const result = previous.then(section, section);
	const tail = result.then(
		() => undefined,
		() => undefined,
	);
	confirmationKeyLocks.set(cacheKey, tail);
	void tail.then(() => {
		if (confirmationKeyLocks.get(cacheKey) === tail) {
			confirmationKeyLocks.delete(cacheKey);
		}
	});
	return result;
}

export interface RequireConfirmationArgs {
	runtime: IAgentRuntime;
	message: Memory;
	/** Action name doing the destructive op. Used in the cache key + emitted prompt. */
	actionName: string;
	/**
	 * Stable key identifying the specific pending operation, e.g.
	 * `delete:${issueId}`. Combined with the user id and action name to
	 * form the cache key. Two simultaneous pending confirmations with
	 * the same pendingKey for the same user are not supported.
	 */
	pendingKey: string;
	/** Human-readable prompt the user sees. */
	prompt: string;
	/** Optional callback for emitting the prompt; if omitted, the
	 * caller is expected to deliver `prompt` via its own mechanism. */
	callback?: HandlerCallback;
	/** TTL for the pending record. Default 5 minutes. */
	ttlMs?: number;
	/** Custom yes detector. */
	confirmRegex?: RegExp;
	/** Optional structured metadata to stash on the pending record (passed back on confirm). */
	metadata?: Record<string, unknown>;
}

export interface ConfirmationDecision {
	status: ConfirmationStatus;
	/** When status is "confirmed" or "cancelled", this is the metadata
	 * that was stashed when the confirmation was first requested. */
	metadata?: Record<string, unknown>;
	/**
	 * True only when status is "cancelled" BECAUSE a concurrent invocation
	 * already consumed the same pending confirmation — never a user veto.
	 * The winner of that race has already returned "confirmed"; callers can
	 * render "already in progress" instead of "Cancelled." and key
	 * caller-side dedupe on the returned metadata.
	 */
	alreadyConsumed?: boolean;
}

function buildCacheKey(
	userId: string,
	actionName: string,
	pendingKey: string,
): string {
	return `confirmation:${userId}:${actionName}:${pendingKey}`;
}

/**
 * True when this invocation is a redelivery of the exact message that
 * created the pending record: both message ids are present and equal AND
 * the canonical extracted text is identical (`unwrapUserMessageText()`
 * trims and may unwrap the security envelope — comparison is on that
 * canonical form, not raw bytes). Text alone is insufficient (a user may
 * legitimately repeat the request text and expect a fresh prompt); id alone
 * is insufficient (test harnesses and some sources reuse ids across turns).
 */
function isRedeliveredInitiatingMessage(
	args: RequireConfirmationArgs,
	existing: PendingConfirmation,
	userText: string,
): boolean {
	return (
		args.message.id !== undefined &&
		existing.initiatingMessageId !== undefined &&
		String(args.message.id) === existing.initiatingMessageId &&
		existing.initiatingText === userText
	);
}

/**
 * True when this invocation duplicates the message that consumed the
 * confirmation (canonical extracted text equal; ids equal when the
 * tombstone recorded one). Suppresses only racing redeliveries of the
 * consuming message — a different-text request falls through and re-prompts.
 */
function isDuplicateOfConsumedMessage(
	args: RequireConfirmationArgs,
	existing: ConsumedConfirmation,
	userText: string,
): boolean {
	if (existing.consumedText !== userText) {
		return false;
	}
	if (existing.consumedMessageId === undefined) {
		return true;
	}
	return (
		args.message.id !== undefined &&
		String(args.message.id) === existing.consumedMessageId
	);
}

function readUserText(message: Memory): string {
	return unwrapUserMessageText(message);
}

/**
 * Two-phase destructive-action helper.
 *
 * Returns:
 *   - `{ status: "pending" }` on the FIRST invocation (no record in cache yet).
 *     The helper has stashed the record and (if `callback` is provided) emitted
 *     the prompt. Caller should return early without performing the op.
 *
 *   - `{ status: "confirmed", metadata }` on the SECOND invocation when the user
 *     replied with a yes-shaped message. The pending record has been consumed.
 *     Caller should perform the destructive op.
 *
 *   - `{ status: "cancelled", metadata }` on the SECOND invocation when the user
 *     replied with a no-shaped message OR anything not matching yes. The pending
 *     record has been consumed. Caller should not perform the op.
 *
 *   - `{ status: "cancelled", metadata, alreadyConsumed: true }` when this
 *     invocation raced a concurrent affirmative for the same pending record
 *     and LOST — exactly one concurrent invocation ever receives "confirmed";
 *     the loser must not perform the op (the winner already did).
 *
 * Consume atomicity: consumption is serialized per cache key within one
 * runtime process by an in-process mutex, and a short-TTL consumed tombstone
 * prevents a losing sibling (including, best-effort, one in another process
 * sharing the same cache) from re-stashing a fresh pending prompt that a
 * stray later "yes" would re-confirm. At-most-once is NOT guaranteed across
 * multiple processes: the runtime cache interface exposes no atomic
 * consume/compare-and-delete primitive. Irreversible external effects (chain
 * transfers, public posts) must be idempotent or dedupe caller-side keyed on
 * the returned metadata.
 *
 * Expired pending records (older than ttlMs) are treated as fresh first calls.
 */
export async function requireConfirmation(
	args: RequireConfirmationArgs,
): Promise<ConfirmationDecision> {
	const ttlMs =
		typeof args.ttlMs === "number" &&
		Number.isFinite(args.ttlMs) &&
		args.ttlMs > 0
			? args.ttlMs
			: DEFAULT_TTL_MS;
	const cacheKey = buildCacheKey(
		String(args.message.entityId),
		args.actionName,
		args.pendingKey,
	);
	return withConfirmationKeyLock(
		`${String(args.runtime.agentId ?? "")}:${cacheKey}`,
		() => consumeOrStashConfirmation(args, cacheKey, ttlMs),
	);
}

async function consumeOrStashConfirmation(
	args: RequireConfirmationArgs,
	cacheKey: string,
	ttlMs: number,
): Promise<ConfirmationDecision> {
	const confirmRegex = args.confirmRegex ?? DEFAULT_CONFIRM_REGEX;
	const userText = readUserText(args.message);

	const existing =
		await args.runtime.getCache<CachedConfirmationRecord>(cacheKey);
	const now = Date.now();

	if (isConsumedRecord(existing)) {
		if (
			now - existing.createdAt <= existing.ttlMs &&
			isDuplicateOfConsumedMessage(args, existing, userText)
		) {
			// Duplicate of the message that consumed this confirmation
			// moments ago (racing redelivery, usually serialized behind the
			// mutex). Do not re-stash a fresh prompt; report the winner's
			// outcome. alreadyConsumed is reserved for a confirmed winner
			// (operation already executed); after a user veto the duplicate
			// is simply cancelled. A genuinely new request (different text)
			// falls through to the fresh path — the tombstone never locks
			// out new work.
			return {
				status: "cancelled",
				metadata: existing.metadata,
				alreadyConsumed: existing.outcome === "confirmed" || undefined,
			};
		}
	} else if (existing) {
		if (now - existing.createdAt > existing.ttlMs) {
			await args.runtime.deleteCache(cacheKey);
		} else if (isRedeliveredInitiatingMessage(args, existing, userText)) {
			// Redelivered duplicate of the message that created this pending
			// record. Consuming it here would invalidate the prompt the
			// first delivery already emitted; treat as idempotent re-ask —
			// the record stays pending and the prompt is not re-emitted.
			// (A delivery whose callback FAILED unwinds the stash before
			// returning, so this branch can never suppress re-emission.)
			return { status: "pending" };
		} else {
			// Live pending record — consume it. The consumed tombstone (in
			// place of a bare delete) is what a racing sibling reads instead
			// of undefined, so it cannot take the fresh path and re-prime a
			// second execution. Tombstone TTL reuses the caller's ttlMs so
			// duplicate deliveries within the confirmation window are
			// absorbed; only duplicates of the consuming message are
			// suppressed, so new requests are never locked out.
			const status: ConfirmationStatus = confirmRegex.test(userText)
				? "confirmed"
				: "cancelled";
			const tombstone: ConsumedConfirmation = {
				consumed: true,
				outcome: status,
				consumedText: userText,
				consumedMessageId:
					args.message.id !== undefined ? String(args.message.id) : undefined,
				actionName: args.actionName,
				pendingKey: args.pendingKey,
				createdAt: now,
				ttlMs,
				metadata: existing.metadata,
			};
			await args.runtime.setCache(cacheKey, tombstone);
			return { status, metadata: existing.metadata };
		}
	}

	const record: PendingConfirmation = {
		actionName: args.actionName,
		pendingKey: args.pendingKey,
		prompt: args.prompt,
		createdAt: now,
		ttlMs,
		metadata: args.metadata,
		initiatingMessageId:
			args.message.id !== undefined ? String(args.message.id) : undefined,
		initiatingText: userText,
	};
	await args.runtime.setCache(cacheKey, record);
	if (args.callback) {
		try {
			await args.callback({
				text: args.prompt,
				source: args.message.content.source,
			});
		} catch (error) {
			// The user may never have seen the prompt. Unwind the stash so
			// the pending record cannot suppress a later re-emission (the
			// duplicate-redelivery branch must never answer "pending" for a
			// prompt that failed to deliver), then surface the failure.
			// error-policy:J2 — wrap with typed context and preserve cause.
			await args.runtime.deleteCache(cacheKey);
			throw new Error(
				`confirmation prompt delivery failed for ${args.actionName}; pending record unwound`,
				{ cause: error },
			);
		}
	}
	return { status: "pending" };
}

/**
 * Clear a pending confirmation without resolving it. Useful for callers
 * that want to abandon a prior pending op (e.g. when a different action
 * supersedes the one awaiting confirmation). Runs under the same per-key
 * mutex as consumption, so it cannot interleave with a concurrent consume;
 * abandon-vs-consume against a racing consumer is last-writer-wins.
 */
export async function clearPendingConfirmation(args: {
	runtime: IAgentRuntime;
	userId: string;
	actionName: string;
	pendingKey: string;
}): Promise<void> {
	const cacheKey = buildCacheKey(args.userId, args.actionName, args.pendingKey);
	await withConfirmationKeyLock(
		`${String(args.runtime.agentId ?? "")}:${cacheKey}`,
		async () => {
			await args.runtime.deleteCache(cacheKey);
		},
	);
}

export type DestructiveConfirmationGateResult =
	| {
			readonly status: "confirmed";
			readonly metadata?: Record<string, unknown>;
	  }
	| { readonly status: "pending" }
	| {
			readonly status: "cancelled";
			readonly metadata?: Record<string, unknown>;
			/** Concurrent sibling already consumed this confirmation. */
			readonly alreadyConsumed?: boolean;
	  };

/**
 * Thin wrapper around {@link requireConfirmation} for destructive action handlers.
 * Never consult LLM `confirmed` params — only user yes/no on a follow-up turn.
 */
export async function gateDestructiveConfirmation(
	args: RequireConfirmationArgs,
): Promise<DestructiveConfirmationGateResult> {
	const decision = await requireConfirmation(args);
	if (decision.status === "confirmed") {
		return { status: "confirmed", metadata: decision.metadata };
	}
	if (decision.status === "pending") {
		return { status: "pending" };
	}
	return {
		status: "cancelled",
		metadata: decision.metadata,
		alreadyConsumed: decision.alreadyConsumed,
	};
}

/** LLM `confirmed: true` must not authorize destructive ops (GHSA-rqm7 class). */
export function llmConfirmedFlagIsAuthoritative(_value: unknown): boolean {
	return false;
}
