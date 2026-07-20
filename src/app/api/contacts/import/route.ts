import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  dedupeByPhone,
  isUniqueViolation,
  normalizeKey,
} from '@/lib/contacts/dedupe';
import type { ParsedContactRow } from '@/lib/contacts/parse-contact-csv';
import {
  assignImportedContactTags,
  resolveImportTagIds,
  type ContactTagAssignment,
} from '@/lib/contacts/resolve-import-tags';
import { hasMinRole } from '@/lib/auth/roles';

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  tagsAssigned: number;
  skippedTagNames: string[];
}

/**
 * Bulk contact import. The browser parses the CSV (cheap, no data access) and
 * POSTs the parsed rows here; all the account-scoped work — in-file de-dupe,
 * skipping numbers already in the account, resolving/creating tags, chunked
 * inserts, and tag assignment — runs server-side against Postgres.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const body = (await request.json().catch(() => null)) as {
      rows?: ParsedContactRow[];
    } | null;

    const parsedRows = Array.isArray(body?.rows) ? body.rows : [];
    if (parsedRows.length === 0) {
      return NextResponse.json(
        { error: 'No rows to import' },
        { status: 400 },
      );
    }

    const { accountId, userId, role } = ctx;
    // Admin+ may auto-create tags the CSV references but the account lacks.
    const canCreateTags = hasMinRole(role, 'admin');

    let imported = 0;
    let skipped = 0;
    let failed = 0;

    // 1) De-dupe within the file by normalized phone (keep first).
    const { unique, duplicates: inFileDupes } = dedupeByPhone(parsedRows);
    skipped += inFileDupes;

    // 2) Skip numbers already in this account. One read of the generated
    //    `phone_normalized` column → Set.
    const { data: existingRows } = await ctx.supabase
      .from('contacts')
      .select('phone_normalized')
      .eq('account_id', accountId);
    const existing = new Set(
      ((existingRows ?? []) as { phone_normalized: string | null }[])
        .map((r) => r.phone_normalized)
        .filter((p): p is string => !!p),
    );

    const toInsert = unique.filter((row) => {
      if (existing.has(normalizeKey(row.phone))) {
        skipped++;
        return false;
      }
      return true;
    });

    // 3) Resolve tag names → ids (admin+ may auto-create missing tags).
    const allTagNames = toInsert.flatMap((row) => row.tagNames);
    let tagIdByKey = new Map<string, string>();
    let skippedNames: string[] = [];
    if (allTagNames.length > 0) {
      ({ tagIdByKey, skippedNames } = await resolveImportTagIds(ctx.supabase, {
        accountId,
        userId,
        tagNames: allTagNames,
        canCreateTags,
      }));
    }

    const tagAssignments: ContactTagAssignment[] = [];

    // 4) Batch insert new rows in chunks of 50. The DB unique index is the
    //    backstop: a 23505 (race / normalizes-equal) counts as skipped.
    const chunkSize = 50;
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      const rows = chunk.map((row) => ({
        user_id: userId,
        account_id: accountId,
        phone: row.phone,
        name: row.name || null,
        email: row.email || null,
        company: row.company || null,
      }));

      const { data, error } = await ctx.supabase
        .from('contacts')
        .insert(rows)
        .select('id');

      if (error) {
        // Retry individually so one bad/duplicate row doesn't sink the chunk.
        for (let j = 0; j < rows.length; j++) {
          const source = chunk[j];
          const { data: singleData, error: singleErr } = await ctx.supabase
            .from('contacts')
            .insert(rows[j])
            .select('id')
            .single();

          if (!singleErr && singleData) {
            imported++;
            if (source.tagNames.length > 0) {
              tagAssignments.push({
                contactId: singleData.id,
                tagNames: source.tagNames,
              });
            }
          } else if (isUniqueViolation(singleErr)) {
            skipped++;
          } else {
            failed++;
          }
        }
      } else {
        const inserted = data ?? [];
        imported += inserted.length;
        // inserted[j] ↔ chunk[j] holds because a single INSERT preserves
        // RETURNING order.
        for (let j = 0; j < inserted.length; j++) {
          const source = chunk[j];
          if (!source || source.tagNames.length === 0) continue;
          tagAssignments.push({
            contactId: inserted[j].id,
            tagNames: source.tagNames,
          });
        }
      }
    }

    // 5) Wire tags onto the new contacts. Failure here must not mask a
    //    successful contact import.
    let tagsAssigned = 0;
    let tagsWarning = false;
    try {
      tagsAssigned = await assignImportedContactTags(
        ctx.supabase,
        tagAssignments,
        tagIdByKey,
      );
    } catch {
      tagsWarning = true;
    }

    const result: ImportResult & { tagsWarning: boolean } = {
      imported,
      skipped,
      failed,
      tagsAssigned,
      skippedTagNames: skippedNames,
      tagsWarning,
    };
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
