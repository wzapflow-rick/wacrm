"use client";

import { usePolledCount } from "@/hooks/use-polled-count";

/**
 * Count of unread notifications for the current user. Used by the sidebar to
 * surface a badge on the Notifications nav entry.
 *
 * Formerly a Supabase Realtime channel; now polls
 * `/api/notifications/unread-count` every 10s (paused while the tab is
 * hidden). Notifications are per-user, so the endpoint scopes by user_id.
 */
export function useUnreadNotifications(): number {
  return usePolledCount("/api/notifications/unread-count");
}
