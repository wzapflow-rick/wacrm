import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from "@/lib/dashboard/queries";

/**
 * GET /api/dashboard — all dashboard widgets in one round-trip.
 *
 * The query helpers accept the server DbClient shim, so they run here
 * against the pooled connection instead of a browser Supabase client.
 * The default 30-day conversations series is included; other ranges are
 * fetched on demand via /api/dashboard/series.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const db = ctx.supabase;

    const [metrics, series30, pipeline, responseTime, activity] =
      await Promise.all([
        loadMetrics(db),
        loadConversationsSeries(db, 30),
        loadPipelineDonut(db),
        loadResponseTime(db),
        loadActivity(db, 50),
      ]);

    return NextResponse.json({
      metrics,
      series30,
      pipeline,
      responseTime,
      activity,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
