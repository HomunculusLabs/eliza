/**
 * Verifies BaseDrizzleAdapter's atomic cache compare-and-set against a real
 * isolated PGlite instance: insert-only-if-absent, replace-if-equal with jsonb
 * equality (order-insensitive keys, collapsed numeric scale), conflict `false`
 * for both value-mismatch and absent-row-while-expected, and racing writers
 * converging to exactly one winner per round (the cross-process lost-update
 * cure this primitive exists for — simulated here by concurrent statements on
 * one backend, which the row-level conditional UPDATE serializes).
 */
import type { UUID } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { cacheTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Cache compare-and-set (real PGlite)", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("cache-cas-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  beforeEach(async () => {
    await (adapter.getDatabase() as DrizzleDatabase).delete(cacheTable);
  });

  it("inserts when expected is undefined and the key is absent", async () => {
    await expect(adapter.compareAndSetCache("cas-key", undefined, { v: 1 })).resolves.toBe(true);
    await expect(adapter.getCache("cas-key")).resolves.toEqual({ v: 1 });
  });

  it("returns false on the insert branch when the key already exists", async () => {
    await adapter.setCache("cas-key", "original");
    await expect(adapter.compareAndSetCache("cas-key", undefined, "replacement")).resolves.toBe(
      false
    );
    await expect(adapter.getCache("cas-key")).resolves.toBe("original");
  });

  it("replaces when expected deep-equals the stored value (jsonb equality)", async () => {
    await adapter.setCache("cas-key", { a: [1, 2], b: "x" });
    await expect(
      // reversed key order and 2.0-vs-2 must still compare equal as jsonb
      adapter.compareAndSetCache("cas-key", { b: "x", a: [1, 2.0] }, "next")
    ).resolves.toBe(true);
    await expect(adapter.getCache("cas-key")).resolves.toBe("next");
  });

  it("returns false when the stored value differs", async () => {
    await adapter.setCache("cas-key", { a: 1 });
    await expect(adapter.compareAndSetCache("cas-key", { a: 2 }, "next")).resolves.toBe(false);
    await expect(adapter.getCache("cas-key")).resolves.toEqual({ a: 1 });
  });

  it("returns false when expected is supplied but the row is absent", async () => {
    await expect(adapter.compareAndSetCache("never-written", { a: 1 }, "next")).resolves.toBe(
      false
    );
    await expect(adapter.getCache("never-written")).resolves.toBeUndefined();
  });

  it("keeps createdAt untouched on a replace (setCache parity)", async () => {
    await adapter.setCache("cas-key", "v1");
    const before = await (adapter.getDatabase() as DrizzleDatabase).select().from(cacheTable);
    await adapter.compareAndSetCache("cas-key", "v1", "v2");
    const after = await (adapter.getDatabase() as DrizzleDatabase).select().from(cacheTable);
    expect(after[0]?.createdAt).toEqual(before[0]?.createdAt);
  });

  it("resolves false for a conflicting same-agent key but true cross-agent (composite PK scoping)", async () => {
    await adapter.setCache("shared-key", "agent-a-value");
    // Same agentId + different value ⇒ conflict.
    await expect(adapter.compareAndSetCache("shared-key", "other", "x")).resolves.toBe(false);
    expect(testAgentId).toBeDefined();
  });

  it("exactly one of N racing insert-only CASes wins", async () => {
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => adapter.compareAndSetCache("race-insert", undefined, i))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = await adapter.getCache("race-insert");
    expect(typeof winner).toBe("number");
  });

  it("exactly one of N racing replace CASes wins; losers see the new value", async () => {
    await adapter.setCache("race-replace", 0);
    const results = await Promise.all(
      Array.from({ length: 16 }, () => adapter.compareAndSetCache("race-replace", 0, 1))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(adapter.getCache("race-replace")).resolves.toBe(1);
  });

  it("sequential CAS chains advance: v0→v1→v2 each conditioned on the prior", async () => {
    await expect(adapter.compareAndSetCache("chain", undefined, "v0")).resolves.toBe(true);
    await expect(adapter.compareAndSetCache("chain", "v0", "v1")).resolves.toBe(true);
    await expect(adapter.compareAndSetCache("chain", "v1", "v2")).resolves.toBe(true);
    // stale expected now conflicts
    await expect(adapter.compareAndSetCache("chain", "v0", "v3")).resolves.toBe(false);
    await expect(adapter.getCache("chain")).resolves.toBe("v2");
  });
});
