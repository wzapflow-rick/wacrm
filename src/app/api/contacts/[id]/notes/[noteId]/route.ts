// ============================================================
// DELETE /api/contacts/[id]/notes/[noteId] — remove a note (agent+).
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { deleteContactNote } from "@/lib/contacts/queries";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; noteId: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { noteId } = await params;
    const ok = await deleteContactNote(ctx.accountId, noteId);
    if (!ok) {
      return NextResponse.json({ error: "Note not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
