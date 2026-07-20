import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { auth } from "@/lib/auth/better-auth";
import { createDbClient } from "@/lib/db/client";
import { DEFAULT_CURRENCY } from "@/lib/currency";

// ============================================================
// GET /api/me — current user's profile + account summary.
// ============================================================
// Replaces the browser-side `supabase.from('profiles')` lookup the auth
// provider used to run under RLS. Here the query is scoped explicitly by the
// session user id (there is no RLS anymore). Returns 401 when signed out so
// the client can treat it as "logged out" without throwing.
export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });

  if (!session?.user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const db = createDbClient();
  const userId = session.user.id;

  const { data: profile, error } = await db
    .from("profiles")
    .select(
      "id, full_name, email, avatar_url, role, beta_features, account_id, account_role",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[api/me] profile error:", error.message);
    return NextResponse.json(
      { error: "Failed to load profile" },
      { status: 500 },
    );
  }

  let account: {
    id: string;
    name: string;
    default_currency: string;
  } | null = null;

  if (profile?.account_id) {
    // Plain lookup by id — scoped to the account the profile already
    // belongs to, so no cross-account leak.
    const { data: acc, error: accErr } = await db
      .from("accounts")
      .select("id, name, default_currency")
      .eq("id", profile.account_id)
      .maybeSingle();
    if (accErr) {
      console.error("[api/me] account error:", accErr.message);
    } else if (acc) {
      account = {
        id: acc.id,
        name: acc.name,
        default_currency: acc.default_currency ?? DEFAULT_CURRENCY,
      };
    }
  }

  return NextResponse.json({
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
    },
    profile: profile ?? null,
    account,
  });
}
