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
import type {
  Contact,
  ContactNote,
  CustomField,
  Deal,
  Tag,
} from "@/types";

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

export interface ContactDetail {
  contact: Contact | null;
  tagIds: string[];
  notes: ContactNote[];
  customFields: CustomField[];
  customValues: Record<string, string>;
  deals: Deal[];
}

/**
 * One consolidated, account-scoped read for the contact detail sheet: the
 * contact itself, its tag ids, notes, the account's custom fields plus this
 * contact's values, and its deals (with the stage object joined in). Returns
 * `contact: null` when the id doesn't belong to the account.
 */
export async function getContactDetail(
  accountId: string,
  contactId: string,
): Promise<ContactDetail> {
  const contactRows = await query<Contact>(
    `SELECT * FROM contacts WHERE id = $1 AND account_id = $2`,
    [contactId, accountId],
  );
  const contact = contactRows[0] ?? null;
  if (!contact) {
    return {
      contact: null,
      tagIds: [],
      notes: [],
      customFields: [],
      customValues: {},
      deals: [],
    };
  }

  const [tagRows, notes, customFields, valueRows, deals] = await Promise.all([
    query<{ tag_id: string }>(
      `SELECT tag_id FROM contact_tags WHERE contact_id = $1`,
      [contactId],
    ),
    query<ContactNote>(
      `SELECT * FROM contact_notes
        WHERE contact_id = $1 AND account_id = $2
        ORDER BY created_at DESC`,
      [contactId, accountId],
    ),
    query<CustomField>(
      `SELECT * FROM custom_fields WHERE account_id = $1 ORDER BY field_name`,
      [accountId],
    ),
    // contact_custom_values has no account_id — scope via the contact join.
    query<{ custom_field_id: string; value: string | null }>(
      `SELECT ccv.custom_field_id, ccv.value
         FROM contact_custom_values ccv
         JOIN contacts c ON c.id = ccv.contact_id
        WHERE ccv.contact_id = $1 AND c.account_id = $2`,
      [contactId, accountId],
    ),
    query<Deal>(
      `SELECT d.*, to_jsonb(s.*) AS stage
         FROM deals d
         LEFT JOIN pipeline_stages s ON s.id = d.stage_id
        WHERE d.contact_id = $1 AND d.account_id = $2
        ORDER BY d.created_at DESC`,
      [contactId, accountId],
    ),
  ]);

  const customValues: Record<string, string> = {};
  for (const v of valueRows) customValues[v.custom_field_id] = v.value ?? "";

  return {
    contact,
    tagIds: tagRows.map((r) => r.tag_id),
    notes,
    customFields,
    customValues,
    deals,
  };
}

/** Add a note to a contact, scoped to the account. Returns the new row. */
export async function addContactNote(
  accountId: string,
  userId: string,
  contactId: string,
  noteText: string,
): Promise<ContactNote | null> {
  // Guard: only insert when the contact belongs to the account.
  const rows = await query<ContactNote>(
    `INSERT INTO contact_notes (contact_id, account_id, user_id, note_text)
     SELECT $1, $2, $3, $4
      WHERE EXISTS (SELECT 1 FROM contacts WHERE id = $1 AND account_id = $2)
     RETURNING *`,
    [contactId, accountId, userId, noteText],
  );
  return rows[0] ?? null;
}

/** Delete a note, scoped to the account. Returns true if a row was removed. */
export async function deleteContactNote(
  accountId: string,
  noteId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM contact_notes
      WHERE id = $1 AND account_id = $2
      RETURNING id`,
    [noteId, accountId],
  );
  return rows.length > 0;
}

/**
 * Replace all custom-field values for a contact (delete-then-insert), scoped
 * to the account via the contact. `values` maps custom_field_id → value; empty
 * values are dropped by the caller.
 */
export async function replaceContactCustomValues(
  accountId: string,
  contactId: string,
  values: { fieldId: string; value: string }[],
): Promise<void> {
  // Verify ownership up front so we never touch another account's rows.
  const owned = await query<{ id: string }>(
    `SELECT id FROM contacts WHERE id = $1 AND account_id = $2`,
    [contactId, accountId],
  );
  if (owned.length === 0) return;

  await query(
    `DELETE FROM contact_custom_values WHERE contact_id = $1`,
    [contactId],
  );
  for (const { fieldId, value } of values) {
    await query(
      `INSERT INTO contact_custom_values (contact_id, custom_field_id, value)
       VALUES ($1, $2, $3)`,
      [contactId, fieldId, value],
    );
  }
}
