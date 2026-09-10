/** Enforces effect-grounded replies and trusted audience admission at every message egress boundary. */

import {
	parseEgressDisclosureSubject,
	resolveEgressAudienceAdmission,
} from "../../access-control/audience-egress";
import { ElizaError } from "../../errors";
import {
	effectDeliveryBindingIsValid,
	effectDeliveryBindingProvesApplication,
	getEffectDeliveryBinding,
	stripEffectDeliveryBinding,
} from "../../runtime/effect-delivery";
import type { EvaluatorOutput } from "../../runtime/evaluator";
import { renderActionResultsForModel } from "../../runtime/planner-rendering";
import {
	getTrustedDeliveryAudience,
	ownerExclusiveDisclosureWasUsed,
	PRIVACY_DENIED_TEXT,
	revalidateOwnerExclusiveDisclosure,
} from "../../security/trusted-delivery-audience";
import type { Action, ActionResult } from "../../types/components";
import {
	type EffectBearingResult,
	mergeEffectReceipts,
	resolveAppliedUserFacingEffectReceipts,
} from "../../types/effects";
import type { Memory } from "../../types/memory";
import type { Content } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import { isObjectRecord as isRecord } from "../../utils/type-guards";
import { resolveCallbackActionName } from "./action-identifiers.js";
import { rewriteActionCallbackInCharacter } from "./delivery.js";
import { normalizeActionIdentifier } from "./direct-action-heuristics";
import {
	financialClaimMatchesOperation,
	financialClaimOperationFamily,
	type NumericalTokenHoldingClaim,
	numericalTokenHoldingClaims,
	replyClaimsCompletedFinancialMutation,
	replyClaimsCompletedSideEffect,
	replyClaimsEmptyTrackedWorkState,
	replyClaimsNumericalTokenHolding,
} from "./side-effect-claims.ts";

export type PlannedReplyClaimKind =
	| "completed_side_effect"
	| "empty_tracked_state"
	| "completed_financial_mutation"
	| "numerical_token_holding";

export function appliedEffectReceiptIdsForReply(
	reply: string,
	results: readonly ActionResult[],
	evaluator?: EvaluatorOutput,
): readonly string[] {
	const normalizedReply = reply.trim();
	if (!normalizedReply) return [];
	const allTurnReceipts = mergeEffectReceipts(
		...results.map((result) => result.effectReceipts),
	);
	// Keep the model's proof attached to its original prose. Planner fallbacks,
	// sanitizers and hooks must not borrow these IDs for a different message.
	if (
		evaluator?.decision === "FINISH" &&
		!evaluator.protocolFailure &&
		evaluator.messageToUser?.trim() === normalizedReply &&
		typeof evaluator.raw?.messageToUser === "string" &&
		evaluator.raw.messageToUser.trim() === normalizedReply
	) {
		const receipts = resolveAppliedUserFacingEffectReceipts(
			{
				verifiedUserFacing: true,
				userFacingText: normalizedReply,
				userFacingEffectReceiptIds: evaluator.effectReceiptIds,
			},
			allTurnReceipts,
		);
		if (receipts) return receipts.map((receipt) => receipt.receiptId);
	}
	for (const result of results) {
		if (result.userFacingText?.trim() !== normalizedReply) continue;
		const receipts = resolveAppliedUserFacingEffectReceipts(
			result,
			allTurnReceipts,
		);
		if (receipts) {
			return receipts.map((receipt) => receipt.receiptId);
		}
	}
	return [];
}

/**
 * Receipt IDs from this turn that ground a financial mutation claim: applied
 * (or verified replayed no-op) receipts whose operation belongs to the family
 * the claim names (#30958). Unlike the scheduling tier, the grounding need
 * not be byte-exact action-owned text — the planner routinely paraphrases a
 * submitted wallet result — but the operation family must match: a swap
 * receipt can never substantiate a transfer claim.
 */
