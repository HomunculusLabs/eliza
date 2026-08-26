/**
 * Fetches an owner calendar window while preserving the feed's source truth.
 *
 * Consumers receive events and the authoritative complete/partial/unavailable
 * state together, so a failed source can never render as a healthy empty week.
 * Failures settle with a classified {@link CalendarErrorKind} (capability vs
 * auth vs transport), and previously loaded data survives only when the failed
 * request targeted the same window.
 */

import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeedState,
  LifeOpsCalendarSourceHealth,
} from "@elizaos/shared";
import { client, isApiError } from "@elizaos/ui/api";
import { useAppSelector } from "@elizaos/ui/state";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../api/client-calendar.js";
import type { CalendarClientMethods } from "../api/client-calendar.js";

const calendarClient = client as typeof client & CalendarClientMethods;

export type CalendarViewMode = "day" | "week" | "month";

/**
 * Why a calendar fetch failed, classified at the transport boundary. The
 * distinction drives the view's copy and affordances: only `capability` hides
 * Retry (upgrading the tier, not re-sending, is the fix), while `offline` and
 * `timeout` keep previously loaded data on screen.
 */
export type CalendarErrorKind =
  | "capability"
  | "auth"
  | "permission"
  | "offline"
  | "timeout"
  | "server";

export type CalendarSurfaceStatus =
  | "loading"
  | "empty"
  | "ready"
  | "partial"
  | "unavailable"
  | "error";

/** The shared-tier calendar capability gate's typed response code. */
const CALENDAR_RUNTIME_UNAVAILABLE_CODE = "calendar_runtime_unavailable";

/**
 * Maps a settled fetch failure to its user-facing class. Ordered by
 * specificity: the typed capability gate first (a bare 503 from the dedicated
 * tier's `Calendar service is not available` must stay a retryable `server`
 * error), then transport kinds the base client already distinguishes. The
 * connectivity check disambiguates a `network` fetch failure while the device
 * is actually online (server-side refusal) from true offline.
 */
export function classifyCalendarError(cause: unknown): CalendarErrorKind {
  if (isApiError(cause)) {
    if (
      cause.code === CALENDAR_RUNTIME_UNAVAILABLE_CODE &&
      cause.status === 503
    ) {
      return "capability";
    }
    if (cause.status === 401) return "auth";
    if (cause.status === 403) return "permission";
    if (cause.kind === "timeout") return "timeout";
    if (
      cause.kind === "network" &&
      typeof navigator !== "undefined" &&
      !navigator.onLine
    ) {
      return "offline";
    }
  }
  return "server";
}

export interface UseCalendarWeekOptions {
  viewMode?: CalendarViewMode;
  /** Base date for the window. Defaults to today. */
  baseDate?: Date;
}

export interface UseCalendarWeekResult {
  events: LifeOpsCalendarEvent[];
  feedState: LifeOpsCalendarFeedState | null;
  sources: LifeOpsCalendarSourceHealth[];
  status: CalendarSurfaceStatus;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  /** Classified cause of the settled `error`, when one exists. */
  errorKind: CalendarErrorKind | null;
  viewMode: CalendarViewMode;
  setViewMode: (mode: CalendarViewMode) => void;
  baseDate: Date;
  windowStart: Date;
  windowEnd: Date;
  refresh: () => Promise<void>;
  goToDate: (date: Date) => void;
  goToToday: () => void;
  goPrevious: () => void;
  goNext: () => void;
}

function windowDaysForMode(mode: CalendarViewMode): number {
  switch (mode) {
    case "day":
      return 1;
    case "month":
      return 42;
    default:
      return 7;
  }
}

function startOfLocalDay(date = new Date()): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonthGrid(date: Date): Date {
  const firstOfMonth = startOfLocalDay(date);
  firstOfMonth.setDate(1);
  const start = new Date(firstOfMonth);
  start.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  return start;
}

