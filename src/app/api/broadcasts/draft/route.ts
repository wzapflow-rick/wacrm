// ============================================================
// POST /api/broadcasts/draft — save a draft broadcast (agent+).
//
// No audience resolution, no recipients, no sending: just a labelled
// row the user can revisit from the list. Counts are trigger-owned and
// left at their defaults.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

interface DraftBody {
  name?: string;
  templateName?: string;
  templateLanguage?: string;
  variables?: Record<string, unknown>;
  audienceFilter?: Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as DraftBody | null;

    const name = body?.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "A broadcast name is required" }, { status: 400 });
    }
    if (!body?.templateName) {
      return NextResponse.json({ error: "A template is required" }, { status: 400 });
    }

    const rows = await query<{ id: string }>(
      `INSERT INTO broadcasts
         (user_id, account_id, name, template_name, template_language,
          template_variables, audience_filter, status, total_recipients)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 0)
       RETURNING id`,
      [
        ctx.userId,
        ctx.accountId,
        name,
        body.templateName,
        body.templateLanguage ?? "en_US",
        JSON.stringify(body.variables ?? {}),
        JSON.stringify(body.audienceFilter ?? {}),
      ],
    );

    return NextResponse.json({ broadcastId: rows[0]?.id }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
