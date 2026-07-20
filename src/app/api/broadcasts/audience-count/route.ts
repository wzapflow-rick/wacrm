// ============================================================
// POST /api/broadcasts/audience-count — estimated reach (agent+).
//
// Resolves an AudienceConfig with the SAME server logic the actual send
// uses (src/lib/broadcasts/server#resolveAudience), so the wizard's
// preview count always matches how many recipients a send would create.
// CSV audiences are counted from the payload without touching the DB.
// ============================================================

import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { resolveAudience } from "@/lib/broadcasts/server";
import type { AudienceConfig } from "@/lib/broadcasts/types";

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("agent");
    const body = (await request.json().catch(() => null)) as
      | { audience?: AudienceConfig }
      | null;

    const audience = body?.audience;
    if (!audience || typeof audience !== "object" || !audience.type) {
      return NextResponse.json({ count: 0 });
    }

    // CSV rows aren't DB-backed until send time — count them directly.
    if (audience.type === "csv") {
      return NextResponse.json({ count: audience.csvContacts?.length ?? 0 });
    }

    const contacts = await resolveAudience(
      ctx.supabase,
      ctx.accountId,
      ctx.userId,
      audience,
    );
    return NextResponse.json({ count: contacts.length });
  } catch (err) {
    return toErrorResponse(err);
  }
}
