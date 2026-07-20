"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import type { Message, Conversation } from "@/types";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

/** How often to poll for inbox changes while the tab is visible. */
const POLL_INTERVAL_MS = 5000;

/**
 * Inbox change feed.
 *
 * Formerly a Supabase Realtime (WebSocket) subscription; now a lightweight
 * poller against `/api/inbox/changes`. The public API is unchanged — it still
 * emits `onMessageEvent` / `onConversationEvent` and exposes `isConnected` —
 * so the inbox page's event handlers and reconnect-resync machinery keep
 * working as-is.
 *
 * Behaviour:
 *   - Polls every 5s while the document is visible; pauses when hidden and
 *     resumes (with an immediate catch-up poll) when the tab is shown again.
 *   - Tracks a server-issued `cursor` (the DB clock) so successive polls have
 *     no gaps or client/server clock-skew.
 *   - `isConnected` reflects the last poll's success: a failed poll flips it
 *     false, the next success flips it true. The page treats that false→true
 *     edge as a reconnect and triggers a full resync — so transient errors
 *     self-heal.
 */
export function useRealtime({
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const [isConnected, setIsConnected] = useState(false);

  // Latest callbacks kept in refs so the polling effect doesn't restart when
  // the parent re-renders with fresh closures.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  // Server clock cursor. null until the first poll establishes it.
  const cursorRef = useRef<string | null>(null);
  const pollingRef = useRef(false);
  const stoppedRef = useRef(false);

  const poll = useCallback(async () => {
    // Guard against overlapping polls (a slow request spanning the interval).
    if (pollingRef.current || stoppedRef.current) return;
    pollingRef.current = true;
    try {
      const since = cursorRef.current;
      const url = since
        ? `/api/inbox/changes?since=${encodeURIComponent(since)}`
        : `/api/inbox/changes`;
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`changes poll failed: ${res.status}`);

      const data = (await res.json()) as {
        conversations: Conversation[];
        messages: Message[];
        cursor: string;
      };

      // Emit messages first, then conversations, so the authoritative
      // conversation fields (unread_count, last message) applied by the
      // conversation UPDATE win over the optimistic +1 the message INSERT
      // handler does.
      for (const msg of data.messages) {
        onMessageRef.current?.({ eventType: "INSERT", new: msg, old: {} });
      }
      for (const conv of data.conversations) {
        // A conversation whose row was created after our previous cursor is
        // brand new (INSERT); otherwise it's an existing row that changed
        // (UPDATE). The page's handlers converge either way, but this keeps
        // the semantics honest.
        const isNew =
          since != null && new Date(conv.created_at) > new Date(since);
        onConversationRef.current?.({
          eventType: isNew ? "INSERT" : "UPDATE",
          new: conv,
          old: {},
        });
      }

      cursorRef.current = data.cursor;
      setIsConnected(true);
    } catch {
      setIsConnected(false);
    } finally {
      pollingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    stoppedRef.current = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId != null) return;
      // Immediate catch-up poll, then settle into the interval.
      void poll();
      intervalId = setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    const stop = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        start();
      } else {
        // Pause polling while the tab is hidden to save the VPS and battery.
        stop();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stoppedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
      setIsConnected(false);
    };
  }, [enabled, poll]);

  const unsubscribe = useCallback(() => {
    stoppedRef.current = true;
    setIsConnected(false);
  }, []);

  return { isConnected, unsubscribe };
}