export function financialClaimGroundingReceiptIds(
	reply: string,
	results: readonly ActionResult[],
	evaluator?: EvaluatorOutput,
): readonly string[] {
	const normalizedReply = reply.trim();
	if (!normalizedReply) return [];
	const family = financialClaimOperationFamily(normalizedReply);
	if (!family) return [];
	const allTurnReceipts = mergeEffectReceipts(
		...results.map((result) => result.effectReceipts),
	);
	const candidates: EffectBearingResult[] = [...results];
	// An evaluator-authored FINISH that exactly matches the reply is also
	// admitted, mirroring appliedEffectReceiptIdsForReply's provenance rule.
	if (
		evaluator?.decision === "FINISH" &&
		!evaluator.protocolFailure &&
		evaluator.messageToUser?.trim() === normalizedReply
	) {
		candidates.push({
			verifiedUserFacing: true,
			userFacingText: normalizedReply,
			userFacingEffectReceiptIds: evaluator.effectReceiptIds,
		});
	}
	const groundingIds: string[] = [];
	for (const result of candidates) {
		const resolved = resolveAppliedUserFacingEffectReceipts(
			result,
			allTurnReceipts,
		);
		if (!resolved) continue;
		for (const receipt of resolved) {
			if (
				financialClaimMatchesOperation(
					family,
					normalizedReply,
					receipt.operation,
				)
			) {
				groundingIds.push(receipt.receiptId);
			}
		}
	}
	return groundingIds;
}

/**
 * A token quantity this turn actually observed for a symbol, from a wallet
 * read result or wallet provider state (#30960). `source` names where it came
 * from so diagnostics can tell an action observation from a provider one.
 */
export interface BalanceObservation {
	readonly symbol: string;
	readonly amount: number;
	readonly source: string;
}

// Relative tolerance when comparing a claimed quantity to an observation: the
// provider surfaces rounded fixed(6) amounts, so 4.0000004 vs 4 must match.
const BALANCE_MATCH_RELATIVE_TOLERANCE = 1e-9;
// Absolute floor: amounts smaller than this (dust) compare exactly.
const BALANCE_MATCH_ABSOLUTE_TOLERANCE = 1e-9;

function balanceClaimMatchesObservation(
	claim: NumericalTokenHoldingClaim,
	observation: BalanceObservation,
): boolean {
	if (claim.symbol !== observation.symbol) return false;
	const delta = Math.abs(claim.amount - observation.amount);
	return (
		delta <= BALANCE_MATCH_ABSOLUTE_TOLERANCE ||
		delta <=
			BALANCE_MATCH_RELATIVE_TOLERANCE *
				Math.max(Math.abs(claim.amount), Math.abs(observation.amount))
	);
}

function parseFiniteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseFloat(value.replace(/,/g, ""));
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

/**
 * Balance observations from this turn's successful WALLET `search_address`
 * (Birdeye portfolio) results. The routed result's `data` carries
 * `results: [{ address, chain, result: { data: { items: [...] } } }]`; each
 * item's `uiAmount` is the token quantity and `symbol` the ticker. Failed,
 * unavailable, and non-search_address results contribute nothing — an
 * unrelated success must never stand in for a balance (#30960).
 */
function balanceObservationsFromActionResults(
	results: readonly ActionResult[],
): BalanceObservation[] {
	const observations: BalanceObservation[] = [];
	for (const result of results) {
		if (result.success !== true) continue;
		const data = result.data as Record<string, unknown> | undefined;
		if (
			data?.actionName !== "WALLET" ||
			data.subaction !== "search_address"
		) {
			continue;
		}
		const routed = data.results;
		if (!Array.isArray(routed)) continue;
		for (const entry of routed) {
			const record = entry as Record<string, unknown> | null;
			const nested = record?.result as Record<string, unknown> | undefined;
			const items = nested?.data
				? (nested.data as Record<string, unknown>).items
				: undefined;
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				const itemRecord = item as Record<string, unknown>;
				const symbol =
					typeof itemRecord.symbol === "string"
						? itemRecord.symbol.toUpperCase()
						: undefined;
				const amount = parseFiniteNumber(itemRecord.uiAmount);
				if (symbol && amount !== undefined && amount >= 0) {
					observations.push({
						symbol,
						amount,
						source: "wallet.search_address",
					});
				}
			}
		}
	}
	return observations;
}

/**
 * Balance observations from wallet provider state values: the Solana wallet
 * provider's `token_<i>_symbol` / `token_<i>_amount` pairs and the EVM
 * `tokenBalanceProvider`'s `token` / `balance` pair. Valuation keys
 * (`total_sol`, `*_usd`, `*_sol` on portfolio totals, `*_price`) are
 * deliberately NOT observations — a SOL valuation is not a SOL holding, and a
 * USD price is not a token quantity (#30960 acceptance criteria).
 */
