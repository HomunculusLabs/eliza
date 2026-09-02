/**
 * Pins the deterministic room-title contract at its owning boundary: skip
 * paths (missing room, already titled, no user message, too-short text), the
 * happy-path write through roomsRepository.update, and the fallback-title
 * intent classification, including the word-boundary regression where
 * "history of rome"-class first messages were permanently retitled to a
 * generic bucket (#30122). Deterministic bun:test with the repositories and
 * logger mocked; no database, no runtime.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const roomsFindById = mock();
const roomsUpdate = mock();
const memoriesFindMessages = mock();

mock.module("../../db/repositories", () => ({
  roomsRepository: { findById: roomsFindById, update: roomsUpdate },
  memoriesRepository: { findMessages: memoriesFindMessages },
}));

mock.module("../utils/logger", () => ({
  logger: { info: mock(), warn: mock(), error: mock(), debug: mock() },
}));

const { generateRoomTitle } = await import(`./room-title.ts?test=room-title-${Date.now()}`);

const ROOM_ID = "room-1";

/** A memory row as the memories repository returns them. */
function message(content: unknown): { content: unknown } {
  return { content };
}

/** The first user message that drives title derivation. */
function userMessage(text: string): { content: unknown } {
  return message({ source: "user", text });
}

/**
 * Run generateRoomTitle against one seeded user message and return the title
 * the room would be renamed to (or null when generation is skipped).
 */
async function titleFor(text: string): Promise<string | null> {
  roomsFindById.mockResolvedValueOnce({ name: "New Chat" });
  memoriesFindMessages.mockResolvedValueOnce([message("old agent turn"), userMessage(text)]);
  return generateRoomTitle(ROOM_ID);
}

beforeEach(() => {
  roomsFindById.mockReset();
  roomsUpdate.mockReset();
  memoriesFindMessages.mockReset();
  roomsUpdate.mockResolvedValue(undefined);
  memoriesFindMessages.mockResolvedValue([]);
});

describe("generateRoomTitle — skip paths", () => {
  test("missing room returns null and never writes", async () => {
    roomsFindById.mockResolvedValue(null);

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBeNull();
    expect(memoriesFindMessages).not.toHaveBeenCalled();
    expect(roomsUpdate).not.toHaveBeenCalled();
  });

  test("a room that already has a real title is left alone", async () => {
    roomsFindById.mockResolvedValue({ name: "Existing title" });

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBeNull();
    expect(memoriesFindMessages).not.toHaveBeenCalled();
    expect(roomsUpdate).not.toHaveBeenCalled();
  });

  test("a room with no messages returns null", async () => {
    roomsFindById.mockResolvedValue({ name: "New Chat" });
    memoriesFindMessages.mockResolvedValue([]);

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBeNull();
    expect(roomsUpdate).not.toHaveBeenCalled();
  });

  test("a conversation with no user-source message returns null", async () => {
    roomsFindById.mockResolvedValue({ name: "New Chat" });
    memoriesFindMessages.mockResolvedValue([
      message({ source: "agent", text: "How can I help?" }),
      message("plain string memory"),
    ]);

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBeNull();
    expect(roomsUpdate).not.toHaveBeenCalled();
  });

  test("a user message shorter than 3 characters returns null", async () => {
    roomsFindById.mockResolvedValue({ name: "New Chat" });
    memoriesFindMessages.mockResolvedValue([userMessage("hi")]);

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBeNull();
    expect(roomsUpdate).not.toHaveBeenCalled();
  });
});

describe("generateRoomTitle — happy path write", () => {
  test("derives the title from the first user message and persists it", async () => {
    roomsFindById.mockResolvedValue({ name: "New Chat" });
    memoriesFindMessages.mockResolvedValue([
      message({ source: "agent", text: "earlier turn" }),
      userMessage("History of the Roman Empire"),
    ]);

    await expect(generateRoomTitle(ROOM_ID)).resolves.toBe("History of the Roman Empire");
    expect(roomsUpdate).toHaveBeenCalledTimes(1);
    expect(roomsUpdate).toHaveBeenCalledWith(ROOM_ID, { name: "History of the Roman Empire" });
  });
});

describe("generateFallbackTitle — word-boundary regression (#30122)", () => {
  // Each entry: [first user message, expected room title]. Before the fix the
  // intent regexes matched word PREFIXES, so the left-hand messages below were
  // misfiled into a generic bucket (e.g. "History..." -> "New Conversation").
  // The Island/Dos rows are extended past five words so the misfiled question
  // branch (no ellipsis) and the correct default branch (ellipsis) diverge —
  // at five words both produce the same title and pin nothing.
  const CASES: Array<[string, string]> = [
    ["History of the Roman Empire", "History of the Roman Empire"],
    ["History of the Roman Empire, its rise and fall", "History of the Roman Empire,..."],
    ["You were right about the deploy", "You were right about the..."],
    ["Suppose I want to test payments", "Suppose I want to test..."],
    ["Heyday of summer reading", "Heyday of summer reading"],
    ["Island destinations for the trip we discussed", "Island destinations for the trip..."],
    ["Dos and don'ts of testing cloud deploys", "Dos and don'ts of testing..."],
    ["Supporting evidence for claim three", "Supporting evidence for claim three"],
    ["Written notes from the standup", "Written notes from the standup"],
  ];

  for (const [text, expected] of CASES) {
    test(`titles "${text}" as "${expected}"`, async () => {
      await expect(titleFor(text)).resolves.toBe(expected);
    });
  }
});

describe("generateFallbackTitle — intent buckets still match whole words", () => {
  const CASES: Array<[string, string]> = [
    ["hello there, quick question", "New Conversation"],
    ["yo! deploy is broken", "New Conversation"],
    ["how do I rotate keys", "How do I rotate keys"],
    ["is it raining today", "Is it raining today"],
    ["why?", "Question & Answer"],
    ["please help me with billing", "Help Request"],
    ["i need someone to review this", "Help Request"],
    ["write a haiku about spring", "Coding Assistance"],
    ["fix the flaky login test", "Coding Assistance"],
    ["explain quantum entanglement", "Explanation Request"],
    ["define success metrics", "Explanation Request"],
  ];

  for (const [text, expected] of CASES) {
    test(`titles "${text}" as "${expected}"`, async () => {
      await expect(titleFor(text)).resolves.toBe(expected);
    });
  }
});

describe("generateFallbackTitle — default extraction", () => {
  test("capitalizes a short message without adding an ellipsis", async () => {
    await expect(titleFor("small business ideas")).resolves.toBe("Small business ideas");
  });

  test("truncates a longer message to five words with an ellipsis", async () => {
    await expect(titleFor("one two three four five six")).resolves.toBe(
      "One two three four five...",
    );
  });

  test("strips trailing sentence punctuation from a short message", async () => {
    await expect(titleFor("nice work today!")).resolves.toBe("Nice work today");
  });
});
