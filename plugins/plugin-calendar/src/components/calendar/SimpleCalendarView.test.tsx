/**
 * Verifies the chat-only calendar projection against canonical feed snapshots,
 * including local dates, event counts, refresh events, and shell clearance.
 *
 * @vitest-environment jsdom
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UseCalendarWeekResult } from "../../hooks/useCalendarWeek.js";

const fixtures = vi.hoisted(() => ({
  calendar: vi.fn(),
  viewEvents: new Map<string, () => void>(),
}));

vi.mock("../../hooks/useCalendarWeek.js", () => ({
  useCalendarWeek: fixtures.calendar,
}));

vi.mock("@elizaos/ui/events", () => ({
  NETWORK_STATUS_CHANGE_EVENT: "eliza:network-status-change",
  VIEW_EVENTS: { VIEW_REFRESH: "view:refresh" },
  useViewEvent: (eventType: string, callback: () => void) => {
    fixtures.viewEvents.set(eventType, callback);
  },
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { SimpleCalendarView } from "./SimpleCalendarView.js";

function event(
  title: string,
  hour: number,
  overrides: Partial<LifeOpsCalendarEvent> = {},
): LifeOpsCalendarEvent {
  const start = new Date(2026, 7, 4, hour, 0, 0, 0);
  const end = new Date(start);
  end.setHours(hour + 1);
  return {
    id: `event-${title}`,
    externalId: `external-${title}`,
    agentId: "agent-1",
    provider: "google",
    side: "owner",
    calendarId: "primary",
    title,
    description: "Film on the Light Phone",
    location: "",
    status: "confirmed",
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    isAllDay: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    htmlLink: null,
    conferenceLink: null,
    organizer: null,
    attendees: [],
    metadata: {},
    syncedAt: start.toISOString(),
    updatedAt: start.toISOString(),
    ...overrides,
  };
}

function calendarState(
  overrides: Partial<UseCalendarWeekResult> = {},
): UseCalendarWeekResult {
  const baseDate = new Date(2026, 7, 4, 12, 0, 0, 0);
  const windowStart = new Date(2026, 6, 26, 0, 0, 0, 0);
  const windowEnd = new Date(2026, 8, 6, 0, 0, 0, 0);
  return {
    events: [],
    feedState: "complete",
    sources: [],
    status: "empty",
    loading: false,
    refreshing: false,
    error: null,
    viewMode: "month",
    setViewMode: vi.fn(),
    baseDate,
    windowStart,
    windowEnd,
    refresh: vi.fn().mockResolvedValue(undefined),
    goToDate: vi.fn(),
    goToToday: vi.fn(),
    goPrevious: vi.fn(),
    goNext: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  fixtures.calendar.mockReset();
  fixtures.viewEvents.clear();
});

afterEach(cleanup);

describe("SimpleCalendarView", () => {
  it("renders canonical events with month navigation and selectable days", () => {
    const events = [event("Demo", 10), event("Team sync", 15)];
    fixtures.calendar.mockReturnValue(
      calendarState({ events, status: "ready" }),
    );

    const view = render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. 2 events" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Choose month and year. Current month is August 2026",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.getByText("Team sync")).toBeTruthy();
    expect(
      screen.getByLabelText("2 events on Tuesday, August 4, 2026"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Previous month/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Next month/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
    const augustSixth = screen.getByRole("button", {
      name: "Thursday, August 6, 2026",
    });
    fireEvent.click(augustSixth);
    expect(augustSixth.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("region", { name: "Events for 2026-08-06" }),
    ).toBeTruthy();
    expect(view.container.querySelector("form")).toBeNull();
  });

  it("changes month/year without walking every intermediate month", () => {
    const goToDate = vi.fn();
    fixtures.calendar.mockReturnValue(calendarState({ goToDate }));
    render(<SimpleCalendarView />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Choose month and year. Current month is August 2026",
      }),
    );
    fireEvent.click(screen.getByLabelText("Calendar year"));
    fireEvent.click(screen.getByRole("option", { name: "2027" }));
    fireEvent.click(screen.getByRole("button", { name: "Mar" }));

    expect(goToDate).toHaveBeenCalledTimes(1);
    expect(goToDate.mock.calls[0]?.[0]).toEqual(
      new Date(2027, 2, 1, 12, 0, 0, 0),
    );
  });

  it("extends content beneath chat while keeping its tail reachable", () => {
    fixtures.calendar.mockReturnValue(calendarState());
    const view = render(<SimpleCalendarView />);
    const root = view.getByTestId("simple-calendar-view");
    const scroll = view.getByTestId("simple-calendar-scroll-region");

    expect(root.style.height).toBe("100%");
    expect(root.style.position).toBe("relative");
    expect(root.style.overflow).toBe("hidden");
    expect(scroll.style.position).toBe("absolute");
    expect(scroll.style.overflowY).toBe("auto");
    expect(scroll.style.paddingBottom).toContain("--eliza-chat-clearance");
    expect(scroll.style.paddingInlineEnd).toContain(
      "--eliza-chat-side-clearance",
    );
    expect(scroll.style.gridTemplateColumns).toBe(
      "repeat(auto-fit, minmax(280px, 1fr))",
    );
    expect(scroll.style.alignContent).toBe("start");
  });

  it("refreshes the canonical feed after a completed chat action", () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    fixtures.calendar.mockReturnValue(calendarState({ refresh }));
    render(<SimpleCalendarView />);

    fixtures.viewEvents.get("view:refresh")?.();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("distinguishes transport failure from an empty calendar", () => {
    fixtures.calendar.mockReturnValue(
      calendarState({
        error: "Calendar agent disconnected",
        feedState: null,
        loading: false,
        status: "error",
      }),
    );
    render(<SimpleCalendarView />);

    expect(
      screen.getByRole("main", { name: "Calendar. Calendar unavailable" }),
    ).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "Calendar agent disconnected",
    );
  });
});

it("never renders the loading skeleton for a settled error", () => {
  // The reported bug: a settled transport failure kept feedState null, and
  // the view keyed "loaded" on feedState — painting the hydrate skeleton
  // forever. The view must key on the hook's status contract instead.
  fixtures.calendar.mockReturnValue(
    calendarState({
      error: "Calendar agent disconnected",
      errorKind: "server",
      feedState: null,
      loading: false,
      status: "error",
    }),
  );
  const view = render(<SimpleCalendarView />);

  expect(
    view.container.querySelector("[aria-label='Calendar events are loading']"),
  ).toBeNull();
  expect(
    screen.queryByRole("status", { name: "Calendar events are loading" }),
  ).toBeNull();
  // A classified error renders its class copy (server), not the raw message.
  expect(screen.getByRole("alert").textContent).toContain(
    "Calendar failed to load. Try again.",
  );
  const main = screen.getByRole("main");
  expect(main.getAttribute("aria-busy")).toBe("false");
});

it("renders the capability state without a Retry control", () => {
  fixtures.calendar.mockReturnValue(
    calendarState({
      error: "Calendar requires a dedicated agent runtime",
      errorKind: "capability",
      feedState: null,
      loading: false,
      status: "error",
    }),
  );
  render(<SimpleCalendarView />);

  expect(
    screen.getByText(
      "Calendar is available on dedicated agents. Upgrade this agent to use Calendar.",
    ),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Retry loading calendar" }),
  ).toBeNull();
});

it("offers Retry for retryable server errors", () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  fixtures.calendar.mockReturnValue(
    calendarState({
      error: "Calendar failed to load",
      errorKind: "server",
      feedState: null,
      loading: false,
      status: "error",
      refresh,
    }),
  );
  render(<SimpleCalendarView />);

  const retry = screen.getByRole("button", { name: "Retry loading calendar" });
  fireEvent.click(retry);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("keeps previously loaded events visible with a refresh-unavailable note", () => {
  fixtures.calendar.mockReturnValue(
    calendarState({
      events: [event("Stale sync", 10)],
      error: "Calendar agent disconnected",
      errorKind: "server",
      feedState: "complete",
      loading: false,
      status: "error",
    }),
  );
  render(<SimpleCalendarView />);

  expect(
    screen.getByRole("main", {
      name: "Calendar. 1 events · refresh unavailable",
    }),
  ).toBeTruthy();
  expect(screen.getByText("Stale sync")).toBeTruthy();
  expect(screen.getByText(/Showing 1 previously loaded event/i)).toBeTruthy();
});

it("renders the loading skeleton only while status is loading", () => {
  fixtures.calendar.mockReturnValue(
    calendarState({
      feedState: null,
      loading: true,
      status: "loading",
    }),
  );
  render(<SimpleCalendarView />);

  expect(
    screen.getByRole("status", { name: "Calendar events are loading" }),
  ).toBeTruthy();
});

it("surfaces source health on the ready state", () => {
  fixtures.calendar.mockReturnValue(
    calendarState({
      events: [event("Demo", 10)],
      feedState: "complete",
      status: "ready",
      sources: [
        {
          key: {
            provider: "google",
            side: "owner",
            grantId: "g1",
            connectorAccountId: "a1",
            calendarId: "primary",
          },
          summary: "Work",
          accessRole: "owner",
          visibility: "details",
          status: "fresh",
          syncedAt: "2026-08-01T12:00:00.000Z",
          error: null,
        },
      ],
    }),
  );
  const view = render(<SimpleCalendarView />);

  expect(
    view.container.querySelector('[data-testid="calendar-source-health"]'),
  ).toBeTruthy();
});
