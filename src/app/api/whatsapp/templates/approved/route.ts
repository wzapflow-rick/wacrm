import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { MessageTemplate } from "@/types";

/**
 * List the account's APPROVED message templates (most-recent first) for the
 * inbox template picker. Templates are account-owned, so this scopes by
 * account_id — a teammate's approved templates must be sendable in a shared
 * account (the old client read incorrectly filtered by user_id).
 */
export async function GET() {
  try {
    const ctx = await requireRole("agent");
    const templates = await query<MessageTemplate>(
      `SELECT * FROM message_templates
        WHERE account_id = $1 AND status = 'APPROVED'
        ORDER BY created_at DESC`,
      [ctx.accountId],
    );
    return NextResponse.json({ templates });
  } catch (err) {
    return toErrorResponse(err);
  }
}
