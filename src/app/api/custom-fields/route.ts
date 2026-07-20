// ============================================================
// GET  /api/custom-fields  — list the account's custom field definitions
// POST /api/custom-fields  — create one (admin+)
//
// These manage the account-wide field catalogue only; per-contact values live
// elsewhere. All queries are account-scoped (no RLS anymore).
// ============================================================
import { NextResponse } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { query } from "@/lib/db/pool";
import type { CustomField } from "@/types";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const fields = await query<CustomField>(
      `SELECT * FROM custom_fields WHERE account_id = $1 ORDER BY field_name`,
      [ctx.accountId],
    );
    return NextResponse.json({ fields });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("admin");
    const body = (await request.json().catch(() => null)) as {
      field_name?: unknown;
    } | null;
    const name =
      typeof body?.field_name === "string" ? body.field_name.trim() : "";
    if (!name) {
      return NextResponse.json(
        { error: "field_name is required" },
        { status: 400 },
      );
    }

    // Case-insensitive uniqueness within the account.
    const clash = await query<{ id: string }>(
      `SELECT id FROM custom_fields
        WHERE account_id = $1 AND lower(field_name) = lower($2) LIMIT 1`,
      [ctx.accountId, name],
    );
    if (clash.length > 0) {
      return NextResponse.json({ error: "duplicate" }, { status: 409 });
    }

    const rows = await query<CustomField>(
      `INSERT INTO custom_fields (field_name, field_type, user_id, account_id)
       VALUES ($1, 'text', $2, $3)
       RETURNING *`,
      [name, ctx.userId, ctx.accountId],
    );
    return NextResponse.json({ field: rows[0] }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
