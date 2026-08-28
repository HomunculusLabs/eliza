/**
 * Regression tests for SpendingPolicy RollingSpendCap accounting of
 * approved drafts: approved drafts must count into the rolling window
 * exactly once, rejected drafts must never count, and the cap must reject
 * once cumulative approved spend in the window reaches maxAmount.
 * Uses the real class only (no mocked policy) per the issue's test plan.
 */
import { describe, expect, it, vi } from "vitest";
import { SpendingPolicy } from "./SpendingPolicy";

const CAP = {
  rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
  draftThreshold: 100,
};
// Higher threshold so amounts below it take the immediate-approval path,
// letting boundary/double-count tests assert "approved" outcomes.
const HIGH_THRESHOLD = {
  rollingCap: { maxAmount: 1000, windowMs: 86_400_000 },
  draftThreshold: 500,
};

/** Draft a payment and approve it, returning the check result. */
async function draftAndApprove(
  policy: SpendingPolicy,
  amount: number,
): Promise<string | undefined> {
  const result = await policy.check({ merchant: "m", amount });
  if (result.status === "draft" && result.draftId) {
    policy.approveDraft(result.draftId);
    return result.draftId;
  }
  return undefined;
}

describe("SpendingPolicy RollingSpendCap — approved drafts count", () => {
  it("records an approved draft so a subsequent over-cap payment is rejected", async () => {
    const policy = new SpendingPolicy(CAP);
    await draftAndApprove(policy, 900);
    // 900 approved; 200 more would exceed the 1000 cap
    const over = await policy.check({ merchant: "m", amount: 200 });
    expect(over.status).toBe("rejected");
    expect(over.reason).toContain("Rolling spend cap exceeded");
  });

  it("multi-draft accumulation crossing the cap rejects the next payment (issue repro)", async () => {
    const policy = new SpendingPolicy(CAP);
    let iterations = 0;
    let final: { status: string; reason?: string } | undefined;
    for (let i = 0; i < 50; i++) {
      iterations++;
      const result = await policy.check({ merchant: "m", amount: 100 });
      if (result.status === "draft" && result.draftId) {
        policy.approveDraft(result.draftId);
      } else {
        final = result;
        break;
      }
    }
    // Cap 1000: 10 x 100 approved, the 11th attempt trips the cap
    expect(iterations).toBe(11);
    expect(final?.status).toBe("rejected");
    expect(final?.reason).toContain("Rolling spend cap exceeded");
  });

  it("allows a payment up to the exact remaining headroom (boundary at exactly maxAmount)", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    await draftAndApprove(policy, 900);
    // 900 approved via draft + 100 immediate = exactly maxAmount: approved (strict > rejection)
    const exact = await policy.check({ merchant: "m", amount: 100 });
    expect(exact.status).toBe("approved");
    // Now at cap; even 1 more unit is over
    const one = await policy.check({ merchant: "m", amount: 1 });
    expect(one.status).toBe("rejected");
  });

  it("counts a below-threshold immediate approval as before", async () => {
    const policy = new SpendingPolicy(CAP);
    const small = await policy.check({ merchant: "m", amount: 50 });
    expect(small.status).toBe("approved");
    const next = await policy.check({ merchant: "m", amount: 960 });
    // 50 + 960 > 1000
    expect(next.status).toBe("rejected");
  });

  it("double-approval of the same draft records spend only once", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const id = await draftAndApprove(policy, 900);
    expect(id).toBeDefined();
    // Second approveDraft call on the same id is idempotently true and
    // must not double-count
    expect(policy.approveDraft(id as string)).toBe(true);
    const exact = await policy.check({ merchant: "m", amount: 100 });
    expect(exact.status).toBe("approved");
  });

  it("rejectDraft never records spend", async () => {
    const policy = new SpendingPolicy(CAP);
    const result = await policy.check({ merchant: "m", amount: 900 });
    expect(result.status).toBe("draft");
    policy.rejectDraft(result.draftId as string);
    const after = await policy.check({ merchant: "m", amount: 900 });
    // Nothing counted; another 900 still fits under the 1000 cap
    expect(after.status).not.toBe("rejected");
  });

  it("window expiry: approved-draft spend ages out of the cap after windowMs", async () => {
    const policy = new SpendingPolicy(CAP);
    await draftAndApprove(policy, 900);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 86_400_001);
    const after = await policy.check({ merchant: "m", amount: 900 });
    vi.useRealTimers();
    expect(after.status).not.toBe("rejected");
  });

  it("approving a draft when rollingCap is undefined is a no-op and does not throw", async () => {
    const policy = new SpendingPolicy({ draftThreshold: 100 });
    const result = await policy.check({ merchant: "m", amount: 900 });
    expect(result.status).toBe("draft");
    expect(() => policy.approveDraft(result.draftId as string)).not.toThrow();
    expect(policy.getPendingDrafts()).toHaveLength(0);
  });
});

