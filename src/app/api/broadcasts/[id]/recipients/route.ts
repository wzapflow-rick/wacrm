// ============================================================
// GET /api/broadcasts/[id]/recipients — recipient rows for a broadcast
// (agent+), each joined to its contact. Account-scoped via the parent
// broadcast. Used by the broadcast detail page.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    // Confirm the broadcast belongs to this account before exposing rows.
    const owner = await query(
      `SELECT id FROM broadcasts WHERE id = $1 AND account_id = $2`,
      [id, ctx.accountId],
    );
    if (owner.length === 0) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    // Join each recipient to its contact as a nested `contact` object so
    // the client keeps the same shape the old PostgREST embed returned.
    const recipients = await query(
      `SELECT r.*,
              CASE WHEN c.id IS NULL THEN NULL ELSE to_jsonb(c.*) END AS contact
         FROM broadcast_recipients r
         LEFT JOIN contacts c ON c.id = r.contact_id
        WHERE r.broadcast_id = $1
        ORDER BY r.created_at DESC`,
      [id],
    );

    return NextResponse.json({ recipients });
  } catch (err) {
    return toErrorResponse(err);
  }
}
