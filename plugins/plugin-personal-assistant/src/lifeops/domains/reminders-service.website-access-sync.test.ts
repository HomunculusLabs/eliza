/**
 * `syncWebsiteAccessState` foreign-block conflict reporting (#29888).
 *
 * Real `RemindersDomain.syncWebsiteAccessState` against a stubbed LifeOps
 * context; the plugin-blocker engine module is `vi.mock`ed (mocks created via
 * `vi.hoisted` so the factory survives Vitest's mock hoisting) so no OS
 * hosts-file path is touched. Covers the conflict window the issue describes:
 * a manual block (managedBy: null) created during an earned unlock silently
 * suspends demanded coverage once the grant expires — the fix surfaces an
 * owner-visible typed notice once per conflict episode instead of only a
 * server-side warn.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type listCallerDefinitions,
  listCallerDefinitions as listCallerDefinitionsFn,
} from "./definition-authorization.js";
import { type RemindersDeps, RemindersDomain } from "./reminders-service.js";

const { getSelfControlStatus, startSelfControlBlock, stopSelfControlBlock } =
  vi.hoisted(() => ({
    getSelfControlStatus: vi.fn(),
    startSelfControlBlock: vi.fn(),
    stopSelfControlBlock: vi.fn(),
  }));

vi.mock("@elizaos/plugin-blocker/services/website-blocker/engine", () => ({
  getSelfControlStatus: (...args: unknown[]) => getSelfControlStatus(...args),
  startSelfControlBlock: (...args: unknown[]) => startSelfControlBlock(...args),
  stopSelfControlBlock: (...args: unknown[]) => stopSelfControlBlock(...args),
}));

vi.mock("./definition-authorization.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./definition-authorization.js")>();
  return {
    ...actual,
    listCallerDefinitions: vi.fn(actual.listCallerDefinitions),
  };
});

const NOW = new Date("2026-08-29T12:00:00.000Z");

type CallerDefinition = Awaited<
  ReturnType<typeof listCallerDefinitions>
>[number];

const WEBSITE_ACCESS_DEFINITION = {
  id: "definition-1",
  status: "active",
  websiteAccess: {
    groupKey: "focus",
    websites: ["x.com", "instagram.com"],
    unlockMode: "fixed_duration",
    unlockDurationMinutes: 60,
  },
} as unknown as CallerDefinition;

const FOREIGN_BLOCK_STATUS = {
  active: true,
  managedBy: null,
  websites: ["news.ycombinator.com"],
};

function makeCtx(overrides: Partial<LifeOpsContext> = {}) {
  const emitAssistantEvent = vi.fn(() => true);
  const logLifeOpsWarn = vi.fn();
  const ctx = {
    runtime: { reportError: vi.fn() },
    repository: {
      listWebsiteAccessGrants: vi.fn(async () => []),
    },
    agentId: () => "00000000-0000-0000-0000-0000000000ee",
    ownerEntityId: () => "00000000-0000-0000-0000-0000000000ef",
    logLifeOpsWarn,
    logLifeOpsError: vi.fn(),
    emitAssistantEvent,
    ...overrides,
  };
  return {
    ctx: ctx as unknown as LifeOpsContext,
    emitAssistantEvent,
    logLifeOpsWarn,
  };
}

function makeDomain(ctx: LifeOpsContext) {
  const deps: RemindersDeps = {
    runDueWorkflows: vi.fn(async () => []),
    runDueEventWorkflows: vi.fn(async () => []),
    snoozeOccurrence: vi.fn(),
    checkinSource: {},
  };
  return new RemindersDomain(ctx, deps as unknown as RemindersDeps);
}

function demandCoverage() {
  vi.mocked(listCallerDefinitionsFn).mockResolvedValue([
    WEBSITE_ACCESS_DEFINITION,
  ]);
}

describe("RemindersDomain.syncWebsiteAccessState foreign-block conflict reporting (#29888)", () => {
  beforeEach(() => {
    getSelfControlStatus.mockReset();
    startSelfControlBlock.mockReset();
    stopSelfControlBlock.mockReset();
    startSelfControlBlock.mockResolvedValue({ success: true });
    stopSelfControlBlock.mockResolvedValue({ success: true });
    vi.mocked(listCallerDefinitionsFn).mockReset();
    demandCoverage();
  });

  it("emits one owner-visible typed notice when a foreign block holds the slot while coverage is demanded", async () => {
    const { ctx, emitAssistantEvent } = makeCtx();
    const domain = makeDomain(ctx);
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);

    await domain.syncWebsiteAccessState(NOW);

    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    const [text, source, data] = emitAssistantEvent.mock
      .calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(source).toBe("lifeops-website-access-conflict");
    expect(text).toContain("LifeOps enforcement is paused");
    expect(data).toMatchObject({
      managedBy: null,
      blockedWebsites: ["instagram.com", "x.com"],
      blockedGroups: ["focus"],
    });
    // Enforcement semantics unchanged: the sweep must NOT touch the foreign block.
    expect(startSelfControlBlock).not.toHaveBeenCalled();
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
  });

  it("deduplicates the notice per conflict episode across sweep ticks", async () => {
    const { ctx, emitAssistantEvent } = makeCtx();
    const domain = makeDomain(ctx);
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);

    await domain.syncWebsiteAccessState(NOW);
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 60_000));
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 120_000));

    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
  });

  it("re-notifies the same episode shape after the conflict ends and the memo resets", async () => {
    const { ctx, emitAssistantEvent } = makeCtx();
    const domain = makeDomain(ctx);

    // Episode 1: foreign manual block, coverage demanded.
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);
    await domain.syncWebsiteAccessState(NOW);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // Foreign block ends: sweep recovers by re-blocking with lifeops metadata.
    // The recovery pass itself takes the slot-free path, which resets the memo.
    getSelfControlStatus.mockResolvedValue({
      active: false,
      managedBy: null,
      websites: [],
    });
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 60_000));
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ managedBy: "lifeops" }),
      }),
    );
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // Episode 2: the SAME episode shape (managedBy: null, same demanded set).
    // If the memo were never cleared, this would be wrongly suppressed.
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 120_000));
    expect(emitAssistantEvent).toHaveBeenCalledTimes(2);
    const secondData = emitAssistantEvent.mock.calls[1]?.[2] as Record<
      string,
      unknown
    >;
    expect(secondData).toMatchObject({ managedBy: null });
  });

  it("clears the memo when an unlock window leaves a foreign block un-demanding, so a later conflict re-notifies", async () => {
    const activeGrant = {
      groupKey: "focus",
      unlockedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
      revokedAt: null,
    };
    const listWebsiteAccessGrants = vi.fn<() => Promise<unknown[]>>(
      async () => [],
    );
    const { ctx, emitAssistantEvent } = makeCtx({
      repository: {
        listWebsiteAccessGrants,
      } as unknown as LifeOpsContext["repository"],
    });
    const domain = makeDomain(ctx);

    // Episode 1 before the unlock: foreign manual block + demand -> notice.
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);
    await domain.syncWebsiteAccessState(NOW);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // Valid unlock window (active grant -> empty demand): the foreign block is
    // the owner exercising their unlock — silent, and the memo resets.
    listWebsiteAccessGrants.mockResolvedValue([activeGrant]);
    getSelfControlStatus.mockResolvedValue({
      active: true,
      managedBy: null,
      websites: ["x.com"],
    });
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 60_000));
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).not.toHaveBeenCalled();
    expect(stopSelfControlBlock).not.toHaveBeenCalled();

    // Grant expires -> demand returns while the same foreign block persists:
    // the conflict must notify again (empty-demand pass cleared the memo).
    listWebsiteAccessGrants.mockResolvedValue([]);
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 120_000));
    expect(emitAssistantEvent).toHaveBeenCalledTimes(2);
  });

  it("logs an explicit degradation when the assistant stream is unavailable", async () => {
    const { ctx, logLifeOpsWarn } = makeCtx({
      emitAssistantEvent: vi.fn(() => false),
    } as unknown as Partial<LifeOpsContext>);
    const domain = makeDomain(ctx);
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);

    await domain.syncWebsiteAccessState(NOW);

    // Conflict warn + degradation warn both present; no throw.
    expect(logLifeOpsWarn).toHaveBeenCalledWith(
      "website_access_sync",
      expect.stringContaining("could not reach the owner"),
      expect.objectContaining({ managedBy: null }),
    );
  });

  it("leaves the LifeOps-managed block lifecycle untouched", async () => {
    const { ctx, emitAssistantEvent } = makeCtx();
    const domain = makeDomain(ctx);

    // Episode 0: a foreign conflict first, so the memo is populated and the
    // final repeat below genuinely proves the lifeops-managed pass resets it.
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);
    await domain.syncWebsiteAccessState(NOW);
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // Same demanded set already enforced by the LifeOps block: no-op, and the
    // memo resets on this path too.
    getSelfControlStatus.mockResolvedValue({
      active: true,
      managedBy: "lifeops",
      websites: ["instagram.com", "x.com"],
    });
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 60_000));
    expect(startSelfControlBlock).not.toHaveBeenCalled();
    expect(stopSelfControlBlock).not.toHaveBeenCalled();
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // Demanded set drifts: stop + restart with lifeops metadata, no notice.
    getSelfControlStatus.mockResolvedValue({
      active: true,
      managedBy: "lifeops",
      websites: ["instagram.com"],
    });
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 120_000));
    expect(stopSelfControlBlock).toHaveBeenCalledTimes(1);
    expect(startSelfControlBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ managedBy: "lifeops" }),
      }),
    );
    expect(emitAssistantEvent).toHaveBeenCalledTimes(1);

    // The lifeops-managed passes reset the memo: repeating episode 0's exact
    // key notifies again instead of being suppressed.
    getSelfControlStatus.mockResolvedValue(FOREIGN_BLOCK_STATUS);
    await domain.syncWebsiteAccessState(new Date(NOW.getTime() + 180_000));
    expect(emitAssistantEvent).toHaveBeenCalledTimes(2);
  });
});
