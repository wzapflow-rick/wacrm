import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import {
  ContactTagWriteError,
  removeContactTag,
} from '@/lib/contacts/tag-write';
import { query } from '@/lib/db/pool';

function tagWriteErrorResponse(error: ContactTagWriteError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: error.status });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id: contactId } = await params;

    // Join through contacts to enforce the account scope: a contact id from
    // another account returns zero rows rather than leaking its tag links.
    const rows = await query<{ id: string; contact_id: string; tag_id: string }>(
      `SELECT ct.id, ct.contact_id, ct.tag_id
         FROM contact_tags ct
         JOIN contacts c ON c.id = ct.contact_id
        WHERE ct.contact_id = $1 AND c.account_id = $2`,
      [contactId, ctx.accountId]
    );

    return NextResponse.json({ contactTags: rows });
  } catch (err) {
    return toErrorResponse(err);
  }
}

async function readTagId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    tag_id?: unknown;
  } | null;
  return typeof body?.tag_id === 'string' && body.tag_id.trim()
    ? body.tag_id.trim()
    : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    const result = await addContactTagAndDispatch({
      db: ctx.supabase,
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const tagId = await readTagId(request);
    if (!tagId) {
      return NextResponse.json({ error: 'tag_id required' }, { status: 400 });
    }

    await removeContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}
