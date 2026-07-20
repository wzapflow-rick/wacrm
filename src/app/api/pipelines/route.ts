import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import { createPipelineWithStages } from "@/lib/pipelines/server";
import type { Pipeline } from "@/types";

/**
 * GET /api/pipelines
 *
 * Lists the account's pipelines (oldest first). If the account has none, one
 * default "Sales Pipeline" with the spec default stages is seeded so the board
 * is never empty on first visit. Seeding is an admin-tier write, so it only
 * runs for members who can create pipelines; agents/viewers just get [].
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    let pipelines = await query<Pipeline>(
      `SELECT * FROM pipelines WHERE account_id = $1 ORDER BY created_at`,
      [ctx.accountId],
    );

    if (pipelines.length === 0 && ctx.role === "admin") {
      const seeded = await createPipelineWithStages(ctx.supabase, {
        accountId: ctx.accountId,
        userId: ctx.userId,
        name: "Sales Pipeline",
      });
      if (seeded) {
        pipelines = await query<Pipeline>(
          `SELECT * FROM pipelines WHERE account_id = $1 ORDER BY created_at`,
          [ctx.accountId],
        );
      }
    }

    return NextResponse.json({ pipelines });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/pipelines — create a pipeline + default stages. Admin-tier.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as {
      name?: string;
    } | null;
    const name = body?.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const pipeline = await createPipelineWithStages(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      name,
    });
    if (!pipeline) {
      return NextResponse.json(
        { error: "Failed to create pipeline" },
        { status: 500 },
      );
    }

    return NextResponse.json({ pipeline });
  } catch (err) {
    return toErrorResponse(err);
  }
}
