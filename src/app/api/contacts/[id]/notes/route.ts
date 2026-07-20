// ============================================================
// POST /api/contacts/[id]/notes — add a note to a contact (agent+).
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { addContactNote } from "@/lib/contacts/queries";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as {
      note_text?: unknown;
    } | null;

    const noteText =
      typeof body?.note_text === "string" ? body.note_text.trim() : "";
    if (!noteText) {
      return NextResponse.json(
        { error: "note_text is required" },
        { status: 400 },
      );
    }

    const note = await addContactNote(
      ctx.accountId,
      ctx.userId,
      contactId,
      noteText,
    );
    if (!note) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return NextResponse.json({ note }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