describe("SpendingPolicy draft state machine — terminal states", () => {
  it("an unapproved draft counts no spend (approve-time, not check-time, accounting)", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 600 });
    expect(drafted.status).toBe("draft");
    // Never approved: nothing accrued (400 < threshold 500, so immediate path)
    const after = await policy.check({ merchant: "m", amount: 400 });
    expect(after.status).toBe("approved");
  });

  it("approve-after-reject is refused: the rejection stands and no spend records", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 600 });
    expect(policy.rejectDraft(drafted.draftId as string)).toBe(true);
    // A later approval cannot resurrect a rejected draft
    expect(policy.approveDraft(drafted.draftId as string)).toBe(false);
    const [entry] = policy.getAllDrafts();
    expect(entry.approved).toBe(false);
    expect(entry.rejected).toBe(true);
    // Nothing was recorded (400 < threshold 500, so immediate path)
    const after = await policy.check({ merchant: "m", amount: 400 });
    expect(after.status).toBe("approved");
  });

  it("reject-after-approve is refused: the approval and its recorded spend stand", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 600 });
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
    expect(policy.rejectDraft(drafted.draftId as string)).toBe(false);
    const [entry] = policy.getAllDrafts();
    expect(entry.approved).toBe(true);
    expect(entry.rejected).toBe(false);
    // The 600 spend stays recorded (500 + 600 > 1000)
    const after = await policy.check({ merchant: "m", amount: 500 });
    expect(after.status).toBe("rejected");
  });

  it("unknown draftId returns false from both methods (existing behavior)", () => {
    const policy = new SpendingPolicy(CAP);
    expect(policy.approveDraft("draft-nope")).toBe(false);
    expect(policy.rejectDraft("draft-nope")).toBe(false);
  });

  it("a single payment above maxAmount is rejected at check time before drafting (gate ordering)", async () => {
    const policy = new SpendingPolicy(CAP);
    const result = await policy.check({ merchant: "m", amount: 1001 });
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("Rolling spend cap exceeded");
    expect(result.draftId).toBeUndefined();
    expect(policy.getAllDrafts()).toHaveLength(0);
  });
});

describe("SpendingPolicy — accounting guard vs external mutation", () => {
  it("mutating a returned draft entry cannot forge approval or bypass recording", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 600 });
    const [external] = policy.getPendingDrafts();
    // Hostile caller flips the flag on the returned entry
    external.approved = true;
    // The real approval path still records exactly once (returns true)
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
    const [entry] = policy.getAllDrafts();
    expect(entry.approved).toBe(true);
    // 600 recorded: 500 more exceeds the 1000 cap
    const after = await policy.check({ merchant: "m", amount: 500 });
    expect(after.status).toBe("rejected");
  });

  it("flipping approved back to false on a returned copy cannot re-arm double counting", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const id = await draftAndApprove(policy, 600);
    const [external] = policy.getAllDrafts();
    external.approved = false;
    // Internal state is untouched: second approval is a no-op returning true
    expect(policy.approveDraft(id as string)).toBe(true);
    // Spend recorded once (600), not twice: 400 fits, 500 does not
    const fits = await policy.check({ merchant: "m", amount: 400 });
    expect(fits.status).toBe("approved");
    const over = await policy.check({ merchant: "m", amount: 200 });
    expect(over.status).toBe("rejected");
  });

  it("mutating the payment on a returned draft copy does not change what is recorded", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 600 });
    const [external] = policy.getPendingDrafts();
    external.payment.amount = 1; // hostile shrink of the recorded amount
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
    // The original 600 was recorded: 500 more exceeds the cap
    const after = await policy.check({ merchant: "m", amount: 500 });
    expect(after.status).toBe("rejected");
  });

  it("mutating the ORIGINAL payment object after drafting does not change what is recorded", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const intent = { merchant: "m", amount: 600 };
    const drafted = await policy.check(intent);
    expect(drafted.status).toBe("draft");
    // Caller shrinks the amount on the object they still hold a reference to
    intent.amount = 1;
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
    // The 600 at draft time was recorded: 500 more exceeds the cap
    const after = await policy.check({ merchant: "m", amount: 500 });
    expect(after.status).toBe("rejected");
  });
});

