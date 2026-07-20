import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import type { Conversation } from "@/types";

/**
 * GET /api/conversations/[id]
 *
 * Hydrate a single conversation with its contact + tags joined. The inbox
 * page calls this when a realtime/polling event references a conversation id
 * it doesn't yet have in state (contact joins never ride the change feed).
 * Account-scoped so one account can't read another's conversation.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("conversations")
      .select(CONVERSATION_SELECT)
      .eq("account_id", accountId)
      .eq("id", id)
      .maybeSingle();

    if (error) {
      console.error("[api/conversations/[id]] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to fetch conversation" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      conversation: data
        ? normalizeConversation(data as Conversation)
        : null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