function balanceObservationsFromStateValues(
	values: Record<string, unknown> | undefined,
): BalanceObservation[] {
	const observations: BalanceObservation[] = [];
	if (!values || typeof values !== "object") return observations;
	// Solana wallet provider: indexed token rows.
	const symbolByIndex = new Map<number, string>();
	for (const [key, value] of Object.entries(values)) {
		const rowMatch = /^token_(\d+)_symbol$/.exec(key);
		if (rowMatch && typeof value === "string") {
			symbolByIndex.set(Number(rowMatch[1]), value.toUpperCase());
		}
	}
	for (const [key, value] of Object.entries(values)) {
		const rowMatch = /^token_(\d+)_amount$/.exec(key);
		if (!rowMatch) continue;
		const index = Number(rowMatch[1]);
		const symbol = symbolByIndex.get(index);
		const amount = parseFiniteNumber(value);
		if (symbol && amount !== undefined && amount >= 0) {
			observations.push({ symbol, amount, source: "provider.values" });
		}
	}
	// EVM tokenBalanceProvider: single `token` / `balance` pair.
	const evmToken =
		typeof values.token === "string" ? values.token.toUpperCase() : undefined;
	const evmBalance = parseFiniteNumber(values.balance);
	if (evmToken && evmBalance !== undefined && evmBalance >= 0) {
		observations.push({
			symbol: evmToken,
			amount: evmBalance,
			source: "provider.values",
		});
	}
	return observations;
}

/**
 * True when every numerical token-holding claim in the reply is grounded by a
 * matching balance observation from this turn's wallet reads or wallet
 * provider state (#30960). Mismatched, missing, and partial grounding all
 * reject; valuation observations never ground a holding claim.
 */
export function numericalHoldingClaimIsGrounded(args: {
	reply: string;
	results: readonly ActionResult[];
	stateValues?: Record<string, unknown>;
}): boolean {
	const claims = numericalTokenHoldingClaims(args.reply);
	if (claims.length === 0) return true;
	const observations = [
		...balanceObservationsFromActionResults(args.results),
		...balanceObservationsFromStateValues(args.stateValues),
	];
	return claims.every((claim) =>
		observations.some((observation) =>
			balanceClaimMatchesObservation(claim, observation),
		),
	);
}

/**
 * An action result grounds only the capability it actually proves.
 * Empty tracked-work claims require a `resource:tracked-work` read action.
 * Completion claims require exact action-owned or evaluator-authored text bound to an active
 * committed receipt from this turn — applied, or a replayed no-op proving the
 * desired state was already committed; bare success, previews, non-replayed
 * no-ops, failures, and rolled-back effects cannot ground them. Financial
 * mutation claims additionally require a receipt from the claimed operation
 * family (see {@link financialClaimGroundingReceiptIds}).
 */
export function plannedReplyHasClaimGroundingReceipt(args: {
	kind: PlannedReplyClaimKind;
	reply: string;
	results: readonly ActionResult[];
	actions: readonly Action[];
	evaluator?: EvaluatorOutput;
	stateValues?: Record<string, unknown>;
}): boolean {
	if (args.kind === "numerical_token_holding") {
		return numericalHoldingClaimIsGrounded({
			reply: args.reply,
			results: args.results,
			stateValues: args.stateValues,
		});
	}
	if (args.kind === "completed_financial_mutation") {
		return (
			financialClaimGroundingReceiptIds(
				args.reply,
				args.results,
				args.evaluator,
			).length > 0
		);
	}
	if (args.kind === "completed_side_effect") {
		return (
			appliedEffectReceiptIdsForReply(args.reply, args.results, args.evaluator)
				.length > 0
		);
	}
	const actionsByName = new Map(
		args.actions.map((action) => [
			normalizeActionIdentifier(action.name),
			action,
		]),
	);
	return args.results.some((result) => {
		const canonicalUserFacingText = result.userFacingText?.trim();
		if (
			result.verifiedUserFacing !== true ||
			!canonicalUserFacingText ||
			canonicalUserFacingText !== args.reply.trim()
		) {
			return false;
		}
		if (result.success !== true) return false;
		const actionName =
			typeof result.data?.actionName === "string" ? result.data.actionName : "";
		const action = actionsByName.get(normalizeActionIdentifier(actionName));
		if (!action) return false;
		const tags = new Set(
			(action.tags ?? []).map((tag) => tag.trim().toLowerCase()),
		);
		if (args.kind === "empty_tracked_state") {
			if (!tags.has("resource:tracked-work") || !tags.has("capability:read")) {
				return false;
			}
			const isMixedMutationSurface = [
				"capability:write",
				"capability:update",
				"capability:delete",
				"capability:schedule",
			].some((tag) => tags.has(tag));
			if (!isMixedMutationSurface) return true;
			const claimGrounding = result.data?.claimGrounding;
			return (
				Array.isArray(claimGrounding) &&
				claimGrounding.includes("empty_tracked_state")
			);
		}
		return false;
	});
}

