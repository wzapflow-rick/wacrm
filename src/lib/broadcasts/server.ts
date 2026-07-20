// ============================================================
// Dashboard broadcast orchestrator (server-side).
//
// Ports the old client hook (use-broadcast-sending) onto the pg pool:
//   createDashboardBroadcast() — resolve audience, persist the
//        `broadcasts` row + `broadcast_recipients`, and build a send
//        plan (per-recipient params + optional media header). Runs
//        inside the request.
//   deliverDashboardBroadcast() — fan out via Meta, stamp each
//        recipient row + finalize status. Pure/DB-only (no request
//        context) so it is safe to run in `after()` / background.
//
// Unlike broadcast-core (public API, explicit phone list), this covers
// audience resolution (all/tags/custom_field/csv), per-contact variable
// mapping, and media-header params — the dashboard wizard features.
//
// Counts (sent/delivered/read/replied/failed) are owned by the DB
// aggregate trigger (migrations 003/005); we only write terminal
// `status`, exactly like broadcast-core.
// ============================================================

import { createDbClient, type DbClient } from "@/lib/db/client";
import { sendTemplateMessage } from "@/lib/whatsapp/meta-api";
import { decrypt } from "@/lib/whatsapp/encryption";
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from "@/lib/whatsapp/phone-utils";
import { isMessageTemplate } from "@/lib/whatsapp/template-row-guard";
import type { SendTimeParams } from "@/lib/whatsapp/template-send-builder";
import type { Contact, MessageTemplate } from "@/types";
import {
  resolveVariables,
  type AudienceConfig,
  type CustomFieldFilter,
  type VariableMapping,
} from "./types";

export interface DashboardBroadcastInput {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /** Media URL for an IMAGE/VIDEO/DOCUMENT header. */
  headerMediaUrl?: string;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface DashboardBroadcastPlan {
  broadcastId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  messageParams?: SendTimeParams;
  planned: PlannedRecipient[];
}

export class DashboardBroadcastError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "DashboardBroadcastError";
    this.status = status;
  }
}

/** Meta rate-limit buffer: 10 sends per batch + 1s pause. */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------
// Audience resolution — all account-scoped.
// ------------------------------------------------------------

export async function resolveAudience(
  db: DbClient,
  accountId: string,
  userId: string,
  audience: AudienceConfig,
): Promise<Contact[]> {
  let contacts: Contact[] = [];

  if (audience.type === "all") {
    const { data, error } = await db
      .from("contacts")
      .select("*")
      .eq("account_id", accountId);
    if (error) throw new DashboardBroadcastError(`Failed to fetch contacts: ${error.message}`);
    contacts = (data as Contact[]) ?? [];
  } else if (
    audience.type === "tags" &&
    audience.tagIds &&
    audience.tagIds.length > 0
  ) {
    const { data: contactTags, error: tagError } = await db
      .from("contact_tags")
      .select("contact_id")
      .in("tag_id", audience.tagIds);
    if (tagError)
      throw new DashboardBroadcastError(`Failed to fetch contact tags: ${tagError.message}`);

    const uniqueContactIds = [
      ...new Set((contactTags ?? []).map((ct: { contact_id: string }) => ct.contact_id)),
    ];
    if (uniqueContactIds.length > 0) {
      const { data, error } = await db
        .from("contacts")
        .select("*")
        .eq("account_id", accountId)
        .in("id", uniqueContactIds);
      if (error) throw new DashboardBroadcastError(`Failed to fetch contacts: ${error.message}`);
      contacts = (data as Contact[]) ?? [];
    }
  } else if (audience.type === "custom_field" && audience.customField) {
    contacts = await resolveCustomFieldAudience(db, accountId, audience.customField);
  } else if (audience.type === "csv" && audience.csvContacts) {
    contacts = await upsertCsvContacts(db, accountId, userId, audience.csvContacts);
  }

  // Exclude tags apply to every contact-derived audience type. CSV
  // contacts are real rows post-upsert, so exclusion still applies.
  if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
    const { data: excludeRows } = await db
      .from("contact_tags")
      .select("contact_id")
      .in("tag_id", audience.excludeTagIds);
    const excludedIds = new Set(
      (excludeRows ?? []).map((r: { contact_id: string }) => r.contact_id),
    );
    contacts = contacts.filter((c) => !excludedIds.has(c.id));
  }

  return contacts;
}

