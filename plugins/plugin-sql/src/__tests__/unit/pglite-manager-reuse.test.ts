/**
 * Unit tests for `getOrCreatePgliteManagerForAgent` / `getActivePgliteManager`
 * against an in-memory `PgliteManagerCache`, using a `FakeManager` stub (no
 * real PGlite instance): confirms managers are reused per (dataDir, agentId)
 * pair, are distinct across agent ids, and a manager reporting
 * `isShuttingDown()` is replaced rather than reused.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  acquirePgliteManagerForAgent,
  dropActivePgliteManager,
  getActivePgliteManager,
  getOrCreatePgliteManagerForAgent,
  type PgliteManagerCache,
} from "../../pglite/manager-cache";

class FakeManager {
  constructor(readonly label: string) {}

  shuttingDown = false;
  closeCalls = 0;

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.shuttingDown = true;
  }
}

describe("PGlite manager reuse", () => {
  let cache: PgliteManagerCache<FakeManager> = {};
  const created: FakeManager[] = [];

  beforeEach(() => {
    cache = {};
    created.length = 0;
  });

  function getManager(dataDir: string | undefined, agentId: string): FakeManager {
    return getOrCreatePgliteManagerForAgent(cache, dataDir, agentId, () => {
      const manager = new FakeManager(`${dataDir ?? "memory"}:${agentId}`);
      created.push(manager);
      return manager;
    });
  }

  it("reuses the manager for the same PGlite data dir and agent id", () => {
    const agentId = "00000000-0000-4000-8000-000000000001";

    const first = getManager(":memory:", agentId);
    const second = getManager(":memory:", agentId);

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
  });

  it("does not reuse a manager across agent ids", () => {
    const first = getManager(":memory:", "00000000-0000-4000-8000-000000000001");
    const second = getManager(":memory:", "00000000-0000-4000-8000-000000000002");

    expect(second).not.toBe(first);
    expect(second.label).toBe(":memory::00000000-0000-4000-8000-000000000002");
    expect(getActivePgliteManager(cache)).toBe(second);
    expect(created).toHaveLength(2);
  });

  it("replaces a closed manager for the same data dir and agent id", () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const first = getManager("/tmp/eliza-agent", agentId);
    first.shuttingDown = true;

    const second = getManager("/tmp/eliza-agent", agentId);

    expect(second).not.toBe(first);
    expect(getActivePgliteManager(cache)).toBe(second);
    expect(created).toHaveLength(2);
  });

  it("keeps a shared manager alive until the final adapter lease releases", async () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const createManager = () => {
      const manager = new FakeManager(`:memory::${agentId}`);
      created.push(manager);
      return manager;
    };
    const first = acquirePgliteManagerForAgent(cache, ":memory:", agentId, createManager);
    const second = acquirePgliteManagerForAgent(cache, ":memory:", agentId, createManager);

    expect(second.manager).toBe(first.manager);
    await expect(first.release()).resolves.toBe(false);
    expect(first.manager.closeCalls).toBe(0);
    expect(getActivePgliteManager(cache)).toBe(first.manager);

    await expect(second.release()).resolves.toBe(true);
    expect(first.manager.closeCalls).toBe(1);
    expect(getActivePgliteManager(cache)).toBeUndefined();
    await expect(second.release()).resolves.toBe(false);
    expect(first.manager.closeCalls).toBe(1);
  });

  it("does not close a force-dropped manager again when leases release", async () => {
    const agentId = "00000000-0000-4000-8000-000000000001";
    const createManager = () => new FakeManager(`:memory::${agentId}`);
    const first = acquirePgliteManagerForAgent(cache, ":memory:", agentId, createManager);
    const second = acquirePgliteManagerForAgent(cache, ":memory:", agentId, createManager);

    await first.manager.close();
    dropActivePgliteManager(cache, first.manager);

    await expect(first.release()).resolves.toBe(false);
    await expect(second.release()).resolves.toBe(false);
    expect(first.manager.closeCalls).toBe(1);
  });
});
