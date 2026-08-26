/**
 * Shared value rules for the atomic cache compare-and-set contract
 * (`IDatabaseAdapter.compareAndSetCache`): which JS values are representable
 * durable-cache payloads and how two parsed JSON values count as equal.
 *
 * Adapters on both sides of the contract (core in-memory, plugin-sql's SQL
 * statement, plugin-inmemorydb) funnel through these helpers so the observable
 * semantics cannot diverge: `expected === undefined` is the ONLY absent
 * sentinel, and equality mirrors Postgres jsonb (order-insensitive keys,
 * numeric equality by value) via a structural deep compare.
 */

import { ElizaError } from "../errors";
import { isPlainObject } from "../utils/type-guards";

/** Stable error code for a contract-misuse value passed to CAS. */
export const CACHE_CAS_INVALID_VALUE_CODE = "CACHE_CAS_INVALID_VALUE";

/** Stable error code for CAS backing-store failures. */
export const CACHE_CAS_FAILED_CODE = "CACHE_CAS_FAILED";

/**
 * Stable error code thrown by the `DatabaseAdapter.compareAndSetCache`
 * concrete default when an adapter does not implement the atomic
 * conditional-write capability (mirrors the fail-closed
 * `WORLD_METADATA_CAS_CAPABILITY_REQUIRED` precedent).
 */
export const CACHE_CAS_CAPABILITY_REQUIRED_CODE =
	"CACHE_CAS_CAPABILITY_REQUIRED";

/**
 * True when `value` can round-trip through the durable cache: JSON primitives,
 * plain objects, arrays, and `null` are representable; `undefined`, functions,
 * symbols, bigint, and non-finite numbers are not (they cannot survive a
 * `setCache` → `getCache` round-trip on ANY adapter, so accepting them here
 * would create a write that later compares unequal against itself).
 */
export function isRepresentableCacheValue(value: unknown): boolean {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every(isRepresentableCacheValue);
	}
	if (isPlainObject(value)) {
		return Object.values(value).every(isRepresentableCacheValue);
	}
	return false;
}

/**
 * Validate one side of a compare-and-set at the boundary. `expected` may
 * additionally be `undefined` (the absent sentinel); a literal `null` expected
 * is rejected as contract misuse — `undefined` is the only absent sentinel on
 * this contract (the runtime cache surface has no JSON-null-absent
 * distinction), and accepting `null` would give adapters two ways to say
 * "absent", inviting silent cross-adapter divergence. (JSON `null` remains a
 * valid `replacement`/stored value; only a null EXPECTATION is rejected.)
 */
export function assertCasValue(
	value: unknown,
	role: "expected" | "replacement",
): void {
	if (role === "expected" && value === undefined) return;
	if (role === "expected" && value === null) {
		// `undefined` is the only absent sentinel on this contract; a null
		// expectation is a caller bug, not a matchable value.
		throw new ElizaError(
			"[compareAndSetCache] null expected is a contract misuse",
			{
				code: CACHE_CAS_INVALID_VALUE_CODE,
				context: { role, reason: "null_expected" },
			},
		);
	}
	if (isRepresentableCacheValue(value)) return;
	throw new ElizaError(
		"[compareAndSetCache] value is not a representable cache payload",
		{
			code: CACHE_CAS_INVALID_VALUE_CODE,
			context: { role, reason: typeof value },
		},
	);
}

/**
 * Order-insensitive deep equality over parsed JSON values, deliberately
 * aligned with Postgres jsonb equality: object key order and numeric scale
 * (`1` vs `1.0`) do not distinguish values. Primitives compare with `===`
 * (so `-0 === 0`, matching jsonb). Non-JSON operands (functions, bigint)
 * compare by identity — callers should have rejected them already.
 *
 * This duplicates the rules of `worldMetadataValueEquals`
 * (world-metadata-cas.ts, landed on develop after this stack's base in
 * #28750) by necessity: that module is not present in this branch's tree.
 * Unifying the two into one shared JSON-equality primitive is the natural
 * follow-up once both stacks sit on develop together.
 */
export function jsonValueEquals(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left === "number" && typeof right === "number") {
		// NaN is not representable (rejected at the boundary); finite numbers
		// with equal value are equal regardless of scale representation.
		return Number.isFinite(left) && Number.isFinite(right)
			? left === right
			: false;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!jsonValueEquals(left[i], right[i])) return false;
		}
		return true;
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		for (const key of leftKeys) {
			if (!Object.hasOwn(right, key)) return false;
			if (!jsonValueEquals(left[key], right[key])) return false;
		}
		return true;
	}
	return false;
}
