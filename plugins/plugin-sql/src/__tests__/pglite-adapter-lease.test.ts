/**
 * Exercises real overlapping PGlite adapters to prove outgoing-runtime
 * teardown releases one lease without invalidating the replacement adapter.
 */
import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createDatabaseAdapter } from "../index.node";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";

describe("PGlite adapter leases", () => {
  it("keeps the replacement ready after the outgoing adapter closes", async () => {
    const agentId = "10000000-0000-4000-8000-000000000001" as UUID;
    const outgoing = createDatabaseAdapter(
      { dataDir: ":memory:" },
      agentId
    ) as PgliteDatabaseAdapter;
    const replacement = createDatabaseAdapter(
      { dataDir: ":memory:" },
      agentId
    ) as PgliteDatabaseAdapter;

    try {
      await outgoing.init();
      await replacement.init();
      expect(replacement.getRawConnection()).toBe(outgoing.getRawConnection());
      expect(await replacement.isReady()).toBe(true);

      await outgoing.close();

      expect(await replacement.isReady()).toBe(true);
    } finally {
      await outgoing.close();
      await replacement.close();
    }
  });
});
