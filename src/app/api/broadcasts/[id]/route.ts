// ============================================================
// /api/broadcasts/[id] — single broadcast (agent+).
//
//   GET    → the full broadcast row. Used both by the send wizard's
//            progress polling (reads status + trigger-maintained counts)
//            and by the detail page. Account-scoped: 404 for other
//            accounts.
//   DELETE → remove the broadcast. broadcast_recipients cascades on
//            broadcasts.id (migration 001).
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const rows = await query(
      `SELECT * FROM broadcasts WHERE id = $1 AND account_id = $2`,
      [id, ctx.accountId],
    );

    if (rows.length === 0) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    return NextResponse.json({ broadcast: rows[0] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;

    const deleted = await query(
      `DELETE FROM broadcasts WHERE id = $1 AND account_id = $2 RETURNING id`,
      [id, ctx.accountId],
    );

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Broadcast not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
