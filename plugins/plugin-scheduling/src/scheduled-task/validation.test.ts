/**
 * Path-scoped pipeline cycle detection in `validateScheduledTaskInput`.
 *
 * The `seen` WeakSet must track only the CURRENT recursion path: objects are
 * forgotten when their branch completes, so sibling branches may legitimately
 * share (fan-in) the same child task object — a DAG — while a ref that rejoins
 * the live path is still a cycle. This suite pins that boundary at the
 * validation seam (the same function the runner calls at `schedule()` and
 * `importTask()` before any persistence). Deterministic, no live model.
 */

import { describe, expect, it } from "vitest";

import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import {
  createEscalationLadderRegistry,
  registerDefaultEscalationLadders,
} from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type {
  ScheduledTaskInput,
  ScheduledTaskPipeline,
  ScheduledTaskRef,
} from "./types.js";
import { validateScheduledTaskInput } from "./validation.js";

function makeDeps() {
  const gates = createTaskGateRegistry();
  registerBuiltInGates(gates);
  const completionChecks = createCompletionCheckRegistry();
  registerBuiltInCompletionChecks(completionChecks);
  const ladders = createEscalationLadderRegistry();
  registerDefaultEscalationLadders(ladders);
  return { gates, completionChecks, ladders };
}

function baseInput(
  overrides: Partial<ScheduledTaskInput> = {},
): ScheduledTaskInput {
  return {
    kind: "reminder",
    promptInstructions: "Send the weekly recap",
    priority: "medium",
    source: "user_chat",
    createdBy: "test-user",
    ownerVisible: true,
    respectsGlobalPause: true,
    trigger: { kind: "once", atIso: "2026-05-09T12:00:00.000Z" },
    ...overrides,
  };
}

/**
 * `validateTaskRef` accepts bare input-shaped task objects at runtime (the
 * `(ref as ScheduledTaskInput)` branch in validation.ts) — the shape produced
 * by in-process pipeline builders and by the validator's own recursion. The
 * declared `ScheduledTaskRef` type names only the persisted/wire shape, so
 * tests reach the runtime contract through this narrow cast.
 */
function inputRef(input: ScheduledTaskInput): ScheduledTaskRef {
  return input as unknown as ScheduledTaskRef;
}

function pipeline(refs: {
  onComplete?: ScheduledTaskInput[];
  onSkip?: ScheduledTaskInput[];
  onFail?: ScheduledTaskInput[];
}): ScheduledTaskPipeline {
  return {
    onComplete: refs.onComplete?.map(inputRef),
    onSkip: refs.onSkip?.map(inputRef),
    onFail: refs.onFail?.map(inputRef),
  } as ScheduledTaskPipeline;
}

