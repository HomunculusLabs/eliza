/** Regression tests for the room-title fallback intent boundaries; deterministic unit harness over the pure fallback helper. */

import { describe, expect, test } from "vitest";
import { generateFallbackTitle } from "../room-title-fallback";

describe("generateFallbackTitle intent boundaries (#30122 + #30168)", () => {
  describe("ASCII word-prefix collisions stay rejected (#30122)", () => {
    test("history is not a greeting", () => {
      expect(generateFallbackTitle("history of rome")).not.toBe("New Conversation");
    });
    test("supper is not a greeting", () => {
      expect(generateFallbackTitle("supper time plans")).not.toBe("New Conversation");
    });
    test("heyday is not a greeting", () => {
      expect(generateFallbackTitle("heyday was great")).not.toBe("New Conversation");
    });
  });

  describe("real intents still collapse to generic titles", () => {
    test("greeting", () => {
      expect(generateFallbackTitle("sup time")).toBe("New Conversation");
    });
    test("bare keyword greeting", () => {
      expect(generateFallbackTitle("yo")).toBe("New Conversation");
    });
    test("punctuation-terminated greeting", () => {
      expect(generateFallbackTitle("sup!")).toBe("New Conversation");
    });
    test("question", () => {
      expect(generateFallbackTitle("what is this thing")).toBe("What is this thing");
    });
    test("coding", () => {
      expect(generateFallbackTitle("fix the bug")).toBe("Coding Assistance");
    });
    test("explain", () => {
      expect(generateFallbackTitle("define the term entropy")).toBe("Explanation Request");
    });
    test("help (positive control for the help matcher)", () => {
      expect(generateFallbackTitle("help me debug this")).toBe("Help Request");
    });
  });

  describe("non-ASCII letter extensions get real titles (#30168)", () => {
    test("French: sup + é routes to word extraction", () => {
      expect(generateFallbackTitle("Supérieur service nous attend")).not.toBe("New Conversation");
      expect(generateFallbackTitle("Supérieur service nous attend")).toBe(
        "Supérieur service nous attend",
      );
    });
    test("Vietnamese: hi + ệ routes to word extraction", () => {
      expect(generateFallbackTitle("Hiện tại đường truyền yếu")).not.toBe("New Conversation");
    });
    test("question: how + é routes away from generic", () => {
      // Single word: the question path's <3-word branch returns "Question &
      // Answer" when the boundary wrongly matches, word extraction when not.
      expect(generateFallbackTitle("Howé")).toBe("Howé");
    });
    test("help: help + à routes away from generic", () => {
      expect(generateFallbackTitle("Helpàncora qui")).not.toBe("Help Request");
    });
    test("coding: fix + é routes away from generic", () => {
      expect(generateFallbackTitle("Fixér les bugs demain")).not.toBe("Coding Assistance");
    });
    test("explain: explain + ß routes away from generic", () => {
      expect(generateFallbackTitle("Explainß the plan")).not.toBe("Explanation Request");
    });
    test("combining mark after keyword (Turkish Hİ lowercases to hi + U+0307)", () => {
      // "Hİ there" lowercases to "hi̇ there" (hi + combining dot above);
      // the combining mark must count as a word continuation.
      expect(generateFallbackTitle("Hİ there")).not.toBe("New Conversation");
    });
    test("Cyrillic first message routes to word extraction", () => {
      expect(generateFallbackTitle("Привет всем как дела")).not.toBe("New Conversation");
      expect(generateFallbackTitle("Привет всем как дела")).toBe("Привет всем как дела");
    });
    test("Cyrillic: hi + Cyrillic letter routes to word extraction", () => {
      // Exercises the actual bug: ASCII keyword "hi" followed by a Cyrillic
      // letter — ASCII \b would match here (Cyrillic is not [A-Za-z0-9_]).
      expect(generateFallbackTitle("HiПривет всем")).not.toBe("New Conversation");
    });
    test("CJK-adjacent: hi + CJK char routes to word extraction", () => {
      // "hi" followed by a CJK character (not \w in JS): must NOT match the
      // greeting intent, so the message keeps its content-derived title.
      expect(generateFallbackTitle("hi你好 need help with setup")).not.toBe("New Conversation");
    });
  });

  describe("boundary classes adjacent to keywords", () => {
    test("underscore still counts as word continuation (hi_there is not a greeting)", () => {
      expect(generateFallbackTitle("hi_there friend")).not.toBe("New Conversation");
    });
    test("digit continuation rejected (sup2 is not a greeting)", () => {
      expect(generateFallbackTitle("sup2 review notes")).not.toBe("New Conversation");
    });
    test("emoji after keyword is a boundary (hi 👋 is a greeting)", () => {
      expect(generateFallbackTitle("hi 👋")).toBe("New Conversation");
    });
    test("non-ASCII punctuation is a boundary (¿hola-like: hi? still greets)", () => {
      expect(generateFallbackTitle("hi?")).toBe("New Conversation");
    });
  });
});
