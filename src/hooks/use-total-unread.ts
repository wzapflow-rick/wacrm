"use client";

import { usePolledCount } from "@/hooks/use-polled-count";

/**
 * Count of conversations with at least one unread inbound message in the
 * account. Used by the sidebar to surface a green dot on the Inbox nav entry
 * when the user is elsewhere in the app.
 *
 * Formerly a Supabase Realtime channel; now polls `/api/inbox/unread-count`
 * every 10s (paused while the tab is hidden).
 */
export function useTotalUnread(): number {
  return usePolledCount("/api/inbox/unread-count");
}