/** Egress decision for a planner-composed final reply (see below). */
export type PlannedReplyEgressDecision =
	| { verdict: "allow" }
	| {
			verdict: "reject";
			kind: PlannedReplyClaimKind;
	  };

/**
 * Final planned replies may assert only state proven by a matching action
 * receipt from this trajectory. Rejection degrades to an honest statement at
 * this boundary; it never starts a second planner trajectory, which would lose
 * the first trajectory's results and could replay a partially-applied effect.
 */
export function evaluatePlannedReplyEgress(args: {
	reply: string;
	actionResults: readonly ActionResult[];
	actions: readonly Action[];
	evaluator?: EvaluatorOutput;
	stateValues?: Record<string, unknown>;
}): PlannedReplyEgressDecision {
	const reply = args.reply.trim();
	if (!reply) return { verdict: "allow" };
	if (replyClaimsCompletedFinancialMutation(reply)) {
		if (
			!plannedReplyHasClaimGroundingReceipt({
				kind: "completed_financial_mutation",
				reply,
				results: args.actionResults,
				actions: args.actions,
				evaluator: args.evaluator,
			})
		) {
			return {
				verdict: "reject",
				kind: "completed_financial_mutation",
			};
		}
		// A grounded mutation claim may sit beside a numerical holding claim
		// ("transfer sent; your balance is now 3 SOL") — keep evaluating.
	}
	if (replyClaimsNumericalTokenHolding(reply)) {
		if (
			!plannedReplyHasClaimGroundingReceipt({
				kind: "numerical_token_holding",
				reply,
				results: args.actionResults,
				actions: args.actions,
				stateValues: args.stateValues,
			})
		) {
			return {
				verdict: "reject",
				kind: "numerical_token_holding",
			};
		}
	}
	if (replyClaimsCompletedSideEffect(reply)) {
		if (
			plannedReplyHasClaimGroundingReceipt({
				kind: "completed_side_effect",
				reply,
				results: args.actionResults,
				actions: args.actions,
				evaluator: args.evaluator,
			})
		) {
			return { verdict: "allow" };
		}
		return {
			verdict: "reject",
			kind: "completed_side_effect",
		};
	}
	if (replyClaimsEmptyTrackedWorkState(reply)) {
		if (
			plannedReplyHasClaimGroundingReceipt({
				kind: "empty_tracked_state",
				reply,
				results: args.actionResults,
				actions: args.actions,
			})
		) {
			return { verdict: "allow" };
		}
		return {
			verdict: "reject",
			kind: "empty_tracked_state",
		};
	}
	return { verdict: "allow" };
}

/**
 * Recover missing or ungrounded final prose without replaying actions. The
 * existing action-response renderer receives the request and complete settled
 * results; its output must pass the same receipt checks as the original reply.
 */
