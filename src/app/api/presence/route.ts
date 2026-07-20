import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

interface PresenceApiRow {
  user_id: string;
  status: "online" | "away";
  last_seen_at: string;
}

/**
 * GET /api/presence
 *
 * All presence rows for the caller's account. Viewers derive online/away/
 * offline from `status` + `last_seen_at` staleness client-side. Polling
 * replacement for the old `presence:<accountId>` Realtime channel.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const rows = await query<PresenceApiRow>(
      `SELECT user_id, status, last_seen_at
         FROM member_presence
        WHERE account_id = $1`,
      [ctx.accountId],
    );
    return NextResponse.json({ presence: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}
