import "server-only";

import {
  newsletterAudienceInputSchema,
  type NewsletterAudienceInput,
  type NewsletterAudienceUpdateInput,
  type NewsletterAudienceView,
} from "@/lib/domain/content-studio";
import {
  newsletterContactCreateSchema,
  newsletterContactInputSchema,
  newsletterContactStatusSchema,
  type NewsletterAudienceDeliverySummary,
  type NewsletterContactCreateInput,
  type NewsletterContactInput,
  type NewsletterContactStatus,
  type NewsletterContactUpdateInput,
  type NewsletterContactView,
} from "@/lib/domain/newsletter-delivery";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type JsonObject = Record<string, unknown>;

type AudienceRow = {
  id: string;
  created_by_user_id: string;
  name: string;
  description: string;
  sender_name: string | null;
  sender_email: string | null;
  reply_to_email: string | null;
  audience_metadata: unknown;
  active: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

type ContactRow = {
  id: string;
  audience_id: string;
  email: string;
  display_name: string | null;
  status: string;
  consent_source: string;
  consented_at: string | Date | null;
  unsubscribed_at: string | Date | null;
  suppression_reason: string | null;
  contact_metadata: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

type AudienceSummaryRow = {
  id: string;
  name: string;
  active: boolean;
  contact_count: number | string;
  subscribed_count: number | string;
  unsubscribed_count: number | string;
  suppressed_count: number | string;
};

type AudienceWrite = {
  name: string;
  description: string;
  senderName: string | null;
  senderEmail: string | null;
  replyToEmail: string | null;
  audienceMetadataJson: string;
  active: boolean;
};

type ContactWrite = {
  email: string;
  displayName: string | null;
  status: NewsletterContactStatus;
  consentSource: string;
  consentedAt: string | null;
  unsubscribedAt: string | null;
  suppressionReason: string | null;
  contactMetadataJson: string;
};

export class NewsletterAudienceAccessError extends Error {
  constructor() {
    super("Du har bara läsrättighet i den här arbetsytan.");
    this.name = "NewsletterAudienceAccessError";
  }
}

export class NewsletterAudienceNotFoundError extends Error {
  constructor() {
    super("Mottagarlistan hittades inte i arbetsytan.");
    this.name = "NewsletterAudienceNotFoundError";
  }
}

export class NewsletterAudienceInUseError extends Error {
  constructor() {
    super("Mottagarlistan används av ett utkast eller en automation. Gör den inaktiv i stället.");
    this.name = "NewsletterAudienceInUseError";
  }
}

export class NewsletterContactNotFoundError extends Error {
  constructor() {
    super("Mottagaren hittades inte i arbetsytan.");
    this.name = "NewsletterContactNotFoundError";
  }
}

export class NewsletterContactConflictError extends Error {
  constructor() {
    super("Adressen finns redan i den här mottagarlistan.");
    this.name = "NewsletterContactConflictError";
  }
}

export class NewsletterConsentError extends Error {
  constructor(message = "Ange när personen tackade ja innan den kan prenumerera.") {
    super(message);
    this.name = "NewsletterConsentError";
  }
}

function objectValue(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function integer(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function ensureCanWrite(actor: AppActor) {
  if (actor.role === "viewer") throw new NewsletterAudienceAccessError();
}

function mapAudience(row: AudienceRow): NewsletterAudienceView {
  return {
    id: stringValue(row.id),
    userId: stringValue(row.created_by_user_id),
    name: stringValue(row.name),
    description: stringValue(row.description),
    senderName: stringOrNull(row.sender_name),
    senderEmail: stringOrNull(row.sender_email),
    replyToEmail: stringOrNull(row.reply_to_email),
    audienceMetadata: objectValue(row.audience_metadata),
    active: row.active !== false,
    createdAt: timestamp(row.created_at) ?? "",
    updatedAt: timestamp(row.updated_at) ?? "",
  };
}

function mapContact(row: ContactRow): NewsletterContactView {
  const status = newsletterContactStatusSchema.safeParse(row.status);
  return {
    id: stringValue(row.id),
    audienceId: stringValue(row.audience_id),
    email: stringValue(row.email),
    displayName: stringOrNull(row.display_name),
    status: status.success ? status.data : "suppressed",
    consentSource: stringValue(row.consent_source, "manual"),
    consentedAt: timestamp(row.consented_at),
    unsubscribedAt: timestamp(row.unsubscribed_at),
    suppressionReason: stringOrNull(row.suppression_reason),
    contactMetadata: objectValue(row.contact_metadata),
    createdAt: timestamp(row.created_at) ?? "",
    updatedAt: timestamp(row.updated_at) ?? "",
  };
}

function audienceInputFromView(audience: NewsletterAudienceView): NewsletterAudienceInput {
  return {
    name: audience.name,
    description: audience.description,
    senderName: audience.senderName,
    senderEmail: audience.senderEmail,
    replyToEmail: audience.replyToEmail,
    audienceMetadata: audience.audienceMetadata,
    active: audience.active,
  };
}

function contactInputFromView(contact: NewsletterContactView): NewsletterContactInput {
  return {
    email: contact.email,
    displayName: contact.displayName,
    status: contact.status,
    consentSource: contact.consentSource,
    consentedAt: contact.consentedAt,
    unsubscribedAt: contact.unsubscribedAt,
    suppressionReason: contact.suppressionReason,
    contactMetadata: contact.contactMetadata,
  };
}

function definedPatch<T extends Record<string, unknown>>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function audienceWrite(input: NewsletterAudienceInput): AudienceWrite {
  return {
    name: input.name,
    description: input.description,
    senderName: input.senderName ?? null,
    senderEmail: input.senderEmail ?? null,
    replyToEmail: input.replyToEmail ?? null,
    audienceMetadataJson: JSON.stringify(input.audienceMetadata),
    active: input.active,
  };
}

function contactWrite(input: NewsletterContactInput): ContactWrite {
  const email = input.email.trim().toLocaleLowerCase("en-US");
  const consentedAt = input.consentedAt ?? null;
  if (input.status === "subscribed" && !consentedAt) throw new NewsletterConsentError();
  return {
    email,
    displayName: input.displayName ?? null,
    status: input.status,
    consentSource: input.consentSource.trim(),
    consentedAt,
    unsubscribedAt: input.unsubscribedAt ?? (input.status === "unsubscribed" ? new Date().toISOString() : null),
    suppressionReason: input.suppressionReason ?? null,
    contactMetadataJson: JSON.stringify(input.contactMetadata),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505");
}

async function assertOwnedAudience(actor: AppActor, audienceId: string, sql: NeonSql): Promise<void> {
  const rows = await sql.query(
    `select id::text
       from newsletter_audiences
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1`,
    [actor.workspaceId, audienceId],
  ) as unknown as Array<{ id: string }>;
  if (!rows[0]) throw new NewsletterAudienceNotFoundError();
}

async function getContactForActor(actor: AppActor, contactId: string, sql: NeonSql): Promise<NewsletterContactView | null> {
  const rows = await sql.query(
    `select id::text, audience_id::text, email, display_name, status,
            consent_source, consented_at, unsubscribed_at, suppression_reason,
            contact_metadata, created_at, updated_at
       from newsletter_contacts
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1`,
    [actor.workspaceId, contactId],
  ) as unknown as ContactRow[];
  return rows[0] ? mapContact(rows[0]) : null;
}

/** Non-PII configuration list used by the draft editor and audience manager. */
export async function listStudioNewsletterAudiences(actor: AppActor, sql: NeonSql = createNeonSql()): Promise<NewsletterAudienceView[]> {
  const rows = await sql.query(
    `select id::text, created_by_user_id::text, name, description,
            sender_name, sender_email, reply_to_email, audience_metadata,
            active, created_at, updated_at
       from newsletter_audiences
      where workspace_id = $1::uuid
      order by lower(name) asc, created_at asc`,
    [actor.workspaceId],
  ) as unknown as AudienceRow[];
  return rows.map(mapAudience);
}

export async function getStudioNewsletterAudience(
  actor: AppActor,
  audienceId: string,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterAudienceView | null> {
  const rows = await sql.query(
    `select id::text, created_by_user_id::text, name, description,
            sender_name, sender_email, reply_to_email, audience_metadata,
            active, created_at, updated_at
       from newsletter_audiences
      where workspace_id = $1::uuid
        and id = $2::uuid
      limit 1`,
    [actor.workspaceId, audienceId],
  ) as unknown as AudienceRow[];
  return rows[0] ? mapAudience(rows[0]) : null;
}

export async function createStudioNewsletterAudience(
  actor: AppActor,
  input: NewsletterAudienceInput,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterAudienceView> {
  ensureCanWrite(actor);
  const payload = newsletterAudienceInputSchema.parse(input);
  const value = audienceWrite(payload);
  const rows = await sql.query(
    `insert into newsletter_audiences (
       workspace_id, created_by_user_id, name, description, sender_name,
       sender_email, reply_to_email, audience_metadata, active
     ) values (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb, $9
     )
     returning id::text, created_by_user_id::text, name, description,
               sender_name, sender_email, reply_to_email, audience_metadata,
               active, created_at, updated_at`,
    [
      actor.workspaceId,
      actor.userId,
      value.name,
      value.description,
      value.senderName,
      value.senderEmail,
      value.replyToEmail,
      value.audienceMetadataJson,
      value.active,
    ],
  ) as unknown as AudienceRow[];
  const row = rows[0];
  if (!row) throw new Error("Kunde inte skapa mottagarlistan.");
  return mapAudience(row);
}

export async function updateStudioNewsletterAudience(
  actor: AppActor,
  audienceId: string,
  patch: NewsletterAudienceUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterAudienceView | null> {
  ensureCanWrite(actor);
  const existing = await getStudioNewsletterAudience(actor, audienceId, sql);
  if (!existing) return null;
  const payload = newsletterAudienceInputSchema.parse({
    ...audienceInputFromView(existing),
    ...definedPatch(patch),
  });
  const value = audienceWrite(payload);
  const rows = await sql.query(
    `update newsletter_audiences
        set name = $3,
            description = $4,
            sender_name = $5,
            sender_email = $6,
            reply_to_email = $7,
            audience_metadata = $8::jsonb,
            active = $9
      where workspace_id = $1::uuid
        and id = $2::uuid
      returning id::text, created_by_user_id::text, name, description,
                sender_name, sender_email, reply_to_email, audience_metadata,
                active, created_at, updated_at`,
    [
      actor.workspaceId,
      audienceId,
      value.name,
      value.description,
      value.senderName,
      value.senderEmail,
      value.replyToEmail,
      value.audienceMetadataJson,
      value.active,
    ],
  ) as unknown as AudienceRow[];
  return rows[0] ? mapAudience(rows[0]) : null;
}

export async function deleteStudioNewsletterAudience(
  actor: AppActor,
  audienceId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  ensureCanWrite(actor);
  await assertOwnedAudience(actor, audienceId, sql);
  const references = await sql.query(
    `select 'draft' as source
       from studio_drafts
      where workspace_id = $1::uuid
        and metadata ->> 'newsletterAudienceId' = $2
     union all
     select 'automation' as source
       from studio_automations
      where workspace_id = $1::uuid
        and generation_config ->> 'newsletterAudienceId' = $2
     limit 1`,
    [actor.workspaceId, audienceId],
  ) as unknown as Array<{ source: string }>;
  if (references[0]) throw new NewsletterAudienceInUseError();
  const deleted = await sql.query(
    `delete from newsletter_audiences
      where workspace_id = $1::uuid
        and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, audienceId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(deleted[0]);
}

/** Aggregate deliberately excludes recipient details and delivery state. */
export async function listStudioNewsletterAudienceSummaries(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterAudienceDeliverySummary[]> {
  const rows = await sql.query(
    `select audience.id::text, audience.name, audience.active,
            count(contact.id)::integer as contact_count,
            count(contact.id) filter (where contact.status = 'subscribed')::integer as subscribed_count,
            count(contact.id) filter (where contact.status = 'unsubscribed')::integer as unsubscribed_count,
            count(contact.id) filter (where contact.status in ('bounced', 'complained', 'suppressed'))::integer as suppressed_count
       from newsletter_audiences audience
       left join newsletter_contacts contact
         on contact.workspace_id = audience.workspace_id
        and contact.audience_id = audience.id
      where audience.workspace_id = $1::uuid
      group by audience.id, audience.name, audience.active
      order by lower(audience.name) asc`,
    [actor.workspaceId],
  ) as unknown as AudienceSummaryRow[];
  return rows.map((row) => ({
    audienceId: stringValue(row.id),
    audienceName: stringValue(row.name),
    audienceActive: row.active !== false,
    contactCount: integer(row.contact_count),
    subscribedCount: integer(row.subscribed_count),
    unsubscribedCount: integer(row.unsubscribed_count),
    suppressedCount: integer(row.suppressed_count),
    // Delivery is intentionally unavailable in the Vercel-only slice.
    queuedCount: 0,
    sendingCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    unknownCount: 0,
  }));
}

/** Contact details are only exposed after a specific audience is authorized. */
export async function listStudioNewsletterContacts(
  actor: AppActor,
  audienceId: string,
  options: { limit?: number; status?: NewsletterContactStatus } = {},
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterContactView[]> {
  await assertOwnedAudience(actor, audienceId, sql);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 250));
  const status = options.status;
  const rows = await sql.query(
    `select id::text, audience_id::text, email, display_name, status,
            consent_source, consented_at, unsubscribed_at, suppression_reason,
            contact_metadata, created_at, updated_at
       from newsletter_contacts
      where workspace_id = $1::uuid
        and audience_id = $2::uuid
        ${status ? "and status = $3" : ""}
      order by created_at desc
      limit $${status ? "4" : "3"}::integer`,
    status ? [actor.workspaceId, audienceId, status, limit] : [actor.workspaceId, audienceId, limit],
  ) as unknown as ContactRow[];
  return rows.map(mapContact);
}

export async function createStudioNewsletterContact(
  actor: AppActor,
  input: NewsletterContactCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterContactView> {
  ensureCanWrite(actor);
  const payload = newsletterContactCreateSchema.parse(input);
  const value = contactWrite(payload);
  // Validate consent before even an ownership read. A malformed import never
  // reaches the database, while a valid contact is still bound to its owned
  // audience below.
  await assertOwnedAudience(actor, payload.audienceId, sql);
  try {
    const rows = await sql.query(
      `insert into newsletter_contacts (
         workspace_id, audience_id, email, display_name, status, consent_source,
         consented_at, unsubscribed_at, suppression_reason, contact_metadata
       ) values (
         $1::uuid, $2::uuid, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9, $10::jsonb
       )
       returning id::text, audience_id::text, email, display_name, status,
                 consent_source, consented_at, unsubscribed_at, suppression_reason,
                 contact_metadata, created_at, updated_at`,
      [
        actor.workspaceId,
        payload.audienceId,
        value.email,
        value.displayName,
        value.status,
        value.consentSource,
        value.consentedAt,
        value.unsubscribedAt,
        value.suppressionReason,
        value.contactMetadataJson,
      ],
    ) as unknown as ContactRow[];
    const row = rows[0];
    if (!row) throw new Error("Kunde inte spara mottagaren.");
    return mapContact(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new NewsletterContactConflictError();
    throw error;
  }
}

export async function updateStudioNewsletterContact(
  actor: AppActor,
  contactId: string,
  patch: NewsletterContactUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<NewsletterContactView> {
  ensureCanWrite(actor);
  const existing = await getContactForActor(actor, contactId, sql);
  if (!existing) throw new NewsletterContactNotFoundError();
  if (existing.status !== "subscribed" && patch.status === "subscribed" && patch.consentedAt === undefined) {
    throw new NewsletterConsentError("En person som återaktiveras behöver ett nytt dokumenterat samtycke.");
  }
  const reactivating = existing.status !== "subscribed" && patch.status === "subscribed";
  const payload = newsletterContactInputSchema.parse({
    ...contactInputFromView(existing),
    ...definedPatch(patch),
    // A fresh opt-in replaces an old opt-out state. An explicit timestamp in
    // the patch is still retained for historical corrections/imports.
    ...(reactivating && patch.unsubscribedAt === undefined ? { unsubscribedAt: null } : {}),
  });
  const value = contactWrite(payload);
  try {
    const rows = await sql.query(
      `update newsletter_contacts
          set email = $3,
              display_name = $4,
              status = $5,
              consent_source = $6,
              consented_at = $7::timestamptz,
              unsubscribed_at = $8::timestamptz,
              suppression_reason = $9,
              contact_metadata = $10::jsonb
        where workspace_id = $1::uuid
          and id = $2::uuid
        returning id::text, audience_id::text, email, display_name, status,
                  consent_source, consented_at, unsubscribed_at, suppression_reason,
                  contact_metadata, created_at, updated_at`,
      [
        actor.workspaceId,
        contactId,
        value.email,
        value.displayName,
        value.status,
        value.consentSource,
        value.consentedAt,
        value.unsubscribedAt,
        value.suppressionReason,
        value.contactMetadataJson,
      ],
    ) as unknown as ContactRow[];
    const row = rows[0];
    if (!row) throw new NewsletterContactNotFoundError();
    return mapContact(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new NewsletterContactConflictError();
    throw error;
  }
}

export async function deleteStudioNewsletterContact(
  actor: AppActor,
  contactId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  ensureCanWrite(actor);
  const rows = await sql.query(
    `delete from newsletter_contacts
      where workspace_id = $1::uuid
        and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, contactId],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}
