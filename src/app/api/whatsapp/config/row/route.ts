import { NextResponse } from "next/server";
import {
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";

/**
 * GET /api/whatsapp/config/row
 *
 * Returns the account's raw whatsapp_config row for the settings form to
 * hydrate from — WITHOUT the encrypted secrets (access_token / verify_token
 * never leave the server). The separate GET /api/whatsapp/config endpoint
 * still handles the live health check against Meta.
 *
 * One row per account (UNIQUE(account_id)), so we return a single object or
 * null. Scoped explicitly by account_id since there is no RLS anymore.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from("whatsapp_config")
      .select(
        "id, phone_number_id, waba_id, status, registered_at, subscribed_apps_at, last_registration_error, connected_at, updated_at",
      )
      .eq("account_id", ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error("[GET /api/whatsapp/config/row] error:", error);
      return NextResponse.json(
        { error: "Failed to load configuration" },
        { status: 500 },
      );
    }

    return NextResponse.json({ config: data ?? null });
  } catch (err) {
    return toErrorResponse(err);
  }
}
