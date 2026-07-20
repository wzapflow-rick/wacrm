// ============================================================
// GET   /api/contacts/[id] — consolidated detail read (agent+).
// PATCH /api/contacts/[id] — update a contact (agent+). Account-scoped.
// ============================================================
import { NextResponse } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import {
  updateContact,
  findDuplicateContact,
  getContactDetail,
} from "@/lib/contacts/queries";
import { isUniqueViolation } from "@/lib/contacts/dedupe";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const detail = await getContactDetail(ctx.accountId, id);
    if (!detail.contact) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole("agent");
    const { id } = await params;
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      phone?: unknown;
      email?: unknown;
      company?: unknown;
    } | null;

    const phone = typeof body?.phone === "string" ? body.phone.trim() : "";
    if (!phone) {
      return NextResponse.json({ error: "phone is required" }, { status: 400 });
    }

    const fields = {
      name: typeof body?.name === "string" ? body.name.trim() || null : null,
      phone,
      email: typeof body?.email === "string" ? body.email.trim() || null : null,
      company:
        typeof body?.company === "string" ? body.company.trim() || null : null,
    };

    try {
      const ok = await updateContact(ctx.accountId, id, fields);
      if (!ok) {
        return NextResponse.json(
          { error: "Contact not found" },
          { status: 404 },
        );
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const existing = await findDuplicateContact(ctx.accountId, phone);
        return NextResponse.json(
          { error: "duplicate", existing },
          { status: 409 },
        );
      }
      throw err;
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
