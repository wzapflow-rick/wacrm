// ============================================================
// PUT /api/contacts/[id]/custom-values — replace all custom field values
// for a contact (agent+). Account-scoped via the contact.
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { replaceContactCustomValues } from "@/lib/contacts/queries";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as {
      values?: Record<string, string>;
    } | null;

    const raw = body?.values ?? {};
    // Keep only non-empty trimmed values; drop the rest.
    const values = Object.entries(raw)
      .map(([fieldId, value]) => ({
        fieldId,
        value: typeof value === "string" ? value.trim() : "",
      }))
      .filter((v) => v.value.length > 0);

    await replaceContactCustomValues(ctx.accountId, contactId, values);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
