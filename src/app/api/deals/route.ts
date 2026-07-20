import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";

interface DealPayload {
  title: string;
  value: number;
  currency: string;
  contact_id: string;
  pipeline_id: string;
  stage_id: string;
  assigned_to: string | null;
  notes: string | null;
  expected_close_date: string | null;
}

/**
 * POST /api/deals — create a deal. Agent-tier (operational, not settings).
 * account_id/user_id come from the session; the client never supplies them.
 * The pipeline is verified to belong to the caller's account so a deal can't
 * be attached to another account's pipeline.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as Partial<DealPayload> | null;

    if (!body?.title?.trim() || !body.contact_id || !body.stage_id || !body.pipeline_id) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const { data: pipeline } = await ctx.supabase
      .from("pipelines")
      .select("id")
      .eq("id", body.pipeline_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!pipeline) {
      return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
    }

    const { data, error } = await ctx.supabase
      .from("deals")
      .insert({
        title: body.title.trim(),
        value: body.value ?? 0,
        currency: body.currency,
        contact_id: body.contact_id,
        pipeline_id: body.pipeline_id,
        stage_id: body.stage_id,
        assigned_to: body.assigned_to ?? null,
        notes: body.notes ?? null,
        expected_close_date: body.expected_close_date ?? null,
        user_id: ctx.userId,
        account_id: ctx.accountId,
        status: "open",
      })
      .select()
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "Failed to create deal" },
        { status: 500 },
      );
    }

    return NextResponse.json({ deal: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