export async function resolvePlannedReplyEgress(args: {
	runtime: IAgentRuntime;
	message: Memory;
	reply: string;
	actionResults: readonly ActionResult[];
	evaluator?: EvaluatorOutput;
	stateValues?: Record<string, unknown>;
}): Promise<{ text: string; effectReceiptIds: readonly string[] }> {
	const decision = evaluatePlannedReplyEgress({
		reply: args.reply,
		actionResults: args.actionResults,
		actions: args.runtime.actions,
		evaluator: args.evaluator,
		stateValues: args.stateValues,
	});
	if (args.reply.trim() && decision.verdict === "allow") {
		const financialGrounding = financialClaimGroundingReceiptIds(
			args.reply,
			args.actionResults,
			args.evaluator,
		);
		if (financialGrounding.length > 0) {
			return { text: args.reply, effectReceiptIds: financialGrounding };
		}
		return {
			text: args.reply,
			effectReceiptIds: appliedEffectReceiptIdsForReply(
				args.reply,
				args.actionResults,
				args.evaluator,
			),
		};
	}
	const text = JSON.stringify({
		request: args.message.content,
		rejectedReply: args.reply,
		reason: decision.verdict === "reject" ? decision.kind : "missing_reply",
		results: renderActionResultsForModel([...args.actionResults]).text,
	});
	const rewritten = await rewriteActionCallbackInCharacter({
		runtime: args.runtime,
		message: args.message,
		response: { text },
		text,
	});
	const reply = rewritten?.text;
	// The renderer selects proof for its own prose, not an action's canned
	// wording. Resolve every selected ID against this turn's authoritative
	// receipts; invented IDs, previews and rolled-back effects stay rejected.
	const proof = rewritten?.effectReceiptIds.length
		? resolveAppliedUserFacingEffectReceipts(
				{
					verifiedUserFacing: true,
					userFacingText: reply,
					userFacingEffectReceiptIds: rewritten.effectReceiptIds,
				},
				mergeEffectReceipts(
					...args.actionResults.map((result) => result.effectReceipts),
				),
			)
		: null;
	const rewrittenDecision = reply
		? evaluatePlannedReplyEgress({
				reply,
				actionResults: args.actionResults,
				actions: args.runtime.actions,
			})
		: undefined;
	if (
		!reply ||
		(rewritten?.effectReceiptIds.length && !proof) ||
		(rewrittenDecision?.verdict !== "allow" &&
			!(rewrittenDecision?.kind === "completed_side_effect" && proof) &&
			!(
				rewrittenDecision?.kind === "completed_financial_mutation" &&
				financialClaimGroundingReceiptIds(reply, args.actionResults).length > 0
			) &&
			!(
				rewrittenDecision?.kind === "numerical_token_holding" &&
				numericalHoldingClaimIsGrounded({
					reply,
					results: args.actionResults,
					stateValues: args.stateValues,
				})
			))
	) {
		const error = new ElizaError(
			"A grounded conversational reply could not be generated",
			{
				code: "REPLY_GROUNDING_FAILED",
				context: { roomId: args.message.roomId, messageId: args.message.id },
			},
		);
		args.runtime.reportError("MessageService.replyRecovery", error);
		throw error;
	}
	return {
		text: reply,
		effectReceiptIds:
			proof?.map((receipt) => receipt.receiptId) ??
			appliedEffectReceiptIdsForReply(reply, args.actionResults) ??
			[],
	};
}

export async function enforceEffectGroundedVisibleContent(
	runtime: IAgentRuntime,
	message: Memory,
	response: Content,
	actionName?: string,
): Promise<Content> {
	const hasEffectDeliveryBinding =
		getEffectDeliveryBinding(response) !== undefined;
	if (!hasEffectDeliveryBinding && response.effectReceiptIds !== undefined) {
		response = stripEffectDeliveryBinding(response);
	}
	const effectDeliveryBindingInvalid =
		hasEffectDeliveryBinding && !effectDeliveryBindingIsValid(response);
	if (
		effectDeliveryBindingInvalid ||
		(typeof response.text === "string" &&
			replyClaimsCompletedSideEffect(response.text) &&
			!effectDeliveryBindingProvesApplication(response))
	) {
		runtime.logger.warn(
			{
				src: "service:message",
				actionName: resolveCallbackActionName(response, actionName),
			},
			"Replaced visible completion text that lacked validated effect receipt bindings",
		);
		return {
			...stripEffectDeliveryBinding(response),
			text: (
				await resolvePlannedReplyEgress({
					runtime,
					message,
					reply: response.text ?? "",
					actionResults: [],
				})
			).text,
			agentVoiced: true,
		};
	}
	return response;
}

/**
 * Withhold a response whose declared disclosure subject the attested delivery
 * audience does not admit in FULL. Built from constants so nothing from the
 * withheld payload survives; `privacyReason` carries `audience_admission` plus
 * the min level the room earned, so the model-visible note and downstream
 * tooling can tell an audience-admission withholding apart from the
 * owner-exclusive revalidation denial.
 */
export function audienceAdmissionWithheld(
	runtime: IAgentRuntime,
	message: Memory,
	level: "redacted" | "none",
	blockingCount: number,
): Content {
	runtime.logger.warn(
		{
			src: "service:message",
			messageId: message.id,
			roomId: message.roomId,
			admissionLevel: level,
			blockingCount,
		},
		"Withheld scoped response the delivery audience does not admit in full",
	);
	return {
		text: PRIVACY_DENIED_TEXT,
		actions: ["PRIVACY_DENIED"],
		data: {
			privacyDenied: true,
			privacyReason: `audience_admission:${level}`,
		},
	};
}

/**
 * Enforce min-over-members audience admission at egress for a response that
 * declares the disclosure subject it requires of its recipients
 * (`content.data.disclosureSubject`). The attested delivery audience is joined
 * with the subject through the pure policy core
 * ({@link resolveEgressAudienceAdmission}); anything short of a FULL admission
 * withholds the response. Fail-closed: a declared subject with NO attested
 * audience earns nothing and is withheld, so a scoped reply cannot ship into an
 * unverified room. A response with no declared subject is not narrowed here and
 * falls through to the caller's other egress checks unchanged.
 */
