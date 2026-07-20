import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Profile } from "@/types";

/**
 * List the profiles that belong to the caller's account (for the assignment
 * dropdown in the message thread). Scoped by account_id — with RLS gone this
 * WHERE clause is the access boundary that keeps accounts isolated.
 */
export async function GET() {
  try {
    const ctx = await requireRole("agent");
    const profiles = await query<Profile>(
      `SELECT * FROM profiles WHERE account_id = $1 ORDER BY full_name`,
      [ctx.accountId],
    );
    return NextResponse.json({ profiles });
  } catch (err) {
    return toErrorResponse(err);
  }
}
