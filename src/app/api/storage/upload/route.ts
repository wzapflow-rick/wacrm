import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { createServerStorage } from "@/lib/storage/server";
import { buildMediaPath } from "@/lib/storage/upload-media";

// Buckets a browser client is allowed to write through this route. Anything
// else is rejected so the endpoint can't be used to write arbitrary buckets.
const ALLOWED_BUCKETS = new Set(["avatars", "chat-media", "flow-media"]);

/**
 * POST /api/storage/upload  (multipart/form-data: bucket, file)
 *
 * Server-side replacement for the old browser Supabase Storage upload. The
 * object path is account-scoped (`account-<id>/...`) so uploads from
 * different accounts never collide, and only the server holds MinIO creds.
 */
export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();

    const form = await request.formData();
    const bucket = form.get("bucket");
    const file = form.get("file");

    if (typeof bucket !== "string" || !ALLOWED_BUCKETS.has(bucket)) {
      return NextResponse.json({ error: "Invalid bucket" }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const path = buildMediaPath(ctx.accountId, file.name);
    const storage = createServerStorage();
    const bytes = new Uint8Array(await file.arrayBuffer());

    const { error } = await storage.from(bucket).upload(path, bytes, {
      cacheControl: "3600",
      upsert: false,
      contentType: file.type,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const {
      data: { publicUrl },
    } = storage.from(bucket).getPublicUrl(path);

    return NextResponse.json({ publicUrl, path });
  } catch (err) {
    return toErrorResponse(err);
  }
}
