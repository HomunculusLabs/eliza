/** Verifies ChatSurface through the package's configured test harness. */
// @vitest-environment jsdom
//
// ChatSurface presentation + send wiring: renders the greeting on an empty
// thread, bubbles for prior messages, and gates the send button on non-empty
// input (firing onSend with the trimmed text). Real component in jsdom.
// Also owns the shared composer core contract (IME-safe Enter, push-to-talk
// hold-vs-tap, form-submit receipt, ChatComposerContext draft slot),
// consolidated from the former sibling ChatSurface.test.tsx (#30116).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageAttachment } from "../../../api/client-types-chat";
import { PUSH_TO_TALK_HOLD_MS } from "../../../gestures";
import { ChatComposerCtx } from "../../../state/ChatComposerContext.hooks";

const inlineWidgetMock = vi.hoisted(() => ({
  sendActionMessage: vi.fn(),
}));

vi.mock("../../chat/InlineWidgetText", async () => {
  const React = await import("react");
  return {
    InlineWidgetText({ content }: { content: string }) {
      const match = content.match(
        /\[CHOICE:[^\]]+\]\n([\s\S]*?)\n\[\/CHOICE\]/,
      );
      if (!match) return content;
      const prose = content.replace(match[0], "").trim();
      const options = match[1]
        .split("\n")
        .map((line) => line.split("="))
        .filter((parts): parts is [string, string] => parts.length === 2);
      return React.createElement(
        React.Fragment,
        null,
        prose || null,
        ...options.map(([value, label]) =>
          React.createElement(
            "button",
            {
              key: value,
              type: "button",
              "data-testid": `choice-${value}`,
              onClick: () => void inlineWidgetMock.sendActionMessage(value),
            },
            label,
          ),
        ),
      );
    },
  };
});

import { ChatSurface } from "../ChatSurface";
import type { ShellMessage } from "../shell-state";

