import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * DELETE /api/pipelines/[id]/stages/[stageId]
 *
 * Removes a stage, but refuses if any deal still references it (the FK would
 * otherwise fail). The stage is joined to its pipeline to enforce the account
 * boundary — a caller can't delete a stage in another account's pipeline.
 * Admin-tier.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; stageId: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id, stageId } = await params;

    // Confirm the stage belongs to a pipeline in this account.
    const owned = await query<{ id: string }>(
      `SELECT s.id
         FROM pipeline_stages s
         JOIN pipelines p ON p.id = s.pipeline_id
        WHERE s.id = $1 AND s.pipeline_id = $2 AND p.account_id = $3`,
      [stageId, id, ctx.accountId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const deals = await query<{ id: string }>(
      `SELECT id FROM deals WHERE stage_id = $1 LIMIT 1`,
      [stageId],
    );
    if (deals.length > 0) {
      return NextResponse.json(
        { error: "Move or delete deals in this stage first" },
        { status: 409 },
      );
    }

    await query(`DELETE FROM pipeline_stages WHERE id = $1`, [stageId]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
