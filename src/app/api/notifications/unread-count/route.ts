import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * GET /api/notifications/unread-count
 *
 * Number of unread notifications for the signed-in user. Drives the sidebar
 * Notifications badge. Notifications are per-user (not shared across the
 * account), so this is scoped to `user_id`.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await query<{ count: string }>(
      `SELECT count(*)::int AS count
         FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [ctx.userId],
    );
    return NextResponse.json({ count: Number(rows[0]?.count ?? 0) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
