import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Conversation } from "@/types";

/**
 * GET /api/deals/linked-conversation?contactId=...
 *
 * Returns the newest conversation for a contact (by last_message_at) so the
 * deal form can surface a "view conversation" link. Account-scoped so it can't
 * probe conversations outside the caller's account. Returns null when none.
 */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const contactId = new URL(request.url).searchParams.get("contactId");
    if (!contactId) {
      return NextResponse.json({ conversation: null });
    }

    const rows = await query<Conversation>(
      `SELECT * FROM conversations
        WHERE contact_id = $1 AND account_id = $2
        ORDER BY last_message_at DESC NULLS LAST
        LIMIT 1`,
      [contactId, ctx.accountId],
    );

    return NextResponse.json({ conversation: rows[0] ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
