import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { loadConversationsSeries } from "@/lib/dashboard/queries";

/**
 * GET /api/dashboard/series?days=7|30|90 — conversations time series for a
 * single range, used when the user switches the chart's range tab.
 */
export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const parsed = Number(searchParams.get("days"));
    const days = parsed === 7 || parsed === 90 ? parsed : 30;

    const series = await loadConversationsSeries(ctx.supabase, days);
    return NextResponse.json({ series });
  } catch (err) {
    return toErrorResponse(err);
  }
}
