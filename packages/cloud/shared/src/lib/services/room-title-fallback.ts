/**
 * Pure deterministic fallback titles for room-title classification; no imports
 * so the #30122/#30168 intent-boundary contract stays unit-testable in
 * isolation from the database and provider machinery in room-title.ts.
 */

/**
 * Intent keyword tests with a Unicode-aware word boundary.
 *
 * JS `\b` is ASCII-only, so it fired between an ASCII keyword and a non-ASCII
 * letter ("Supérieur…"), collapsing real first messages to generic titles
 * (#30168). Each test anchors at start-of-string and requires the next
 * character to be something other than a Unicode letter, number, mark, or
 * underscore — matching what a human reading "supper"/"sup time"/"supé"
 * would call a word boundary. Marks matter because `cleaned` is lowercased:
 * Turkish "İ" lowers to "i" + combining dot U+0307.
 */
const INTENT_BOUNDARY_TEST = {
  greeting: makeIntentTest("hi|hello|hey|howdy|greetings|yo|sup"),
  question: makeIntentTest("what|how|why|when|where|who|can|could|would|should|is|are|do|does"),
  help: makeIntentTest("help|assist|support|i need|please"),
  coding: makeIntentTest("code|write|create|build|make|implement|debug|fix"),
  explain: makeIntentTest("explain|tell me|describe|what is|define"),
} as const;

/** Compile an intent keyword alternation with a Unicode word boundary. */
function makeIntentTest(keywords: string): (input: string) => boolean {
  const pattern = new RegExp(`^(?:${keywords})(?![\\p{L}\\p{N}\\p{M}_])`, "iu");
  return (input: string) => pattern.test(input);
}

/**
 * Generate a descriptive title from the user message when AI fails.
 */
export function generateFallbackTitle(message: string): string {
  const cleaned = message.trim().toLowerCase();

  // Common greeting patterns -> generic titles
  // Word-boundary anchored so a prefix like "hi" in "history" cannot
  // collapse a real message to a generic title (#30122).
  if (INTENT_BOUNDARY_TEST.greeting(cleaned)) {
    return "New Conversation";
  }

  // Question patterns
  if (INTENT_BOUNDARY_TEST.question(cleaned)) {
    const words = message.trim().split(/\s+/).slice(0, 6);
    if (words.length >= 3) {
      return capitalizeFirst(words.slice(0, 5).join(" "));
    }
    return "Question & Answer";
  }

  // Help/assist patterns
  if (INTENT_BOUNDARY_TEST.help(cleaned)) {
    return "Help Request";
  }

  // Code/technical patterns
  if (INTENT_BOUNDARY_TEST.coding(cleaned)) {
    return "Coding Assistance";
  }

  // Explain patterns
  if (INTENT_BOUNDARY_TEST.explain(cleaned)) {
    return "Explanation Request";
  }

  // For other messages, extract first few meaningful words
  const words = message.trim().split(/\s+/);
  if (words.length <= 5) {
    return capitalizeFirst(words.join(" ").replace(/[.!?]+$/, ""));
  }

  // Take first 5 words and capitalize
  const title = words.slice(0, 5).join(" ");
  return capitalizeFirst(title) + "...";
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
