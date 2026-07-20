import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

/**
 * Aggregated counts for the settings landing page: templates (total +
 * pending), tags, custom fields, and whether WhatsApp is configured. Consolidated
 * into one server round-trip (previously several client-side Supabase count
 * queries). Everything is scoped to the caller's account/user — there is no RLS
 * anymore, so the scoping here is what protects the data.
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { supabase, userId, accountId } = ctx;

    const [
      templatesTotal,
      templatesPending,
      tags,
      customFields,
      whatsappRow,
    ] = await Promise.all([
      supabase
        .from("message_templates")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("message_templates")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "PENDING"),
      supabase
        .from("tags")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId),
      supabase
        .from("custom_fields")
        .select("id", { count: "exact", head: true })
        .eq("account_id", accountId),
      supabase
        .from("whatsapp_config")
        .select("phone_number_id")
        .eq("account_id", accountId)
        .maybeSingle(),
    ]);

    return NextResponse.json({
      counts: {
        templates: templatesTotal.count ?? null,
        templatesPending: templatesPending.count ?? null,
        tags: tags.count ?? null,
        customFields: customFields.count ?? null,
      },
      whatsappConfigured: !!whatsappRow.data?.phone_number_id,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
