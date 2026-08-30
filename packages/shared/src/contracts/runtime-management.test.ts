/**
 * Contract tests for the Devices & Runtimes management operation allowlist:
 * `isRuntimeManagementOperation` is the first validation gate on the
 * owner-approved cross-process RuntimeManagementRequest contract — it runs on
 * `POST /api/runtime/manage` (packages/agent parseRequest), on the app-control
 * runtime-management action's parsed options, and on UI startup-phase WebSocket
 * request validation. Exercises the real membership guard from
 * runtime-management.js — type discrimination, membership, and rejection of
 * near-miss inputs; no server or transport is involved. At the HTTP boundary
 * the guard's false return makes parseRequest yield null and the route answer
 * HTTP 400 "Invalid runtime operation or secret-bearing field." — no owner
 * proposal is minted for an unrecognized op.
 */
import { describe, expect, it } from "vitest";
import {
  isRuntimeManagementOperation,
  RUNTIME_MANAGEMENT_OPERATIONS,
  RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS,
} from "./runtime-management.js";

describe("isRuntimeManagementOperation", () => {
  // The documented allowlist, pinned independently of the exported constant so
  // a silent addition (an unauthorized op) or removal (a dropped op) fails here
  // even though the guard iterates its own source of truth.
  const DOCUMENTED_OPERATIONS: readonly string[] = [
    "list",
    "pair",
    "create_pairing",
    "claim_pairing",
    "confirm_pairing",
    "deny_pairing",
    "revoke",
    "remove",
    "retry",
    "inspect_ssh",
    "connect_ssh",
    "add_direct",
    "enroll_host",
    "approve_pairing",
    "start_host",
    "stop_host",
    "revoke_host",
  ];

  it("pins the exact documented operation set of the contract", () => {
    // Exact-set equality: no missing member, no unauthorized addition.
    expect([...RUNTIME_MANAGEMENT_OPERATIONS].sort()).toEqual(
      [...DOCUMENTED_OPERATIONS].sort(),
    );
  });

  it("accepts every documented operation of the cross-process contract", () => {
    for (const op of DOCUMENTED_OPERATIONS) {
      expect(isRuntimeManagementOperation(op)).toBe(true);
    }
  });

  it("pins the destructive operations as contract members", () => {
    // Removing a runtime or revoking a pairing/host are the owner-approved
    // destructive surface of the contract: a missing member would make those
    // requests fall through to rejection at every consumer boundary.
    for (const destructive of [
      "remove",
      "revoke",
      "deny_pairing",
      "revoke_host",
    ]) {
      expect(RUNTIME_MANAGEMENT_OPERATIONS).toContain(destructive);
      expect(isRuntimeManagementOperation(destructive)).toBe(true);
    }
  });

  it("rejects non-string values", () => {
    // Membership must not coerce: an array or object body must never
    // stringify into a member, so untrusted JSON values cannot reach
    // the dispatch.
    expect(isRuntimeManagementOperation(undefined)).toBe(false);
    expect(isRuntimeManagementOperation(null)).toBe(false);
    expect(isRuntimeManagementOperation(0)).toBe(false);
    expect(isRuntimeManagementOperation(["remove"])).toBe(false);
    expect(isRuntimeManagementOperation({ op: "remove" })).toBe(false);
  });

  it("rejects unknown operation names instead of falling through", () => {
    // An unknown op must reject at parse time: parseRequest yields null, the
    // route answers HTTP 400, and no owner-approval proposal is minted for an
    // unrecognized action.
    expect(isRuntimeManagementOperation("format_disk")).toBe(false);
    expect(isRuntimeManagementOperation("")).toBe(false);
    expect(isRuntimeManagementOperation("runtime-removal")).toBe(false);
  });

  it("is case-sensitive and does not trim whitespace", () => {
    // HTTP bodies and LLM-emitted action options arrive with casing/whitespace
    // drift; the contract deliberately matches exact snake_case members only,
    // so "REMOVE" and " remove " must reject rather than dispatch.
    expect(isRuntimeManagementOperation("REMOVE")).toBe(false);
    expect(isRuntimeManagementOperation("Remove")).toBe(false);
    expect(isRuntimeManagementOperation(" remove ")).toBe(false);
    expect(isRuntimeManagementOperation("approve-pairing")).toBe(false);
  });

  it("rejects near-miss names that share a prefix with a member", () => {
    // Prefix collisions (pair vs pairing family, host vs direct) are where a
    // membership regression would silently widen the approved surface.
    expect(isRuntimeManagementOperation("pair")).toBe(true);
    expect(isRuntimeManagementOperation("paired")).toBe(false);
    expect(isRuntimeManagementOperation("create")).toBe(false);
    expect(isRuntimeManagementOperation("connect")).toBe(false);
    expect(isRuntimeManagementOperation("inspect")).toBe(false);
    expect(isRuntimeManagementOperation("approve")).toBe(false);
  });

  it("does not treat array prototype methods as operations", () => {
    // Guards implemented with a sloppy `value in list` or prototype chain
    // lookup would accept "length" or "constructor"; this pins includes()
    // semantics against that class of regression.
    expect(isRuntimeManagementOperation("length")).toBe(false);
    expect(isRuntimeManagementOperation("constructor")).toBe(false);
    expect(isRuntimeManagementOperation("toString")).toBe(false);
    expect(isRuntimeManagementOperation("includes")).toBe(false);
  });
});