describe("SpendingPolicy — approval-time accounting semantics", () => {
  it("spend is recorded at approval time, not the client-supplied payment timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-28T00:00:00Z"));
    const policy = new SpendingPolicy(CAP);
    // Payment backdated 23h into a 24h window: a queuedAt-based record would
    // expire in 1h; an approval-time record survives the full window
    const drafted = await policy.check({
      merchant: "m",
      amount: 900,
      timestamp: new Date("2026-08-27T01:00:00Z").toISOString(),
    });
    expect(drafted.status).toBe("draft");
    expect(policy.approveDraft(drafted.draftId as string)).toBe(true);
    vi.setSystemTime(new Date("2026-08-28T12:00:00Z")); // 12h after approval
    const mid = await policy.check({ merchant: "m", amount: 200 });
    expect(mid.status).toBe("rejected");
    // 25h after approval the entry ages out
    vi.setSystemTime(new Date("2026-08-29T01:00:01Z"));
    const after = await policy.check({ merchant: "m", amount: 900 });
    vi.useRealTimers();
    expect(after.status).not.toBe("rejected");
  });

  it("approving a draft after intervening spend exhausted the cap is refused (cap enforced at approval)", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const drafted = await policy.check({ merchant: "m", amount: 900 });
    expect(drafted.status).toBe("draft");
    // Intervening below-threshold spend accrues 200 (fits under 1000)
    const intervening = await policy.check({ merchant: "m", amount: 200 });
    expect(intervening.status).toBe("approved");
    // Approving the now-over-cap draft (200 spent + 900 draft = 1100 > 1000)
    // must be refused — the cap is a guardrail on the approval money path,
    // not only on subsequent checks
    expect(policy.approveDraft(drafted.draftId as string)).toBe(false);
    // The refused approval recorded nothing; the draft stays pending
    const entry = policy
      .getAllDrafts()
      .find((d) => d.draftId === drafted.draftId);
    expect(entry?.approved).toBe(false);
    // Rejecting it afterwards works and records nothing
    expect(policy.rejectDraft(drafted.draftId as string)).toBe(true);
    // Cap headroom intact: 200 spent + 400 below-threshold = 600 <= 1000
    const after = await policy.check({ merchant: "m", amount: 400 });
    expect(after.status).toBe("approved");
  });

  it("queued drafts cannot be batch-approved past the cap (RP R3 finding)", async () => {
    const policy = new SpendingPolicy(HIGH_THRESHOLD);
    const d1 = await policy.check({ merchant: "m", amount: 600 });
    const d2 = await policy.check({ merchant: "m", amount: 600 });
    expect(d1.status).toBe("draft");
    expect(d2.status).toBe("draft");
    // Each individually fits; approving the first is fine
    expect(policy.approveDraft(d1.draftId as string)).toBe(true);
    // Approving the second (600 spent + 600 draft = 1200 > 1000) is refused
    expect(policy.approveDraft(d2.draftId as string)).toBe(false);
  });

  it("approval exactly reaching maxAmount is allowed (boundary)", async () => {
    const policy = new SpendingPolicy(CAP); // draftThreshold 100
    const d1 = await policy.check({ merchant: "m", amount: 700 });
    const d2 = await policy.check({ merchant: "m", amount: 300 });
    expect(d1.status).toBe("draft");
    expect(d2.status).toBe("draft");
    expect(policy.approveDraft(d1.draftId as string)).toBe(true);
    // 700 spent + 300 draft === 1000 maxAmount: allowed
    expect(policy.approveDraft(d2.draftId as string)).toBe(true);
  });
});
