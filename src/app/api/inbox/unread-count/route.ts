import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * GET /api/inbox/unread-count
 *
 * Number of conversations in the account that have at least one unread inbound
 * message. Drives the green dot on the sidebar Inbox entry. Account-scoped
 * (every member sees the same shared inbox), matching the conversation list.
 */
export async function GET() {
  try {
    const ctx = await requireRole("agent");
    const rows = await query<{ count: string }>(
      `SELECT count(*)::int AS count
         FROM conversations
        WHERE account_id = $1 AND unread_count > 0`,
      [ctx.accountId],
    );
    return NextResponse.json({ count: Number(rows[0]?.count ?? 0) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