async function resolveCustomFieldAudience(
  db: DbClient,
  accountId: string,
  filter: CustomFieldFilter,
): Promise<Contact[]> {
  const { fieldId, operator, value } = filter;

  let q = db
    .from("contact_custom_values")
    .select("contact_id")
    .eq("custom_field_id", fieldId);

  if (operator === "is") q = q.eq("value", value);
  else if (operator === "is_not") q = q.neq("value", value);
  else if (operator === "contains") q = q.ilike("value", `%${value}%`);

  const { data: matches, error: matchErr } = await q;
  if (matchErr)
    throw new DashboardBroadcastError(`Custom-field filter failed: ${matchErr.message}`);

  const contactIds = [
    ...new Set((matches ?? []).map((m: { contact_id: string }) => m.contact_id)),
  ];
  if (contactIds.length === 0) return [];

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .in("id", contactIds);
  if (error) throw new DashboardBroadcastError(`Failed to fetch contacts: ${error.message}`);
  return (data as Contact[]) ?? [];
}

/**
 * CSV uploads arrive as raw phone/name pairs. Resolve each to a real
 * contacts row (looking up by phone within the account, inserting the
 * missing ones) so broadcast_recipients.contact_id has a valid FK.
 * Scoped by account_id — post multi-user, a teammate's CSV must reuse
 * the account's existing contacts, not only the caller's.
 */
async function upsertCsvContacts(
  db: DbClient,
  accountId: string,
  userId: string,
  csvRows: { phone: string; name?: string }[],
): Promise<Contact[]> {
  if (csvRows.length === 0) return [];

  const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
  for (const row of csvRows) {
    if (row.phone) uniqueByPhone.set(row.phone, row);
  }
  const phones = [...uniqueByPhone.keys()];

  const { data: existing, error: lookupErr } = await db
    .from("contacts")
    .select("*")
    .eq("account_id", accountId)
    .in("phone", phones);
  if (lookupErr) {
    throw new DashboardBroadcastError(`Failed to look up CSV contacts: ${lookupErr.message}`);
  }

  const byPhone = new Map<string, Contact>();
  for (const c of ((existing as Contact[]) ?? [])) {
    if (c.phone) byPhone.set(c.phone, c);
  }

  const missing = phones
    .filter((p) => !byPhone.has(p))
    .map((phone) => ({
      user_id: userId,
      account_id: accountId,
      phone,
      name: uniqueByPhone.get(phone)?.name ?? null,
    }));

  const INSERT_CHUNK = 200;
  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const chunk = missing.slice(i, i + INSERT_CHUNK);
    const { data: inserted, error: insertErr } = await db
      .from("contacts")
      .insert(chunk)
      .select();
    if (insertErr) {
      throw new DashboardBroadcastError(`Failed to create CSV contacts: ${insertErr.message}`);
    }
    for (const c of ((inserted as Contact[]) ?? [])) {
      if (c.phone) byPhone.set(c.phone, c);
    }
  }

  return phones
    .map((p) => byPhone.get(p))
    .filter((c): c is Contact => Boolean(c));
}

async function fetchCustomValueIndex(
  db: DbClient,
  contactIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const index = new Map<string, Map<string, string>>();
  if (contactIds.length === 0) return index;

  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await db
      .from("contact_custom_values")
      .select("contact_id, custom_field_id, value")
      .in("contact_id", slice);

    for (const row of (data ?? []) as {
      contact_id: string;
      custom_field_id: string;
      value: string | null;
    }[]) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? "");
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

// ------------------------------------------------------------
// Create phase (runs in request).
// ------------------------------------------------------------

