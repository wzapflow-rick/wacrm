import { NextRequest, NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Conversation, Message } from "@/types";

/**
 * GET /api/inbox/changes?since=<iso>
 *
 * Polling replacement for the old Supabase Realtime channel. Returns rows that
 * changed since the caller's cursor, account-scoped:
 *   - messages   — created since `since` (new inbound/outbound messages)
 *   - conversations — updated since `since` (unread count, last message,
 *     status, assignment, AI flags…)
 *
 * `messages` has no `updated_at`, so message status ticks (sent→delivered→
 * read) are not streamed individually; the conversation UPDATE plus the
 * thread's own resync cover the list- and thread-level state. The response
 * `cursor` is the server clock at query time — the client sends it back on the
 * next poll, so there are no gaps or clock-skew issues between client/server.
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await requireRole("agent");

    const sinceParam = request.nextUrl.searchParams.get("since");
    // Fall back to "now" when the client hasn't established a cursor yet, so
    // the very first poll doesn't dump the whole table as "changes".
    const since = sinceParam ? new Date(sinceParam) : new Date();
    if (Number.isNaN(since.getTime())) {
      return NextResponse.json({ error: "invalid since" }, { status: 400 });
    }
    const sinceIso = since.toISOString();

    // Single round-trip: both delta sets plus the authoritative server clock.
    const [conversations, messages, clock] = await Promise.all([
      query<Conversation>(
        `SELECT * FROM conversations
          WHERE account_id = $1 AND updated_at > $2
          ORDER BY updated_at ASC
          LIMIT 200`,
        [ctx.accountId, sinceIso],
      ),
      query<Message>(
        `SELECT m.*
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.account_id = $1 AND m.created_at > $2
          ORDER BY m.created_at ASC
          LIMIT 200`,
        [ctx.accountId, sinceIso],
      ),
      query<{ now: string }>(`SELECT now() AS now`),
    ]);

    return NextResponse.json({
      conversations,
      messages,
      cursor: clock[0]?.now ?? sinceIso,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
