// ============================================================
// /api/account
//
//   GET   — current caller's account + role. Any member.
//   PATCH — rename the account.                  Admin+.
//
// Why both verbs share a route file
//   They speak about the same singular resource (the caller's
//   account) and reuse the same `requireRole` plumbing. Splitting
//   them across files would duplicate the `account_id` lookup
//   without buying anything.
// ============================================================

import { NextResponse } from "next/server";

import {
  requireRole,
  getCurrentAccount,
  toErrorResponse,
} from "@/lib/auth/account";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json({
      account: ctx.account,
      role: ctx.role,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

const MAX_NAME_LEN = 80;

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole("admin");

    // Per-user limit on admin-class mutations. Bounds accidental
    // abuse (script run in a loop) and a compromised admin session
    // spamming renames. Each admin endpoint keys its own bucket so
    // one route doesn't starve another.
    const limit = checkRateLimit(
      `admin:rename:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; default_currency?: unknown }
      | null;

    // Build the update from whatever recognized fields are present. Both are
    // optional, but at least one must be provided.
    const updates: { name?: string; default_currency?: string } = {};

    if (body?.name !== undefined) {
      if (typeof body.name !== "string") {
        return NextResponse.json(
          { error: "'name' must be a string" },
          { status: 400 },
        );
      }
      const name = body.name.trim();
      if (name.length === 0) {
        return NextResponse.json(
          { error: "Account name cannot be empty" },
          { status: 400 },
        );
      }
      if (name.length > MAX_NAME_LEN) {
        return NextResponse.json(
          { error: `Account name must be ${MAX_NAME_LEN} characters or fewer` },
          { status: 400 },
        );
      }
      updates.name = name;
    }

    if (body?.default_currency !== undefined) {
      // ISO 4217 codes are 3 uppercase letters.
      if (
        typeof body.default_currency !== "string" ||
        !/^[A-Z]{3}$/.test(body.default_currency)
      ) {
        return NextResponse.json(
          { error: "'default_currency' must be a 3-letter ISO code" },
          { status: 400 },
        );
      }
      updates.default_currency = body.default_currency;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No recognized fields to update" },
        { status: 400 },
      );
    }

    // No RLS anymore: scope the UPDATE to the caller's account explicitly.
    // requireRole('admin') already guaranteed the caller is admin+ for this
    // account, and .eq('id', ctx.accountId) is what confines the write.
    const { data, error } = await ctx.supabase
      .from("accounts")
      .update(updates)
      .eq("id", ctx.accountId)
      .select("id, name, default_currency")
      .single();

    if (error) {
      console.error("[PATCH /api/account] update error:", error);
      return NextResponse.json(
        { error: "Failed to update account" },
        { status: 500 },
      );
    }

    return NextResponse.json({ account: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
