// ============================================================
// Contacts data-access helpers (server-only).
//
// These run raw, parameterized SQL through the shared pg pool and are ALWAYS
// scoped by account_id. There is no RLS anymore, so account isolation lives
// here — every query takes an explicit accountId and filters on it.
// ============================================================
import { query } from "@/lib/db/pool";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";
import type { ExistingContact } from "@/lib/contacts/dedupe";
import type { Contact, Tag } from "@/types";

export interface ContactWriteFields {
  name?: string | null;
  phone: string;
  email?: string | null;
  company?: string | null;
}

export interface ContactWithTags extends Contact {
  tags: Tag[];
}

export interface ListContactsParams {
  accountId: string;
  search?: string | null;
  tagIds?: string[];
  limit: number;
  offset: number;
}

export interface ListContactsResult {
  contacts: ContactWithTags[];
  totalCount: number;
}

/**
 * List contacts for an account with optional full-text-ish search and an
 * ANY-of tag filter, paginated. Replaces the old `filter_contacts_by_tags`
 * RPC (which relied on RLS for isolation) with an explicit account-scoped
 * query. Tag enrichment is a second round trip over the returned ids.
 */
export async function listContacts(
  params: ListContactsParams,
): Promise<ListContactsResult> {
  const { accountId, search, tagIds, limit, offset } = params;
  const term = search && search.trim() ? `%${search.trim()}%` : null;

  const conditions: string[] = ["c.account_id = $1"];
  const values: unknown[] = [accountId];
  let p = 2;

  if (term) {
    conditions.push(
      `(c.name ILIKE $${p} OR c.phone ILIKE $${p} OR c.email ILIKE $${p})`,
    );
    values.push(term);
    p++;
  }

  if (tagIds && tagIds.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.id AND ct.tag_id::text = ANY($${p}::text[]))`,
    );
    values.push(tagIds);
    p++;
  }

  const limitP = p;
  values.push(limit);
  p++;
  const offsetP = p;
  values.push(offset);

  // count(*) OVER() gives the windowed total alongside the page so we avoid a
  // separate COUNT query.
  const rows = await query<Contact & { total_count: string }>(
    `SELECT c.*, count(*) OVER() AS total_count
       FROM contacts c
      WHERE ${conditions.join(" AND ")}
      ORDER BY c.created_at DESC
      LIMIT $${limitP} OFFSET $${offsetP}`,
    values,
  );

  const totalCount = rows.length > 0 ? Number(rows[0].total_count) : 0;
  const contacts: ContactWithTags[] = rows.map((row) => {
    const { total_count: _drop, ...contact } = row;
    return { ...(contact as Contact), tags: [] };
  });

  if (contacts.length === 0) return { contacts: [], totalCount };

  // Enrich with tags. The contact ids are already account-scoped above, so
  // the join can't pull in another account's rows.
  const ids = contacts.map((c) => c.id);
  const tagRows = await query<{ contact_id: string } & Tag>(
    `SELECT ct.contact_id, t.*
       FROM contact_tags ct
       JOIN tags t ON t.id = ct.tag_id
      WHERE ct.contact_id::text = ANY($1::text[])`,
    [ids],
  );

  const byContact = new Map<string, Tag[]>();
  for (const row of tagRows) {
    const { contact_id, ...tag } = row;
    const list = byContact.get(contact_id) ?? [];
    list.push(tag as Tag);
    byContact.set(contact_id, list);
  }

  for (const contact of contacts) {
    contact.tags = byContact.get(contact.id) ?? [];
  }

  return { contacts, totalCount };
}

/**
 * Delete one or more contacts by id, scoped to the account. Uses RETURNING so
 * the number of returned rows is the number actually deleted (rows belonging
 * to another account simply don't match and aren't returned).
 */
export async function deleteContacts(
  accountId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await query<{ id: string }>(
    `DELETE FROM contacts
      WHERE account_id = $1 AND id::text = ANY($2::text[])
      RETURNING id`,
    [accountId, ids],
  );
  return deleted.length;
}

/**
 * Find an existing contact in the account whose phone matches (fuzzy,
 * trunk-tolerant). Pre-filters by the last-8-digit suffix in SQL, then applies
 * the strict `phonesMatch` in JS on the small candidate set. Mirrors the
 * browser-side dedupe that used to run against Supabase directly.
 */
export async function findDuplicateContact(
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  const rows = await query<ExistingContact>(
    `SELECT * FROM contacts WHERE account_id = $1 AND phone LIKE $2`,
    [accountId, `%${suffix}`],
  );
  return rows.find((c) => phonesMatch(c.phone, phone)) ?? null;
}

/** Insert a contact. Relies on the DB unique index to reject dup phones. */
export async function createContact(
  accountId: string,
  userId: string,
  fields: ContactWriteFields,
): Promise<{ id: string }> {
  const row = await query<{ id: string }>(
    `INSERT INTO contacts (user_id, account_id, name, phone, email, company)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      userId,
      accountId,
      fields.name ?? null,
      fields.phone,
      fields.email ?? null,
      fields.company ?? null,
    ],
  );
  return row[0];
}

/** Update a contact, scoped to the account. Returns true if a row changed. */
export async function updateContact(
  accountId: string,
  id: string,
  fields: ContactWriteFields,
): Promise<boolean> {
  const updated = await query<{ id: string }>(
    `UPDATE contacts
        SET name = $3, phone = $4, email = $5, company = $6, updated_at = now()
      WHERE id = $1 AND account_id = $2
      RETURNING id`,
    [
      id,
      accountId,
      fields.name ?? null,
      fields.phone,
      fields.email ?? null,
      fields.company ?? null,
    ],
  );
  return updated.length > 0;
}