export function useCalendarWeek(
  opts: UseCalendarWeekOptions = {},
): UseCalendarWeekResult {
  const t = useAppSelector((s) => s.t);
  const loadFailedMessage = t("lifeopsCalendar.loadFailed", {
    defaultValue: "Calendar failed to load.",
  });
  const activeRequestId = useRef(0);
  const mountedRef = useRef(true);
  const [viewMode, setViewMode] = useState<CalendarViewMode>(
    opts.viewMode ?? "week",
  );
  const [baseDate, setBaseDate] = useState<Date>(
    () => opts.baseDate ?? new Date(),
  );
  const [events, setEvents] = useState<LifeOpsCalendarEvent[]>([]);
  const [feedState, setFeedState] = useState<LifeOpsCalendarFeedState | null>(
    null,
  );
  const [sources, setSources] = useState<LifeOpsCalendarSourceHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorKind, setErrorKind] = useState<CalendarErrorKind | null>(null);
  // Window key of the last SUCCESSFUL load. On a failed fetch, cached
  // events/feedState/sources survive only when the failed request targeted the
  // same window (stale-while-error for a refresh); a failed navigation to a
  // different window clears them so the grid never renders another month's
  // data as if it were the requested one.
  const loadedWindowKeyRef = useRef<string | null>(null);

  const windowStart = useMemo(() => {
    const dayStart = startOfLocalDay(baseDate);
    return viewMode === "month" ? startOfMonthGrid(dayStart) : dayStart;
  }, [baseDate, viewMode]);
  const windowEnd = useMemo(() => {
    const end = new Date(windowStart);
    end.setDate(end.getDate() + windowDaysForMode(viewMode));
    return end;
  }, [windowStart, viewMode]);

  const shiftBase = useCallback(
    (direction: 1 | -1) => {
      setBaseDate((current) => {
        const next = new Date(current);
        const days = windowDaysForMode(viewMode);
        if (viewMode === "month") {
          // Normalize to the 1st before shifting: setMonth on e.g. May 31 would
          // overflow ("June 31" -> July 1) and silently skip a month. The grid
          // is computed from the 1st via startOfMonthGrid, so this is safe.
          next.setDate(1);
          next.setMonth(next.getMonth() + direction);
        } else {
          next.setDate(next.getDate() + direction * days);
        }
        return next;
      });
    },
    [viewMode],
  );

  const goToToday = useCallback(() => setBaseDate(new Date()), []);
  const goToDate = useCallback((date: Date) => {
    const next = new Date(date);
    if (!Number.isFinite(next.getTime())) {
      throw new RangeError("Calendar date must be valid.");
    }
    setBaseDate(next);
  }, []);
  const goPrevious = useCallback(() => shiftBase(-1), [shiftBase]);
  const goNext = useCallback(() => shiftBase(1), [shiftBase]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRequestId.current += 1;
    };
  }, []);

  const fetch = useCallback(async () => {
    const requestId = activeRequestId.current + 1;
    activeRequestId.current = requestId;
    const isCurrentRequest = () =>
      mountedRef.current && activeRequestId.current === requestId;
    const windowKey = `${viewMode}:${windowStart.toISOString()}`;

    setLoading(true);
    setError(null);
    setErrorKind(null);
    try {
      const feed = await calendarClient.getLifeOpsCalendarFeed({
        side: "owner",
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const sorted = [...feed.events].sort((a, b) =>
        a.startAt.localeCompare(b.startAt),
      );
      if (!isCurrentRequest()) return;
      setEvents(sorted);
      setFeedState(feed.state);
      setSources([...feed.sources]);
      loadedWindowKeyRef.current = windowKey;
    } catch (cause) {
      // error-policy:J4 The calendar renders transport failure separately from an authoritative empty feed.
      if (!isCurrentRequest()) return;
      if (loadedWindowKeyRef.current !== windowKey) {
        // The failed request targeted a window we never loaded: drop the
        // previous window's cache instead of painting it as the new window.
        setEvents([]);
        setFeedState(null);
        setSources([]);
      }
      setErrorKind(classifyCalendarError(cause));
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : loadFailedMessage,
      );
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [windowStart, windowEnd, viewMode, loadFailedMessage]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  const status = useMemo<CalendarSurfaceStatus>(() => {
    if (error) return "error";
    if (feedState === "unavailable") return "unavailable";
    if (feedState === "partial") return "partial";
    if (loading && feedState === null) return "loading";
    if (feedState === "complete" && events.length === 0) return "empty";
    if (feedState === "complete") return "ready";
    return "loading";
  }, [error, events.length, feedState, loading]);

  return {
    events,
    feedState,
    sources,
    status,
    loading,
    refreshing: loading && feedState !== null,
    error,
    errorKind,
    viewMode,
    setViewMode,
    baseDate,
    windowStart,
    windowEnd,
    refresh: fetch,
    goToDate,
    goToToday,
    goPrevious,
    goNext,
  };
}
