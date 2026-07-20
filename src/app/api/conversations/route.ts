import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  CONVERSATION_SELECT,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import type { Conversation } from "@/types";

/**
 * GET /api/conversations
 *
 * The inbox conversation list. Embeds each conversation's contact + tags via
 * the shared CONVERSATION_SELECT and returns them already normalized (tags
 * flattened onto `contact.tags`). Account-scoped — the shared inbox shows
 * every conversation in the caller's account. Replaces the browser's direct
 * Supabase read now that the client never talks to Postgres.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("account_id", accountId)
      .order("last_message_at", { ascending: false });

    if (error) {
      console.error("[api/conversations] list error:", error);
      return NextResponse.json(
        { error: "Failed to list conversations" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      conversations: normalizeConversations((data ?? []) as Conversation[]),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
