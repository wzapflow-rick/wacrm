// ============================================================
// GET /api/contacts/check-duplicate?phone=...
//
// Returns the existing contact (if any) whose phone matches, for the
// contact-form's on-blur duplicate hint. Account-scoped.
// ============================================================
import { NextResponse, type NextRequest } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { findDuplicateContact } from "@/lib/contacts/queries";

export async function GET(request: NextRequest) {
  try {
    const ctx = await getCurrentAccount();
    const phone = request.nextUrl.searchParams.get("phone")?.trim() ?? "";
    if (!phone) {
      return NextResponse.json({ existing: null });
    }
    const existing = await findDuplicateContact(ctx.accountId, phone);
    return NextResponse.json({ existing });
  } catch (err) {
    return toErrorResponse(err);
  }
}
