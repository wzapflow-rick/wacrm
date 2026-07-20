import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/automations/[id]/logs
 *
 * Returns the automation (account-scoped) plus its 100 most recent run logs,
 * each with its contact embedded. Account-scoped so a teammate can view logs
 * for any automation in the shared account.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("viewer");
    const { id } = await params;
    const db = ctx.supabase;

    const { data: automation, error: autErr } = await db
      .from("automations")
      .select("*")
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (autErr) {
      return NextResponse.json({ error: autErr.message }, { status: 500 });
    }
    if (!automation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { data: logs, error: logErr } = await db
      .from("automation_logs")
      .select("*, contact:contacts(id, name, phone)")
      .eq("automation_id", id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (logErr) {
      return NextResponse.json({ error: logErr.message }, { status: 500 });
    }

    return NextResponse.json({ automation, logs: logs ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
