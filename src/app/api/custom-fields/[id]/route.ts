// ============================================================
// PATCH  /api/custom-fields/[id]  — rename a field (admin+)
// DELETE /api/custom-fields/[id]  — delete a field (admin+)
//
// Account-scoped: the WHERE clause pins account_id so an admin can't touch
// another account's field by guessing its id.
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { CustomField } from "@/types";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      field_name?: unknown;
    } | null;
    const name =
      typeof body?.field_name === "string" ? body.field_name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "field_name is required" },
        { status: 400 },
      );
    }

    const clash = await query<{ id: string }>(
      `SELECT id FROM custom_fields
        WHERE account_id = $1 AND lower(field_name) = lower($2) AND id <> $3
        LIMIT 1`,
      [ctx.accountId, name, id],
    );
    if (clash.length > 0) {
      return NextResponse.json({ error: "duplicate" }, { status: 409 });
    }

    const updated = await query<CustomField>(
      `UPDATE custom_fields SET field_name = $3
        WHERE id = $1 AND account_id = $2
        RETURNING *`,
      [id, ctx.accountId, name],
    );
    if (updated.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ field: updated[0] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const deleted = await query<{ id: string }>(
      `DELETE FROM custom_fields
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      [id, ctx.accountId],
    );
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
