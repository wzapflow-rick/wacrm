import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { PipelineStage } from "@/types";

// Verifies the pipeline belongs to the caller's account. Returns false if not,
// so callers can 404 without leaking cross-account existence.
async function ownsPipeline(pipelineId: string, accountId: string) {
  const rows = await query<{ id: string }>(
    `SELECT id FROM pipelines WHERE id = $1 AND account_id = $2`,
    [pipelineId, accountId],
  );
  return rows.length > 0;
}

/**
 * GET /api/pipelines/[id]/stages — ordered stages for one pipeline.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ stages: [] });
    }
    const stages = await query<PipelineStage>(
      `SELECT * FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY position`,
      [id],
    );
    return NextResponse.json({ stages });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * PUT /api/pipelines/[id]/stages
 *
 * Upserts the full ordered stage list in one batch (insert new rows, update
 * existing name/color/position). Admin-tier. The pipeline_id on every row is
 * forced to the URL pipeline so a payload can't reparent stages elsewhere.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      stages?: { id?: string; name: string; color: string; position: number }[];
    } | null;
    const stages = body?.stages;
    if (!Array.isArray(stages)) {
      return NextResponse.json({ error: "stages required" }, { status: 400 });
    }

    const rows = stages.map((s) => ({
      id: s.id,
      pipeline_id: id,
      name: s.name,
      color: s.color,
      position: s.position,
    }));

    const { error } = await ctx.supabase
      .from("pipeline_stages")
      .upsert(rows as unknown as Record<string, unknown>[], {
        onConflict: "id",
      });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/pipelines/[id]/stages — add a single stage, returns the new row.
 * Admin-tier, account-scoped via the pipeline.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("admin");
    const { id } = await params;
    if (!(await ownsPipeline(id, ctx.accountId))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = (await request.json().catch(() => null)) as {
      name?: string;
      color?: string;
      position?: number;
    } | null;
    const name = body?.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const { data, error } = await ctx.supabase
      .from("pipeline_stages")
      .insert({
        pipeline_id: id,
        name,
        color: body?.color ?? "#3b82f6",
        position: body?.position ?? 0,
      })
      .select()
      .single();
    if (error || !data) {
      return NextResponse.json(
        { error: error?.message ?? "Failed to add stage" },
        { status: 500 },
      );
    }

    return NextResponse.json({ stage: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
