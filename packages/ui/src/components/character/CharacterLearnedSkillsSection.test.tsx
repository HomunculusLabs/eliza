/**
 * Pins the empty learned-skills CTA handoff contract (#30867): clicking
 * "Learn a skill" must seed the floating chat composer via
 * CHAT_PREFILL_EVENT — the complete learning request visible to the user,
 * with send/progress/error owned by the chat surface — instead of firing a
 * background `client.sendChatMessage` whose conversation and rejection the
 * user never sees.
 */
// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import { CHAT_PREFILL_EVENT, type ChatPrefillEventDetail } from "../../events";
import { CharacterLearnedSkillsSection } from "./CharacterLearnedSkillsSection";

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn(),
    sendChatMessage: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CharacterLearnedSkillsSection chat handoff", () => {
  it("hands 'Learn a skill' to the chat composer via CHAT_PREFILL_EVENT, not a background send", async () => {
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [],
    });
    const sendChatMessage = client.sendChatMessage as ReturnType<typeof vi.fn>;

    const prefills: ChatPrefillEventDetail[] = [];
    const onPrefill = (event: Event) => {
      prefills.push((event as CustomEvent<ChatPrefillEventDetail>).detail);
    };
    window.addEventListener(CHAT_PREFILL_EVENT, onPrefill);
    try {
      render(<CharacterLearnedSkillsSection />);
      const cta = await screen.findByRole("button", { name: "Learn a skill" });
      fireEvent.click(cta);

      // The complete learning request is seeded for the user to review,
      // selected for immediate editing.
      await waitFor(() => expect(prefills.length).toBe(1));
      expect(prefills[0]).toEqual({
        text: "Help me learn a new skill. Ask what capability I want to practice.",
        select: true,
      });
      // The old fire-and-forget bridge must not run alongside the handoff.
      expect(sendChatMessage).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(CHAT_PREFILL_EVENT, onPrefill);
    }
  });

  it("still lists curated agent skills from /api/skills/curated", async () => {
    (client.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: [
        {
          name: "daily-triage",
          description: "Triage inbound",
          source: "agent-generated",
          createdAt: "2026-09-09T00:00:00.000Z",
          refinedCount: 2,
          status: "active",
        },
        {
          name: "human-owned",
          description: "human",
          source: "human",
          createdAt: "2026-09-09T00:00:00.000Z",
          refinedCount: 0,
          status: "active",
        },
      ],
    });
    render(<CharacterLearnedSkillsSection />);
    await waitFor(() =>
      expect(client.fetch).toHaveBeenCalledWith(
        "/api/skills/curated",
        expect.anything(),
      ),
    );
    expect(await screen.findByText("daily-triage")).toBeTruthy();
    // human-sourced skills are out of scope for this surface
    expect(screen.queryByText("human-owned")).toBeNull();
  });
});
