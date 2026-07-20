import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { query } from "@/lib/db/pool";

/**
 * GET /api/automations/builder-data
 *
 * Consolidated reference data for the automation builder pickers: tags,
 * APPROVED templates, custom fields, and pipelines + their stages. Everything
 * is account-scoped server-side so teammates share the same catalog. Only
 * APPROVED templates are returned since anything else 400s at send time.
 */
export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();

    const [tags, templates, customFields, pipelines, stages] =
      await Promise.all([
        query(
          `SELECT * FROM tags WHERE account_id = $1 ORDER BY name`,
          [accountId],
        ),
        query(
          `SELECT * FROM message_templates
            WHERE account_id = $1 AND status = 'APPROVED'
            ORDER BY name`,
          [accountId],
        ),
        query(
          `SELECT * FROM custom_fields WHERE account_id = $1 ORDER BY field_name`,
          [accountId],
        ),
        query(
          `SELECT id, name FROM pipelines WHERE account_id = $1 ORDER BY name`,
          [accountId],
        ),
        // pipeline_stages has no account_id of its own — it's scoped through
        // its parent pipeline, so join to enforce the account boundary.
        query(
          `SELECT s.id, s.name, s.pipeline_id, s.position
             FROM pipeline_stages s
             JOIN pipelines p ON p.id = s.pipeline_id
            WHERE p.account_id = $1
            ORDER BY s.position`,
          [accountId],
        ),
      ]);

    return NextResponse.json({ tags, templates, customFields, pipelines, stages });
  } catch (err) {
    return toErrorResponse(err);
  }
}
