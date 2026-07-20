// ============================================================
// GET /api/broadcasts/preview-contact — a representative contact for the
// personalization live-preview (agent+). Returns the account's most
// recent contact plus its custom-field values, keyed by field id.
// Returns { contact: null } when the account has no contacts yet.
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { Contact } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const rows = await query<Contact>(
      `SELECT * FROM contacts
        WHERE account_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [ctx.accountId],
    );
    const contact = rows[0] ?? null;

    const customValues: Record<string, string> = {};
    if (contact) {
      const valueRows = await query<{ custom_field_id: string; value: string | null }>(
        `SELECT custom_field_id, value
           FROM contact_custom_values
          WHERE contact_id = $1`,
        [contact.id],
      );
      for (const row of valueRows) {
        customValues[row.custom_field_id] = row.value ?? "";
      }
    }

    return NextResponse.json({ contact, customValues });
  } catch (err) {
    return toErrorResponse(err);
  }
}
