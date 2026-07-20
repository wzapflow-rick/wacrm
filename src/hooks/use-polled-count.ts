"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Polls a count endpoint on an interval and returns the latest value.
 *
 * Shared by the sidebar badges (unread conversations, unread notifications)
 * that formerly rode Supabase Realtime channels. Polling pauses while the tab
 * is hidden and does an immediate catch-up fetch when it becomes visible
 * again, so a backgrounded tab costs the VPS nothing.
 *
 * @param url          endpoint returning `{ count: number }`
 * @param intervalMs   poll cadence while visible (default 10s — badges are
 *                     lower-priority than the open inbox thread)
 */
export function usePolledCount(url: string, intervalMs = 10000): number {
  const [count, setCount] = useState(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchCount = async () => {
      if (inFlightRef.current || cancelled) return;
      inFlightRef.current = true;
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { count: number };
        if (!cancelled) setCount(data.count ?? 0);
      } catch {
        // Transient failure — keep the last known value, retry next tick.
      } finally {
        inFlightRef.current = false;
      }
    };

    const start = () => {
      if (intervalId != null) return;
      void fetchCount();
      intervalId = setInterval(() => void fetchCount(), intervalMs);
    };
    const stop = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [url, intervalMs]);

  return count;
}
