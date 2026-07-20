import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import { query } from "@/lib/db/pool";
import type { Conversation, ConversationStatus } from "@/types";

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

/**
 * PATCH /api/conversations/[id]
 *
 * Partial update of a conversation from the thread view: status change,
 * agent assignment, or resetting unread_count to 0 on read. Only the three
 * whitelisted fields are writable, and the WHERE clause is account-scoped so
 * one account can't mutate another's conversation.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      status?: ConversationStatus;
      assigned_agent_id?: string | null;
      unread_count?: number;
    } | null;

    if (!body) {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }

    const sets: string[] = [];
    const values: unknown[] = [id, ctx.accountId];

    if (typeof body.status === "string") {
      values.push(body.status);
      sets.push(`status = $${values.length}`);
    }
    if ("assigned_agent_id" in body) {
      values.push(body.assigned_agent_id ?? null);
      sets.push(`assigned_agent_id = $${values.length}`);
    }
    if (typeof body.unread_count === "number") {
      values.push(body.unread_count);
      sets.push(`unread_count = $${values.length}`);
    }

    if (sets.length === 0) {
      return NextResponse.json({ error: "No updatable fields" }, { status: 400 });
    }

    const updated = await query<{ id: string }>(
      `UPDATE conversations
          SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $1 AND account_id = $2
        RETURNING id`,
      values,
    );

    if (updated.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
