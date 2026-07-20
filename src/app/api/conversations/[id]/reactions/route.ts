import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { MessageReaction } from "@/types";

/**
 * List all reactions for a conversation. Scoped to the account via a join on
 * conversations (message_reactions has no account_id of its own).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id: conversationId } = await params;

    const reactions = await query<MessageReaction>(
      `SELECT r.*
         FROM message_reactions r
         JOIN conversations c ON c.id = r.conversation_id
        WHERE r.conversation_id = $1 AND c.account_id = $2`,
      [conversationId, ctx.accountId],
    );

    return NextResponse.json({ reactions });
  } catch (err) {
    return toErrorResponse(err);
  }
}
