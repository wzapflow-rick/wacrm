// ============================================================
// POST /api/broadcasts — dashboard broadcast launch (agent+).
//
// Resolves audience + persists broadcast/recipients synchronously so
// the client gets a broadcast id immediately, then fans out to Meta in
// after() (background). The client polls GET /api/broadcasts/[id] for
// progress. Runs on the self-hosted (non-serverless) server, so the
// after() task keeps running until the send loop completes even if the
// browser tab closes.
// ============================================================

import { NextResponse, after } from "next/server";

import { requireRole, getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import {
  createDashboardBroadcast,
  deliverDashboardBroadcast,
  DashboardBroadcastError,
  type DashboardBroadcastInput,
} from "@/lib/broadcasts/server";

// Generous headroom for the background fan-out on the standalone server.
export const maxDuration = 300;

// GET /api/broadcasts — list this account's broadcasts (newest first).
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const broadcasts = await query(
      `SELECT * FROM broadcasts
        WHERE account_id = $1
        ORDER BY created_at DESC`,
      [ctx.accountId],
    );
    return NextResponse.json({ broadcasts });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const input = (await request.json().catch(() => null)) as
      | DashboardBroadcastInput
      | null;

    if (!input || typeof input !== "object" || !input.template) {
      return NextResponse.json({ error: "Invalid broadcast payload" }, { status: 400 });
    }

    const plan = await createDashboardBroadcast(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      input,
    );

    // Fan out after the response flushes.
    after(async () => {
      try {
        await deliverDashboardBroadcast(plan);
      } catch (err) {
        console.error("[api/broadcasts] delivery failed:", err);
      }
    });

    return NextResponse.json(
      { broadcastId: plan.broadcastId, totalRecipients: plan.planned.length },
      { status: 202 },
    );
  } catch (err) {
    if (err instanceof DashboardBroadcastError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