describe("owner-approval-exempt partition", () => {
  // The documented exempt set, pinned independently of the exported constant:
  // these are the operations that cannot mutate host state, so both the agent
  // route (proposal flow skipped) and the app-control action (no explicit user
  // confirmation demanded) must agree on exactly this membership. A dropped
  // member would demand owner approval for a read; an added member would
  // silently weaken the confirmation gate — each is a security regression.
  const DOCUMENTED_EXEMPT_OPERATIONS: readonly string[] = [
    "list",
    "inspect_ssh",
  ];
  // Independently documented confirmation-required surface: every remaining
  // contract member must demand explicit user confirmation.
  const DOCUMENTED_CONFIRMATION_OPERATIONS: readonly string[] = [
    "pair",
    "create_pairing",
    "claim_pairing",
    "confirm_pairing",
    "deny_pairing",
    "revoke",
    "remove",
    "retry",
    "connect_ssh",
    "add_direct",
    "enroll_host",
    "approve_pairing",
    "start_host",
    "stop_host",
    "revoke_host",
  ];

  it("pins the exempt set as exactly {list, inspect_ssh}", () => {
    // Exact-set equality: no missing exempt member, no unauthorized exemption.
    expect([...RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS].sort()).toEqual(
      [...DOCUMENTED_EXEMPT_OPERATIONS].sort(),
    );
  });

  it("keeps the exempt set a subset of the operation contract", () => {
    // An exempt member that is not a contract member would be dead weight at
    // best and a type lie at worst; the satisfies clause enforces this at
    // compile time, this pins it at runtime.
    for (const op of RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS) {
      expect(RUNTIME_MANAGEMENT_OPERATIONS).toContain(op);
      expect(isRuntimeManagementOperation(op)).toBe(true);
    }
  });

  it("pins the confirmation-required set as the exact complement", () => {
    // Both consumers derive their view from the shared constants (the route
    // READ_ONLY_OPERATIONS set and the plugin CONFIRMATION_REQUIRED filter).
    // This pins the partition itself: complement = operations minus exempt,
    // exactly the derived plugin view, matching the documented surface.
    const complement = RUNTIME_MANAGEMENT_OPERATIONS.filter(
      (op) =>
        !(
          RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS as readonly string[]
        ).includes(op),
    );
    expect([...complement].sort()).toEqual(
      [...DOCUMENTED_CONFIRMATION_OPERATIONS].sort(),
    );
  });

  it("does not exempt any destructive operation", () => {
    // The security-critical direction: a destructive op appearing in the
    // exempt set would skip owner approval AND user confirmation at once.
    for (const destructive of [
      "remove",
      "revoke",
      "deny_pairing",
      "revoke_host",
      "connect_ssh",
      "start_host",
      "stop_host",
    ]) {
      expect(
        (
          RUNTIME_MANAGEMENT_OWNER_EXEMPT_OPERATIONS as readonly string[]
        ).includes(destructive),
      ).toBe(false);
    }
  });

  it("every non-exempt member is dispatchable by the membership guard", () => {
    // The complement must stay live at the consumer boundaries: a member the
    // membership guard rejects could never reach either partition branch.
    for (const op of DOCUMENTED_CONFIRMATION_OPERATIONS) {
      expect(isRuntimeManagementOperation(op)).toBe(true);
    }
  });
});
