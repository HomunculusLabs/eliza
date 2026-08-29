/**
 * Regression tests for edit-path validation (#29956): `apply(id, "edit", …)`
 * must run the same structural validation and A11 channel-key registration
 * check that `schedule()` enforces, so an edit can never persist a task
 * `schedule()` would have rejected. Real-runner harness (in-memory store,
 * built-in registries) mirroring runner.test.ts; deterministic (injected now).
 */
import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createAnchorRegistry,
  createConsolidationRegistry,
} from "./consolidation-policy.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import {
  ChannelKeyError,
  createInMemoryScheduledTaskStore,
  createScheduledTaskRunner,
  type ScheduledTaskRunnerHandle,
  TestNoopScheduledTaskDispatcher,
} from "./runner.js";
import type { ScheduledTaskLogStore } from "./state-log.js";
import { createInMemoryScheduledTaskLogStore } from "./state-log.js";
import type { GlobalPauseView, ScheduledTask } from "./types.js";
import { ScheduledTaskValidationError } from "./validation.js";

interface EditValidationHarness {
  runner: ScheduledTaskRunnerHandle;
  logStore: ScheduledTaskLogStore;
}

function makeHarness(
  channelKeys: () => ReadonlySet<string>,
): EditValidationHarness {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  const store = createInMemoryScheduledTaskStore();
  const logStore = createInMemoryScheduledTaskLogStore();
  let counter = 0;
  const runner = createScheduledTaskRunner({
    agentId: "test-agent",
    store,
    logStore,
    gates,
    completionChecks,
    ladders,
    anchors: createAnchorRegistry(),
    consolidation: createConsolidationRegistry(),
    channelKeys,
    ownerFacts: () => ({
      timezone: "UTC",
      morningWindow: { start: "07:00", end: "10:00" },
    }),
    globalPause: {
      current: async () => ({ active: false }),
    } as GlobalPauseView,
    activity: { hasSignalSince: () => false },
    subjectStore: { wasUpdatedSince: () => false },
    dispatcher: TestNoopScheduledTaskDispatcher,
    newTaskId: () => {
      counter += 1;
      return `task_${counter}`;
    },
    now: () => new Date("2026-05-09T12:00:00.000Z"),
  });
  return { runner, logStore };
}

const baseInput = (
  overrides: Partial<Omit<ScheduledTask, "taskId" | "state">> = {},
): Omit<ScheduledTask, "taskId" | "state"> => ({
  kind: "reminder",
  promptInstructions: "do the thing",
  trigger: { kind: "manual" },
  priority: "medium",
  respectsGlobalPause: true,
  source: "user_chat",
  createdBy: "tester",
  ownerVisible: true,
  ...overrides,
});

const findStored = async (
  runner: ScheduledTaskRunnerHandle,
  taskId: string,
): Promise<ScheduledTask> => {
  const stored = (await runner.list()).find((t) => t.taskId === taskId);
  expect(stored).toBeDefined();
  return stored as ScheduledTask;
};

describe("ScheduledTaskRunner — edit-path validation (#29956)", () => {
  it("rejects an edit whose trigger is structurally invalid and leaves the stored task unchanged", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(
      baseInput({ trigger: { kind: "interval", everyMinutes: 60 } }),
    );
    await expect(
      runner.apply(task.taskId, "edit", {
        trigger: { kind: "interval", everyMinutes: -5 },
      }),
    ).rejects.toThrow(ScheduledTaskValidationError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.trigger).toEqual({ kind: "interval", everyMinutes: 60 });
  });

  it("rejects an unregistered escalation channelKey edit and leaves the stored task unchanged", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(baseInput());
    await expect(
      runner.apply(task.taskId, "edit", {
        escalation: {
          steps: [{ channelKey: "unregistered", delayMinutes: 5 }],
        },
      }),
    ).rejects.toThrow(ChannelKeyError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.escalation).toBeUndefined();
  });

  it("rejects an invalid enum edit (priority) and leaves the stored task unchanged", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(baseInput());
    await expect(
      runner.apply(task.taskId, "edit", { priority: "bogus" as never }),
    ).rejects.toThrow(ScheduledTaskValidationError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.priority).toBe("medium");
  });

  it("still accepts a fully valid edit (regression: valid edits must keep persisting)", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(
      baseInput({ trigger: { kind: "interval", everyMinutes: 60 } }),
    );
    const edited = await runner.apply(task.taskId, "edit", {
      promptInstructions: "updated text",
      trigger: { kind: "interval", everyMinutes: 30 },
      escalation: { steps: [{ channelKey: "in_app", delayMinutes: 10 }] },
    });
    expect(edited.promptInstructions).toBe("updated text");
    expect(edited.trigger).toEqual({ kind: "interval", everyMinutes: 30 });
    expect(edited.escalation?.steps?.[0]?.channelKey).toBe("in_app");
    const stored = await findStored(runner, task.taskId);
    expect(stored.trigger).toEqual({ kind: "interval", everyMinutes: 30 });
  });

  it("validates the post-edit shape, not just the patch: removing required fields via merge is caught", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(baseInput());
    // promptInstructions cannot literally be deleted via Object.assign, but a
    // non-string value proves the candidate (task+patch) is what gets checked.
    await expect(
      runner.apply(task.taskId, "edit", { promptInstructions: 123 as never }),
    ).rejects.toThrow(ScheduledTaskValidationError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.promptInstructions).toBe("do the thing");
  });

  it("edit rejection is atomic: nothing persists and no edited log row is written", async () => {
    const { runner, logStore } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(baseInput());
    await expect(
      runner.apply(task.taskId, "edit", { priority: "nope" as never }),
    ).rejects.toThrow(ScheduledTaskValidationError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.promptInstructions).toBe("do the thing");
    expect(stored.priority).toBe("medium");
    // The failure must surface before the edit is journaled: the task's log
    // contains only its creation row, no "edited" transition.
    const rows = await logStore.list({
      agentId: "test-agent",
      taskId: task.taskId,
    });
    expect(rows.map((row) => row.transition)).not.toContain("edited");
  });

  it("rejects an unregistered channelKey on an escalation that was previously valid", async () => {
    const { runner } = makeHarness(() => new Set(["in_app"]));
    const task = await runner.schedule(
      baseInput({
        escalation: { steps: [{ channelKey: "in_app", delayMinutes: 10 }] },
      }),
    );
    // Replacing a valid ladder with an unregistered channel is caught even
    // though the patch itself replaces escalation wholesale.
    await expect(
      runner.apply(task.taskId, "edit", {
        escalation: { steps: [{ channelKey: "telegram", delayMinutes: 10 }] },
      }),
    ).rejects.toThrow(ChannelKeyError);
    const stored = await findStored(runner, task.taskId);
    expect(stored.escalation?.steps?.[0]?.channelKey).toBe("in_app");
  });
});
