import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * PATCH /api/pipelines/[id] — rename a pipeline. Admin-tier, account-scoped.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: string;
    } | null;
    const name = body?.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const rows = await query<{ id: string }>(
      `UPDATE pipelines SET name = $3, updated_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      [id, ctx.accountId, name],
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
 * DELETE /api/pipelines/[id] — delete a pipeline. ON DELETE CASCADE removes
 * its stages and deals (migration 001). Admin-tier, account-scoped.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;

    const rows = await query<{ id: string }>(
      `DELETE FROM pipelines
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
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