// jsdom has no Pointer Capture; stub it so the push-to-talk hold machine's
// capture calls are no-ops that still report "not captured" on release.
beforeEach(() => {
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

afterEach(() => {
  cleanup();
  inlineWidgetMock.sendActionMessage.mockReset();
});

function surface(overrides: Partial<Parameters<typeof ChatSurface>[0]> = {}) {
  return <ChatSurface messages={[]} onSend={vi.fn()} canSend {...overrides} />;
}

function composerInput(): HTMLInputElement {
  return screen.getByRole("textbox") as HTMLInputElement;
}

describe("ChatSurface", () => {
  it("renders the greeting when there are no messages", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        greeting="Good morning! What would you like to do?"
      />,
    );
    expect(
      screen.getByText("Good morning! What would you like to do?"),
    ).toBeTruthy();
  });

  it("renders bubbles for prior messages", () => {
    const messages: ShellMessage[] = [
      {
        id: "1",
        role: "user",
        content: "Remind me to call Alex at 3pm",
        createdAt: 0,
      },
      {
        id: "2",
        role: "assistant",
        content: "Done — reminder set for 3:00 PM.",
        createdAt: 0,
      },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    expect(screen.getByText("Remind me to call Alex at 3pm")).toBeTruthy();
    expect(screen.getByText(/Done — reminder set/)).toBeTruthy();
  });

  it("renders first-run sign-in choices as clickable buttons", () => {
    const messages: ShellMessage[] = [
      {
        id: "first-run:greeting",
        role: "assistant",
        content: [
          "Hi, I'm Eliza. Sign in to Eliza Cloud and I'll get you set up.",
          "",
          "[CHOICE:first-run id=runtime]",
          "__first_run__:runtime:cloud=Sign in to Eliza Cloud",
          "[/CHOICE]",
        ].join("\n"),
        createdAt: 0,
      },
    ];

    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );

    const signIn = screen.getByRole("button", {
      name: "Sign in to Eliza Cloud",
    });
    expect(signIn.tagName).toBe("BUTTON");
    expect(screen.queryByText("[CHOICE:first-run id=runtime]")).toBeNull();

    fireEvent.click(signIn);
    expect(inlineWidgetMock.sendActionMessage).toHaveBeenCalledWith(
      "__first_run__:runtime:cloud",
    );
  });

  it("keeps ordinary reminder actions available in the ambient packaged chat", () => {
    const messages: ShellMessage[] = [
      {
        id: "reminder",
        role: "assistant",
        content: [
          "Time to stretch.",
          "",
          "[CHOICE:lifeops-reminder id=reminder-123]",
          "done=Done",
          "10 minutes=Snooze 10m",
          "skip=Skip",
          "[/CHOICE]",
        ].join("\n"),
        createdAt: 0,
      },
    ];

    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );

    expect(screen.getByText("Time to stretch.")).toBeTruthy();
    expect(screen.getByTestId("choice-done")).toBeTruthy();
    expect(screen.getByText("Snooze 10m")).toBeTruthy();
    expect(screen.getByText("Skip")).toBeTruthy();
  });

  it("disables send when input is empty", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("enables send when input has text and calls onSend", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(/message eliza/i);
    fireEvent.change(input, { target: { value: "Hi" } });
    const send = screen.getByRole("button", {
      name: /send/i,
    }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    expect(onSend).toHaveBeenCalledWith("Hi");
  });

  it("clears the input after a successful send", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const input = screen.getByPlaceholderText(
      /message eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hi" } });
    fireEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(input.value).toBe("");
  });

  it("disables the input + send when canSend=false", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={false} />);
    expect(
      (screen.getByPlaceholderText(/message eliza/i) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: /send/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("renders composer controls with the overlay icon-button touch target", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    const voiceToggle = screen.getByRole("button", {
      name: /voice input/i,
    }) as HTMLButtonElement;
    expect(voiceToggle.disabled).toBe(true);
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    expect(voiceToggle.querySelector("path[fill]")).toBeNull();
  });

  it("enables the voice toggle and toggles voice capture when wired", () => {
    const onToggleRecording = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onToggleRecording={onToggleRecording}
      />,
    );
    const voiceToggle = screen.getByRole("button", {
      name: /start voice input/i,
    }) as HTMLButtonElement;
    expect(voiceToggle.disabled).toBe(false);
    expect(voiceToggle.querySelector("svg")).not.toBeNull();
    const input = screen.getByLabelText("Message Eliza");
    // The mic is a trailing control: it follows the text input in the composer.
    expect(
      input.compareDocumentPosition(voiceToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // A bare click (no hold) toggles; it must not touch the dictate channel.
    const onDictateStart = vi.fn();
    fireEvent.click(voiceToggle);
    expect(onToggleRecording).toHaveBeenCalledTimes(1);
    expect(onDictateStart).not.toHaveBeenCalled();
  });

  it("submits on Enter (without Shift)", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(
      /message eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  From keyboard  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("From keyboard");
    expect(input.value).toBe("");
  });

  it("does not submit on Shift+Enter", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(
      /message eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("Draft");
  });

  it("does not send on Enter while canSend is false, even with a non-empty draft", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <ChatSurface messages={[]} onSend={onSend} canSend={false} />,
    );
    const input = screen.getByPlaceholderText(
      /message eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "queued" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("queued");
    // Once sending is re-enabled the same draft must go through on the next
    // Enter — the gate is a latch on canSend, not a swallowed draft.
    rerender(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("queued");
  });

  it("does not send on Enter when the draft is whitespace-only", () => {
    const onSend = vi.fn();
    render(<ChatSurface messages={[]} onSend={onSend} canSend={true} />);
    const input = screen.getByPlaceholderText(
      /message eliza/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders a typing indicator for an empty assistant placeholder", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const typing = screen.getByLabelText(/eliza is typing/i);
    expect(typing).toBeTruthy();
  });

  it("hides the VISION button when no onVision handler is provided", () => {
    render(<ChatSurface messages={[]} onSend={() => {}} canSend={true} />);
    expect(screen.queryByRole("button", { name: /my screen/i })).toBeNull();
  });

  it("renders an enabled VISION button that fires onVision when wired", () => {
    const onVision = vi.fn();
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onVision={onVision}
      />,
    );
    const vision = screen.getByRole("button", {
      name: /my screen/i,
    }) as HTMLButtonElement;
    expect(vision.disabled).toBe(false);
    expect(vision.querySelector("svg")).not.toBeNull();
    fireEvent.click(vision);
    expect(onVision).toHaveBeenCalledTimes(1);
  });

  it("disables the VISION button while a capture is in flight", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={true}
        onVision={() => {}}
        visionActive={true}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /my screen/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("disables the VISION button when canSend=false", () => {
    render(
      <ChatSurface
        messages={[]}
        onSend={() => {}}
        canSend={false}
        onVision={() => {}}
      />,
    );
    expect(
      (screen.getByRole("button", { name: /my screen/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("does not cover the transcript with a scrollback control", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const scroller = screen
      .getByTestId("shell-chat-surface")
      .querySelector(".overflow-y-auto") as HTMLDivElement;
    // Stub a tall, scrolled-up scroller.
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    let top = 100;
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v;
      },
    });
    scroller.scrollTo = ((opts: ScrollToOptions) => {
      top = opts.top ?? top;
    }) as HTMLElement["scrollTo"];
    fireEvent.scroll(scroller);
    expect(screen.queryByTestId("chat-surface-jump-to-latest")).toBeNull();
    expect(scroller.scrollTop).toBe(100);
  });

  it("marks the conversation list as a polite aria-live region for streaming announcements", () => {
    const messages: ShellMessage[] = [
      { id: "u", role: "user", content: "Hi", createdAt: 0 },
      { id: "a", role: "assistant", content: "Hello", createdAt: 1 },
    ];
    render(
      <ChatSurface messages={messages} onSend={() => {}} canSend={true} />,
    );
    const list = screen.getByRole("list");
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-atomic")).toBe("false");
  });

  it("never sends on the Enter that commits an IME composition (#9148)", () => {
    const onSend = vi.fn();
    render(surface({ onSend }));
    const input = composerInput();
    fireEvent.change(input, { target: { value: "こんにちは" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe("こんにちは");
  });

  it("renders user form submissions as a compact summary without protocol values", () => {
    const raw =
      '[form:submit reminder] {"title":"Quarterly report","time":"5pm"}';
    const { container } = render(
      surface({
        messages: [{ id: "u1", role: "user", content: raw, createdAt: 1 }],
      }),
    );
    expect(screen.getByTestId("form-submit-receipt").textContent).toBe(
      "Submitted reminder",
    );
    expect(container.textContent ?? "").not.toContain("[form:submit");
    expect(container.textContent ?? "").not.toContain("Quarterly report");
    expect(container.textContent ?? "").not.toContain("5pm");
  });

  it("mic hold dictates (start on hold, end on release) and suppresses the trailing click", () => {
    vi.useFakeTimers();
    try {
      const onToggleRecording = vi.fn();
      const onDictateStart = vi.fn();
      const onDictateEnd = vi.fn();
      render(surface({ onToggleRecording, onDictateStart, onDictateEnd }));
      const mic = screen.getByRole("button", { name: "Start voice input" });

      fireEvent.pointerDown(mic, { button: 0, pointerId: 7 });
      expect(onDictateStart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(PUSH_TO_TALK_HOLD_MS + 10);
      expect(onDictateStart).toHaveBeenCalledTimes(1);

      fireEvent.pointerUp(mic, { pointerId: 7 });
      expect(onDictateEnd).toHaveBeenCalledTimes(1);

      // The click the browser fires after pointerup must NOT also toggle.
      fireEvent.click(mic);
      expect(onToggleRecording).not.toHaveBeenCalled();
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("edits the shared ChatComposerContext draft slot under a provider", () => {
    function Provider({ children }: { children: ReactNode }) {
      const [chatInput, setChatInput] = useState("");
      const [chatPendingImages, setChatPendingImages] = useState<
        ImageAttachment[]
      >([]);
      return (
        <ChatComposerCtx.Provider
          value={{
            chatInput,
            chatSending: false,
            chatPendingImages,
            chatReplyTarget: null,
            setChatInput,
            setChatPendingImages,
            setChatReplyTarget: () => {},
          }}
        >
          <span data-testid="shared-draft" hidden>
            {chatInput}
          </span>
          {children}
        </ChatComposerCtx.Provider>
      );
    }
    render(<Provider>{surface()}</Provider>);
    fireEvent.change(composerInput(), { target: { value: "one draft" } });
    expect(screen.getByTestId("shared-draft").textContent).toBe("one draft");
  });
});