describe("pipeline cycle detection is path-scoped (#29938)", () => {
  it("accepts the same child task object referenced by sibling branches (DAG fan-in)", () => {
    const deps = makeDeps();
    const sharedChild = baseInput();
    const issues = validateScheduledTaskInput(
      baseInput({
        pipeline: pipeline({
          onComplete: [sharedChild],
          onSkip: [sharedChild],
        }),
      }),
      deps,
    );
    expect(issues).toEqual([]);
  });

  it("accepts fan-in across sibling subtrees (two children sharing one grandchild)", () => {
    const deps = makeDeps();
    const grandchild = baseInput();
    const childA = baseInput({
      pipeline: pipeline({ onComplete: [grandchild] }),
    });
    const childB = baseInput({ pipeline: pipeline({ onSkip: [grandchild] }) });
    const issues = validateScheduledTaskInput(
      baseInput({ pipeline: pipeline({ onComplete: [childA, childB] }) }),
      deps,
    );
    expect(issues).toEqual([]);
  });

  it("still rejects a task whose pipeline references itself", () => {
    const deps = makeDeps();
    const parent = baseInput();
    (parent as { pipeline?: ScheduledTaskPipeline }).pipeline = pipeline({
      onComplete: [parent],
    });
    const issues = validateScheduledTaskInput(parent, deps);
    expect(issues).toEqual([
      "task.pipeline.onComplete[0] must not contain a cyclic task ref",
    ]);
  });

  it("still rejects an indirect cycle (grandchild references the root task)", () => {
    const deps = makeDeps();
    const root = baseInput();
    const child = baseInput({ pipeline: pipeline({ onFail: [root] }) });
    (root as { pipeline?: ScheduledTaskPipeline }).pipeline = pipeline({
      onComplete: [child],
    });
    const issues = validateScheduledTaskInput(root, deps);
    expect(issues).toEqual([
      "task.pipeline.onComplete[0].pipeline.onFail[0] must not contain a cyclic task ref",
    ]);
  });

  it("enforces the 8-level nesting cap on acyclic linear chains", () => {
    const deps = makeDeps();
    // Build a 10-deep linear chain: outermost -> child1 -> ... -> child10.
    let node = baseInput();
    for (let i = 0; i < 10; i += 1) {
      node = baseInput({ pipeline: pipeline({ onComplete: [node] }) });
    }
    const issues = validateScheduledTaskInput(node, deps);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("pipeline nesting exceeds 8 levels");
  });

  it("reports the nesting-cap issue, not a cycle issue, for a deep shared ref", () => {
    const deps = makeDeps();
    // A chain deep enough to exceed the cap whose deepest node is also
    // referenced again: the depth violation must win over any cycle report
    // (precedence preserved from the original implementation).
    let node = baseInput();
    for (let i = 0; i < 10; i += 1) {
      node = baseInput({ pipeline: pipeline({ onComplete: [node] }) });
    }
    const sharedDeep = baseInput({
      pipeline: pipeline({ onComplete: [node], onSkip: [node] }),
    });
    const issues = validateScheduledTaskInput(sharedDeep, deps);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue).toContain("pipeline nesting exceeds 8 levels");
    }
  });

  it("rejects a persisted-shaped (taskId/state) self-referencing cycle", () => {
    const deps = makeDeps();
    // A full ScheduledTask whose pipeline points back at itself: the ref is
    // stripped to a fresh object for validation, so the ORIGINAL ref must be
    // tracked around the recursion or the cycle is only caught by the depth
    // cap with a misleading issue.
    const persisted = {
      ...baseInput(),
      taskId: "5f4dbb1c-3333-4333-8333-333333333333",
      state: "scheduled",
    };
    (persisted as { pipeline?: ScheduledTaskPipeline }).pipeline = pipeline({
      onComplete: [persisted],
    });
    const issues = validateScheduledTaskInput(persisted, deps);
    expect(issues).toContain(
      "task.pipeline.onComplete[0] must not contain a cyclic task ref",
    );
  });

  it("rejects a two-node cycle built entirely from persisted-shaped refs", () => {
    const deps = makeDeps();
    const taskA = {
      ...baseInput(),
      taskId: "5f4dbb1c-4444-4444-8444-444444444444",
      state: "scheduled",
    };
    const taskB = {
      ...baseInput(),
      taskId: "5f4dbb1c-5555-4555-8555-555555555555",
      state: "scheduled",
    };
    (taskA as { pipeline?: ScheduledTaskPipeline }).pipeline = pipeline({
      onComplete: [taskB],
    });
    (taskB as { pipeline?: ScheduledTaskPipeline }).pipeline = pipeline({
      onFail: [taskA],
    });
    const issues = validateScheduledTaskInput(taskA, deps);
    expect(issues).toContain(
      "task.pipeline.onComplete[0].pipeline.onFail[0] must not contain a cyclic task ref",
    );
  });

  it("accepts a shared ref under both onComplete and onSkip without leaking the depth cap", () => {
    const deps = makeDeps();
    // Same child twice at depth 1; pre-fix this tripped the cycle guard,
    // and a naive fix that shares depth state could trip the depth cap.
    const sharedChild = baseInput();
    const issues = validateScheduledTaskInput(
      baseInput({
        pipeline: pipeline({
          onComplete: [sharedChild],
          onSkip: [sharedChild, sharedChild],
        }),
      }),
      deps,
    );
    expect(issues).toEqual([]);
  });
});
