import { NextRequest, NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * POST /api/presence/heartbeat  { status: 'online' | 'away' }
 *
 * Records the caller's presence for their account. Replaces the old
 * `touch_presence` RPC (which relied on auth.uid()). user_id is the PK, so
 * this upserts: first beat inserts, later beats refresh status + last_seen_at.
 */
export async function POST(request: NextRequest) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => ({}))) as {
      status?: unknown;
    };
    const status = body.status === "away" ? "away" : "online";

    await query(
      `INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id)
       DO UPDATE SET status = EXCLUDED.status,
                     last_seen_at = now(),
                     account_id = EXCLUDED.account_id`,
      [ctx.userId, ctx.accountId, status],
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
