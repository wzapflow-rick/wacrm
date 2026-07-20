// ============================================================
// GET  /api/contacts  — list contacts (search + tag filter + pagination)
// DELETE /api/contacts?ids=a,b,c — bulk delete
//
// Listing is available to any account member (viewers included). Deletion
// requires the 'agent' role or higher. All queries are account-scoped in the
// data-access helpers.
// ============================================================
import { NextResponse, type NextRequest } from "next/server";

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  listContacts,
  deleteContacts,
  createContact,
  findDuplicateContact,
} from "@/lib/contacts/queries";
import { isUniqueViolation } from "@/lib/contacts/dedupe";

export async function GET(request: NextRequest) {
  try {
    const ctx = await getCurrentAccount();
    const sp = request.nextUrl.searchParams;

    const page = Math.max(0, Number(sp.get("page") ?? "0") || 0);
    const pageSize = Math.min(
      100,
      Math.max(1, Number(sp.get("pageSize") ?? "25") || 25),
    );
    const search = sp.get("search");
    const tagIdsRaw = sp.get("tagIds");
    const tagIds = tagIdsRaw
      ? tagIdsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    const { contacts, totalCount } = await listContacts({
      accountId: ctx.accountId,
      search,
      tagIds,
      limit: pageSize,
      offset: page * pageSize,
    });

    return NextResponse.json({ contacts, totalCount });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const ctx = await requireRole("agent");
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
      const created = await createContact(ctx.accountId, ctx.userId, fields);
      return NextResponse.json({ contact: created }, { status: 201 });
    } catch (err) {
      // DB unique index (per-account phone) rejected a duplicate. Return 409
      // plus the existing contact so the client can point the user at it.
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

export async function DELETE(request: NextRequest) {
  try {
    const ctx = await requireRole("agent");
    const idsRaw = request.nextUrl.searchParams.get("ids");
    const ids = idsRaw
      ? idsRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { error: "No contact ids provided" },
        { status: 400 },
      );
    }

    const deleted = await deleteContacts(ctx.accountId, ids);
    return NextResponse.json({ deleted });
  } catch (err) {
    return toErrorResponse(err);
  }
}
