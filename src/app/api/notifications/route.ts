import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Notification } from "@/types";

/**
 * GET /api/notifications
 *
 * The 100 most recent notifications for the signed-in user. Notifications are
 * per-user (not shared across the account), so this scopes to `user_id` — same
 * boundary as the unread-count badge endpoint.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const notifications = await query<Notification>(
      `SELECT * FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [ctx.userId],
    );
    return NextResponse.json({ notifications });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PATCH /api/notifications
 *
 * Marks notifications read for the signed-in user. With `{ id }` it marks a
 * single one; with no id it marks all unread. Always scoped to `user_id`.
 */
export async function PATCH(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      id?: string;
    } | null;
    const now = new Date().toISOString();

    if (body?.id) {
      await query(
        `UPDATE notifications SET read_at = $3
          WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
        [body.id, ctx.userId, now],
      );
    } else {
      await query(
        `UPDATE notifications SET read_at = $2
          WHERE user_id = $1 AND read_at IS NULL`,
        [ctx.userId, now],
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
