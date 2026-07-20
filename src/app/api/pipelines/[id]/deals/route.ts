import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Deal } from "@/types";

/**
 * GET /api/pipelines/[id]/deals
 *
 * Deals for one pipeline with their contact and assignee embedded, newest
 * first. Uses the shim's relational select so the nested `contact` and
 * `assignee` shapes match what the board expects. Account-scoped: the
 * pipeline_id filter is combined with the account check on the pipeline.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    // Guard: only return deals for a pipeline in this account.
    const owned = await query<{ id: string }>(
      `SELECT id FROM pipelines WHERE id = $1 AND account_id = $2`,
      [id, ctx.accountId],
    );
    if (owned.length === 0) {
      return NextResponse.json({ deals: [] });
    }

    const { data, error } = await ctx.supabase
      .from("deals")
      .select(
        "*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)",
      )
      .eq("pipeline_id", id)
      .order("created_at", { ascending: false });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ deals: (data ?? []) as Deal[] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
