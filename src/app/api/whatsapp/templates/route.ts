import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

/**
 * List the caller's message templates (most-recent first). Replaces the
 * client-side Supabase read in the template manager. Scoped by user_id — no
 * RLS anymore, so the .eq('user_id', ...) here is the access boundary.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data, error } = await ctx.supabase
      .from("message_templates")
      .select("*")
      .eq("user_id", ctx.userId)
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[GET /api/whatsapp/templates] error:", error);
      return NextResponse.json(
        { error: "Failed to load templates" },
        { status: 500 },
      );
    }

    return NextResponse.json({ templates: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
