import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Message } from "@/types";

/**
 * List all messages for a conversation (chronological). The conversation is
 * joined to enforce the account scope — a conversation id from another
 * account returns zero rows rather than leaking its messages.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id: conversationId } = await params;

    const messages = await query<Message>(
      `SELECT m.*
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.conversation_id = $1 AND c.account_id = $2
        ORDER BY m.created_at ASC`,
      [conversationId, ctx.accountId],
    );

    return NextResponse.json({ messages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
