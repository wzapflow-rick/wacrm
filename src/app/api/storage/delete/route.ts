import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { createServerStorage } from "@/lib/storage/server";

const ALLOWED_BUCKETS = new Set(["avatars", "chat-media", "flow-media"]);

/**
 * POST /api/storage/delete  { bucket, path }
 *
 * GC a previously-uploaded object (cancelled draft / failed send). The path
 * must live under the caller's own account folder — enforced by matching the
 * `account-<accountId>/` prefix — so one account can't delete another's media.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      bucket?: string;
      path?: string;
    } | null;

    if (
      !body ||
      typeof body.bucket !== "string" ||
      !ALLOWED_BUCKETS.has(body.bucket) ||
      typeof body.path !== "string"
    ) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    if (!body.path.startsWith(`account-${ctx.accountId}/`)) {
      return NextResponse.json({ error: "Forbidden path" }, { status: 403 });
    }

    const storage = createServerStorage();
    const { error } = await storage.from(body.bucket).remove([body.path]);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