export function enforceAudienceAdmissionAtEgress(
	runtime: IAgentRuntime,
	message: Memory,
	response: Content,
): Content {
	const data = isRecord(response.data) ? response.data : undefined;
	if (!data || !("disclosureSubject" in data)) return response;
	const subject = parseEgressDisclosureSubject(data.disclosureSubject);
	// A `disclosureSubject` key present but unparseable never means "unscoped":
	// `parseEgressDisclosureSubject` fails closed to owner-private, so `subject`
	// is defined whenever the key exists. Guard anyway for undefined markers.
	if (!subject) return response;
	const audience = getTrustedDeliveryAudience(message);
	if (!audience) {
		// A scoped response with no attested audience earns nothing — withhold
		// rather than ship into an unverified room. (Not an error-policy case:
		// there is no catch here, and tagging an ordinary guard pollutes the
		// grep that exists to audit retained catches.)
		return audienceAdmissionWithheld(runtime, message, "none", 0);
	}
	const admission = resolveEgressAudienceAdmission(subject, audience);
	if (admission.level === "full") return response;
	return audienceAdmissionWithheld(
		runtime,
		message,
		admission.level,
		admission.blockingEntityIds.length,
	);
}

/**
 * Revalidate a turn that consumed owner-private data immediately before any
 * visible or durable egress. The replacement is constructed from constants so
 * no text, attachment, or structured payload from the private result survives.
 *
 * Two independent, both-fail-closed seams run here: first the per-recipient
 * audience-admission check for a response that declares its own disclosure
 * subject ({@link enforceAudienceAdmissionAtEgress}), then the owner-exclusive
 * revalidation for turns that consumed owner-private context. Either may
 * withhold; a withholding from the first short-circuits the second because its
 * replacement carries no owner-private data to revalidate.
 */
export async function enforceTrustedDeliveryAudienceAtEgress(
	runtime: IAgentRuntime,
	message: Memory,
	response: Content,
): Promise<Content> {
	const admissionChecked = enforceAudienceAdmissionAtEgress(
		runtime,
		message,
		response,
	);
	if (admissionChecked !== response) return admissionChecked;
	if (!ownerExclusiveDisclosureWasUsed(message)) return response;
	const disclosure = await revalidateOwnerExclusiveDisclosure(runtime, message);
	if (disclosure.allowed) return response;
	runtime.logger.warn(
		{
			src: "service:message",
			messageId: message.id,
			roomId: message.roomId,
			reason: disclosure.reason,
		},
		"Suppressed owner-private response after delivery audience changed",
	);
	return {
		text: PRIVACY_DENIED_TEXT,
		actions: ["PRIVACY_DENIED"],
		data: {
			privacyDenied: true,
			privacyReason: disclosure.reason,
		},
	};
}

/**
 * Apply the final audience check to the complete message-service result shape.
 * Actions mode can accumulate several response memories, so a denied turn must
 * replace every one rather than sanitizing only the top-level chat content.
 */
export async function enforceTrustedDeliveryAudienceOnResult(
	runtime: IAgentRuntime,
	message: Memory,
	responseContent: Content | null,
	responseMessages: Memory[],
): Promise<{
	responseContent: Content | null;
	responseMessages: Memory[];
}> {
	// Two egress seams can withhold here: the owner-exclusive revalidation (only
	// relevant when the turn consumed owner-private data) and the per-recipient
	// audience-admission check (relevant whenever the response declares its own
	// disclosure subject). Skip the pass only when NEITHER can fire.
	const declaresDisclosureSubject =
		isRecord(responseContent?.data) &&
		"disclosureSubject" in responseContent.data;
	if (!ownerExclusiveDisclosureWasUsed(message) && !declaresDisclosureSubject) {
		return { responseContent, responseMessages };
	}
	const finalContent = await enforceTrustedDeliveryAudienceAtEgress(
		runtime,
		message,
		responseContent ?? {},
	);
	if (
		!isRecord(finalContent.data) ||
		finalContent.data.privacyDenied !== true
	) {
		return { responseContent, responseMessages };
	}
	return {
		responseContent: finalContent,
		responseMessages: responseMessages.map((responseMemory) => ({
			...responseMemory,
			content: { ...finalContent },
		})),
	};
}