export async function createDashboardBroadcast(
  db: DbClient,
  accountId: string,
  userId: string,
  input: DashboardBroadcastInput,
): Promise<DashboardBroadcastPlan> {
  const { name, template, audience, variables } = input;

  if (!template?.name) {
    throw new DashboardBroadcastError("A template is required");
  }

  const contacts = await resolveAudience(db, accountId, userId, audience);
  if (contacts.length === 0) {
    throw new DashboardBroadcastError("No contacts found for this audience.");
  }

  // Config + token for the Meta send.
  const { data: config, error: configError } = await db
    .from("whatsapp_config")
    .select("*")
    .eq("account_id", accountId)
    .single();
  if (configError || !config) {
    throw new DashboardBroadcastError(
      "WhatsApp not configured. Please set up your WhatsApp integration first.",
    );
  }
  const accessToken = decrypt(config.access_token);

  const templateLanguage = template.language ?? "en_US";
  const { data: rawTemplateRow } = await db
    .from("message_templates")
    .select("*")
    .eq("account_id", accountId)
    .eq("name", template.name)
    .eq("language", templateLanguage)
    .maybeSingle();
  if (rawTemplateRow && !isMessageTemplate(rawTemplateRow)) {
    throw new DashboardBroadcastError(
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500,
    );
  }
  const templateRow = (rawTemplateRow as MessageTemplate | null) ?? null;

  // Persist the broadcast. Counts are trigger-owned — do not seed them.
  const { data: broadcast, error: broadcastError } = await db
    .from("broadcasts")
    .insert({
      user_id: userId,
      account_id: accountId,
      name,
      template_name: template.name,
      template_language: templateLanguage,
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
        customField: audience.customField,
        excludeTagIds: audience.excludeTagIds,
      },
      status: "sending",
      total_recipients: contacts.length,
    })
    .select("id")
    .single();
  if (broadcastError || !broadcast) {
    throw new DashboardBroadcastError(
      `Failed to create broadcast: ${broadcastError?.message ?? "unknown error"}`,
      500,
    );
  }

  // Insert recipient rows in batches, keyed back to their contact.
  const INSERT_BATCH_SIZE = 200;
  const recipientRowIdByContact = new Map<string, string>();
  for (let i = 0; i < contacts.length; i += INSERT_BATCH_SIZE) {
    const batch = contacts.slice(i, i + INSERT_BATCH_SIZE);
    const { data: inserted, error: recipientError } = await db
      .from("broadcast_recipients")
      .insert(
        batch.map((c) => ({
          broadcast_id: broadcast.id,
          contact_id: c.id,
          status: "pending" as const,
        })),
      )
      .select("id, contact_id");
    if (recipientError || !inserted) {
      // Abort loudly: an incomplete recipient set drifts the aggregate
      // counts and orphans webhook status updates.
      await db
        .from("broadcasts")
        .update({ status: "failed" })
        .eq("id", broadcast.id);
      throw new DashboardBroadcastError(
        `Failed to insert recipient batch: ${recipientError?.message ?? "unknown error"}`,
        500,
      );
    }
    for (const row of inserted as { id: string; contact_id: string }[]) {
      recipientRowIdByContact.set(row.contact_id, row.id);
    }
  }

  // Preload custom values once for per-contact variable resolution.
  const customValueIndex = await fetchCustomValueIndex(
    db,
    contacts.map((c) => c.id),
  );

  // Media-header templates need a media URL on every send.
  const headerType = template.header_type;
  const isMediaHeader =
    headerType === "image" || headerType === "video" || headerType === "document";
  const headerMediaUrl = input.headerMediaUrl?.trim();
  const messageParams: SendTimeParams | undefined =
    isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

  const planned: PlannedRecipient[] = [];
  for (const contact of contacts) {
    if (!contact.phone) continue;
    const recipientRowId = recipientRowIdByContact.get(contact.id);
    if (!recipientRowId) continue;
    planned.push({
      recipientRowId,
      phone: contact.phone,
      params: resolveVariables(variables, contact, customValueIndex.get(contact.id)),
    });
  }

  return {
    broadcastId: broadcast.id,
    templateName: template.name,
    templateLanguage,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    messageParams,
    planned,
  };
}

// ------------------------------------------------------------
// Deliver phase (safe to run in after() / background).
// ------------------------------------------------------------

export async function deliverDashboardBroadcast(
  plan: DashboardBroadcastPlan,
): Promise<void> {
  // Fresh, request-independent client so this works after the response
  // has flushed (no next/headers access).
  const db = createDbClient();
  let sentCount = 0;
  const total = plan.planned.length;

  for (let i = 0; i < plan.planned.length; i += SEND_BATCH_SIZE) {
    const batch = plan.planned.slice(i, i + SEND_BATCH_SIZE);

    for (const recipient of batch) {
      const variants = phoneVariants(sanitizePhoneForMeta(recipient.phone));
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      if (!isValidE164(sanitizePhoneForMeta(recipient.phone))) {
        lastError = "Invalid phone number format";
      } else {
        for (const variant of variants) {
          try {
            const result = await sendTemplateMessage({
              phoneNumberId: plan.phoneNumberId,
              accessToken: plan.accessToken,
              to: variant,
              templateName: plan.templateName,
              language: plan.templateLanguage,
              template: plan.templateRow ?? undefined,
              messageParams: plan.messageParams,
              params: recipient.params,
            });
            sentMessageId = result.messageId;
            lastError = null;
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            lastError = message;
            if (!isRecipientNotAllowedError(message)) break;
          }
        }
      }

      if (sentMessageId) {
        sentCount++;
        await db
          .from("broadcast_recipients")
          .update({
            status: "sent",
            sent_at: new Date().toISOString(),
            whatsapp_message_id: sentMessageId,
            error_message: null,
          })
          .eq("id", recipient.recipientRowId);
      } else {
        await db
          .from("broadcast_recipients")
          .update({
            status: "failed",
            error_message: lastError || "Unknown error",
          })
          .eq("id", recipient.recipientRowId);
      }
    }

    if (i + SEND_BATCH_SIZE < plan.planned.length) {
      await sleep(SEND_BATCH_DELAY_MS);
    }
  }

  await db
    .from("broadcasts")
    .update({
      status: sentCount > 0 || total === 0 ? "sent" : "failed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", plan.broadcastId);
}
