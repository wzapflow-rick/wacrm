import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

// Editable deal columns. status is included so the won/lost/reopen actions and
// drag-to-move (stage_id) go through the same PATCH. account_id/user_id are
// intentionally omitted — they're immutable and session-derived.
const EDITABLE = [
  "title",
  "value",
  "currency",
  "contact_id",
  "stage_id",
  "assigned_to",
  "notes",
  "expected_close_date",
  "status",
] as const;

/**
 * PATCH /api/deals/[id] — partial update (edit, move stage, change status).
 * Agent-tier, account-scoped via the WHERE clause.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const sets: string[] = [];
    const values: unknown[] = [id, ctx.accountId];
    for (const col of EDITABLE) {
      if (col in body) {
        values.push(body[col]);
        sets.push(`${col} = $${values.length}`);
      }
    }
    if (sets.length === 0) {
      return NextResponse.json({ error: "No updatable fields" }, { status: 400 });
    }

    const rows = await query<{ id: string }>(
      `UPDATE deals SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      values,
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/deals/[id] — delete a deal. Agent-tier, account-scoped.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const rows = await query<{ id: string }>(
      `DELETE FROM deals WHERE id = $1 AND account_id = $2 RETURNING id`,
      [id, ctx.accountId],
    );
    if (rows.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
