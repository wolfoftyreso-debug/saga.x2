import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NewsletterMessage } from "@/lib/domain/newsletter";
import {
  newsletterContactStatusSchema,
  type ClaimedNewsletterDelivery,
  type NewsletterAudienceDeliverySummary,
  type NewsletterContactCreateInput,
  type NewsletterContactInput,
  type NewsletterContactStatus,
  type NewsletterContactUpdateInput,
  type NewsletterContactView,
  type NewsletterDeliveryOutcome,
  type NewsletterDeliveryReceiptQuery,
  type NewsletterDeliveryReceiptState,
  type NewsletterDeliveryReceiptView,
  type NewsletterDeliveryStageInput,
  type NewsletterDeliveryStageResult,
} from "@/lib/domain/newsletter-delivery";

type DatabaseClient = SupabaseClient;
type RawRecord = Record<string, unknown>;

export class NewsletterDeliveryError extends Error {
  constructor(message: string, readonly code = "newsletter_delivery_failed") {
    super(message);
    this.name = "NewsletterDeliveryError";
  }
}

function databaseError(context: string, error: { message?: string } | null): NewsletterDeliveryError {
  return new NewsletterDeliveryError(`${context}${error?.message ? `: ${error.message}` : ""}`, "database_error");
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : {};
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapContact(raw: RawRecord): NewsletterContactView {
  const status = newsletterContactStatusSchema.safeParse(raw.status);
  return {
    id: String(raw.id),
    audienceId: String(raw.newsletter_audience_id),
    email: String(raw.email),
    displayName: typeof raw.display_name === "string" ? raw.display_name : null,
    status: status.success ? status.data : "suppressed",
    consentSource: String(raw.consent_source ?? "manual"),
    consentedAt: typeof raw.consented_at === "string" ? raw.consented_at : null,
    unsubscribedAt: typeof raw.unsubscribed_at === "string" ? raw.unsubscribed_at : null,
    suppressionReason: typeof raw.suppression_reason === "string" ? raw.suppression_reason : null,
    contactMetadata: jsonObject(raw.contact_metadata),
    createdAt: String(raw.created_at),
    updatedAt: String(raw.updated_at),
  };
}

async function assertOwnedAudience(client: DatabaseClient, userId: string, audienceId: string): Promise<void> {
  const { data, error } = await client
    .from("newsletter_audiences")
    .select("id")
    .eq("id", audienceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError("Kunde inte kontrollera mottagargruppen", error);
  if (!data) throw new NewsletterDeliveryError("Mottagargruppen hittades inte.", "audience_not_found");
}

/** Contact endpoints are the only browser path that intentionally returns email addresses. */
export async function listNewsletterContacts(
  client: DatabaseClient,
  userId: string,
  audienceId: string,
  options: { limit?: number; status?: NewsletterContactStatus } = {},
): Promise<NewsletterContactView[]> {
  await assertOwnedAudience(client, userId, audienceId);
  let query = client
    .from("newsletter_contacts")
    .select("*")
    .eq("user_id", userId)
    .eq("newsletter_audience_id", audienceId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(options.limit ?? 100, 250)));
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query;
  if (error) throw databaseError("Kunde inte läsa mottagare", error);
  return (data ?? []).map((row) => mapContact(asRecord(row)));
}

export async function createNewsletterContact(
  client: DatabaseClient,
  userId: string,
  input: NewsletterContactCreateInput,
): Promise<NewsletterContactView> {
  await assertOwnedAudience(client, userId, input.audienceId);
  const now = new Date().toISOString();
  const { data, error } = await client
    .from("newsletter_contacts")
    .insert({
      user_id: userId,
      newsletter_audience_id: input.audienceId,
      ...contactInputToRow(input, now),
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new NewsletterDeliveryError("Adressen finns redan i den här mottagargruppen.", "contact_exists");
    }
    throw databaseError("Kunde inte spara mottagaren", error);
  }
  return mapContact(asRecord(data));
}

export async function updateNewsletterContact(
  client: DatabaseClient,
  userId: string,
  contactId: string,
  input: NewsletterContactUpdateInput,
): Promise<NewsletterContactView> {
  const { data: existing, error: existingError } = await client
    .from("newsletter_contacts")
    .select("id")
    .eq("id", contactId)
    .eq("user_id", userId)
    .maybeSingle();
  if (existingError) throw databaseError("Kunde inte kontrollera mottagaren", existingError);
  if (!existing) throw new NewsletterDeliveryError("Mottagaren hittades inte.", "contact_not_found");
  const { data, error } = await client
    .from("newsletter_contacts")
    .update(contactInputToRow(input, new Date().toISOString()))
    .eq("id", contactId)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") {
      throw new NewsletterDeliveryError("Adressen finns redan i den här mottagargruppen.", "contact_exists");
    }
    throw databaseError("Kunde inte uppdatera mottagaren", error);
  }
  return mapContact(asRecord(data));
}

export async function deleteNewsletterContact(client: DatabaseClient, userId: string, contactId: string): Promise<boolean> {
  const { data, error } = await client
    .from("newsletter_contacts")
    .delete()
    .eq("id", contactId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte ta bort mottagaren", error);
  return Boolean(data);
}

/**
 * Public unsubscribe is deliberately idempotent. It receives only ids from a
 * successfully decrypted token; it returns no contact data, and immediately
 * suppresses all unclaimed receipts for that same recipient.
 */
export async function unsubscribeNewsletterContact(
  client: DatabaseClient,
  input: { contactId: string; audienceId: string },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data: contact, error: contactError } = await client
    .from("newsletter_contacts")
    .update({
      status: "unsubscribed",
      unsubscribed_at: now,
      suppression_reason: "Avprenumererad via nyhetsbrevslänk.",
    })
    .eq("id", input.contactId)
    .eq("newsletter_audience_id", input.audienceId)
    .select("id, user_id")
    .maybeSingle();
  if (contactError) throw databaseError("Kunde inte avsluta prenumerationen", contactError);
  if (!contact) return false;

  const { error: receiptsError } = await client
    .from("newsletter_delivery_receipts")
    .update({
      state: "suppressed",
      lock_token: null,
      locked_until: null,
      next_attempt_at: null,
      last_error_code: "recipient_unsubscribed",
      last_error_message: "Mottagaren har avslutat prenumerationen.",
    })
    .eq("newsletter_contact_id", input.contactId)
    .eq("newsletter_audience_id", input.audienceId)
    .eq("user_id", String(contact.user_id))
    .in("state", ["queued", "failed"]);
  if (receiptsError) throw databaseError("Kunde inte stoppa väntande leveranser", receiptsError);
  return true;
}

/**
 * Safe aggregate for draft, calendar and audience views. It intentionally
 * selects status columns only; no recipient email is loaded or returned.
 */
export async function getNewsletterAudienceDeliverySummaries(
  client: DatabaseClient,
  userId: string,
): Promise<NewsletterAudienceDeliverySummary[]> {
  const [audienceResult, contactsResult, receiptsResult] = await Promise.all([
    client.from("newsletter_audiences").select("id, name, active").eq("user_id", userId),
    client.from("newsletter_contacts").select("newsletter_audience_id, status").eq("user_id", userId),
    client.from("newsletter_delivery_receipts").select("newsletter_audience_id, state").eq("user_id", userId),
  ]);
  if (audienceResult.error) throw databaseError("Kunde inte läsa mottagargrupper", audienceResult.error);
  if (contactsResult.error) throw databaseError("Kunde inte läsa mottagarstatus", contactsResult.error);
  if (receiptsResult.error) throw databaseError("Kunde inte läsa leveransstatus", receiptsResult.error);

  const summaries = new Map<string, NewsletterAudienceDeliverySummary>();
  for (const row of audienceResult.data ?? []) {
    const audience = asRecord(row);
    const id = String(audience.id);
    summaries.set(id, emptyAudienceSummary(id, String(audience.name ?? "Mottagargrupp"), Boolean(audience.active)));
  }
  for (const row of contactsResult.data ?? []) {
    const contact = asRecord(row);
    const summary = summaries.get(String(contact.newsletter_audience_id));
    if (!summary) continue;
    summary.contactCount += 1;
    const status = String(contact.status);
    if (status === "subscribed") summary.subscribedCount += 1;
    if (status === "unsubscribed") summary.unsubscribedCount += 1;
    if (status === "suppressed" || status === "bounced" || status === "complained") summary.suppressedCount += 1;
  }
  for (const row of receiptsResult.data ?? []) {
    const receipt = asRecord(row);
    const summary = summaries.get(String(receipt.newsletter_audience_id));
    if (!summary) continue;
    const state = String(receipt.state);
    if (state === "queued") summary.queuedCount += 1;
    if (state === "sending") summary.sendingCount += 1;
    if (state === "delivered") summary.deliveredCount += 1;
    if (state === "failed") summary.failedCount += 1;
    if (state === "unknown") summary.unknownCount += 1;
  }
  return [...summaries.values()].sort((left, right) => left.audienceId.localeCompare(right.audienceId));
}

/** Idempotently creates one private receipt per currently subscribed contact. */
export async function stageNewsletterDeliveryReceipts(
  client: DatabaseClient,
  userId: string,
  input: NewsletterDeliveryStageInput,
): Promise<NewsletterDeliveryStageResult> {
  const { data, error } = await client.rpc("stage_newsletter_delivery_receipts", {
    p_user_id: userId,
    p_content_draft_id: input.contentDraftId,
    p_newsletter_audience_id: input.newsletterAudienceId,
  });
  if (error) throw databaseError("Kunde inte förbereda nyhetsbrevsleveransen", error);
  const row = Array.isArray(data) ? asRecord(data[0]) : asRecord(data);
  return {
    eligibleCount: numeric(row.eligible_count),
    insertedCount: numeric(row.inserted_count),
  };
}

/** Receipt history can be shown on a draft without exposing recipient PII. */
export async function listNewsletterDeliveryReceipts(
  client: DatabaseClient,
  userId: string,
  query: NewsletterDeliveryReceiptQuery = { limit: 100 },
): Promise<NewsletterDeliveryReceiptView[]> {
  let request = client
    .from("newsletter_delivery_receipts")
    .select("id, content_draft_id, newsletter_audience_id, state, attempt_count, max_attempts, next_attempt_at, last_attempt_at, delivered_at, provider_message_id, last_error_code, last_error_message, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(query.limit, 250)));
  if (query.contentDraftId) request = request.eq("content_draft_id", query.contentDraftId);
  if (query.audienceId) request = request.eq("newsletter_audience_id", query.audienceId);
  const { data, error } = await request;
  if (error) throw databaseError("Kunde inte läsa nyhetsbrevsleveranser", error);
  return (data ?? []).map((entry) => mapReceipt(asRecord(entry)));
}

/**
 * A human can explicitly retry a definite failure or reconcile an `unknown`
 * request. Delivered rows are immutable and can never be sent again here.
 */
export async function requeueNewsletterDeliveryReceipt(
  client: DatabaseClient,
  userId: string,
  receiptId: string,
): Promise<boolean> {
  const { data: existing, error: existingError } = await client
    .from("newsletter_delivery_receipts")
    .select("content_draft_id")
    .eq("id", receiptId)
    .eq("user_id", userId)
    .in("state", ["failed", "unknown"])
    .maybeSingle();
  if (existingError) throw databaseError("Kunde inte kontrollera nyhetsbrevsleveransen", existingError);
  if (!existing) return false;
  const contentDraftId = String(asRecord(existing).content_draft_id);
  const { data: draft, error: draftReadError } = await client
    .from("content_drafts")
    .select("id, status")
    .eq("id", contentDraftId)
    .eq("user_id", userId)
    .eq("content_type", "newsletter")
    .in("status", ["failed", "publishing"])
    .maybeSingle();
  if (draftReadError) throw databaseError("Kunde inte kontrollera nyhetsbrevsutkastet", draftReadError);
  if (!draft) return false;
  const { data, error } = await client
    .from("newsletter_delivery_receipts")
    .update({
      state: "queued",
      next_attempt_at: new Date().toISOString(),
      lock_token: null,
      locked_until: null,
      // Preserve a globally increasing attempt number, so the immutable
      // `(receipt_id, attempt_number)` audit constraint remains intact.
      max_attempts: 10,
      last_error_code: "manual_retry_queued",
      last_error_message: "Manuellt återförsök begärt.",
    })
    .eq("id", receiptId)
    .eq("user_id", userId)
    .in("state", ["failed", "unknown"])
    .lt("attempt_count", 10)
    .select("id")
    .maybeSingle();
  if (error) throw databaseError("Kunde inte köa om nyhetsbrevsleveransen", error);
  if (!data) return false;
  // The scheduler reconciles only actively publishing drafts. A deliberate
  // recovery therefore reopens the failed newsletter without changing its
  // written content or audience target.
  const { error: draftError } = await client
    .from("content_drafts")
    .update({ status: "publishing", published_at: null })
    .eq("id", contentDraftId)
    .eq("user_id", userId)
    .eq("content_type", "newsletter")
    .eq("status", "failed");
  if (draftError) throw databaseError("Kunde inte återöppna nyhetsbrevsutkastet", draftError);
  return true;
}

/**
 * Claims recipients transactionally through a service-role RPC. `sending`
 * rows remain owned by their one claim token and are never automatically
 * retried after a crash, preventing a speculative duplicate mail.
 */
export async function claimNewsletterDeliveryReceipts(
  client: DatabaseClient,
  userId: string,
  options: { limit?: number; lockSeconds?: number } = {},
): Promise<ClaimedNewsletterDelivery[]> {
  const { data, error } = await client.rpc("claim_newsletter_delivery_receipts", {
    p_user_id: userId,
    p_limit: Math.max(1, Math.min(options.limit ?? 25, 100)),
    p_lock_seconds: Math.max(60, Math.min(options.lockSeconds ?? 300, 1800)),
  });
  if (error) throw databaseError("Kunde inte hämta nyhetsbrevsleveranser", error);
  return (Array.isArray(data) ? data : []).map((entry) => mapClaimedDelivery(asRecord(entry)));
}

export async function completeNewsletterDeliveryReceipt(
  client: DatabaseClient,
  userId: string,
  claim: Pick<ClaimedNewsletterDelivery, "receiptId" | "claimToken">,
  outcome: NewsletterDeliveryOutcome,
): Promise<boolean> {
  const { data, error } = await client.rpc("complete_newsletter_delivery_receipt", {
    p_user_id: userId,
    p_receipt_id: claim.receiptId,
    p_claim_token: claim.claimToken,
    p_outcome: outcome.kind,
    p_provider_message_id: outcome.kind === "delivered" ? outcome.providerMessageId : null,
    p_error_code: outcome.kind === "delivered" ? null : outcome.errorCode,
    p_error_message: outcome.kind === "delivered" ? null : outcome.errorMessage,
    p_next_attempt_at: outcome.kind === "failed" ? outcome.nextAttemptAt : null,
  });
  if (error) throw databaseError("Kunde inte spara nyhetsbrevsresultatet", error);
  return data === true;
}

/** Convert the private worker claim into the one-recipient provider payload. */
export function newsletterMessageForClaim(claim: ClaimedNewsletterDelivery): NewsletterMessage {
  return {
    to: claim.recipientEmail,
    subject: claim.subject,
    headline: claim.headline ?? "",
    body: claim.body,
    callToAction: claim.cta,
    previewText: claim.excerpt,
    idempotencyKey: claim.idempotencyKey,
  };
}

/** A definite provider rejection can retry; an interrupted request cannot. */
export function outcomeForNewsletterDeliveryError(
  error: unknown,
  attemptNumber: number,
  now = new Date(),
): NewsletterDeliveryOutcome {
  const record = asRecord(error);
  const code = typeof record.code === "string" ? record.code : "delivery_failed";
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string" && record.message.trim()
      ? record.message
      : "Nyhetsbrevet kunde inte skickas.";
  // We do not know whether a socket timeout happened before or after the
  // provider accepted the email. Mark it for reconciliation, not retry.
  if (code === "provider_unavailable" || code === "resend_invalid_response") {
    return { kind: "unknown", errorCode: code, errorMessage: message };
  }
  const retryable = /^resend_(429|5\d\d)$/.test(code);
  if (!retryable) return { kind: "failed", errorCode: code, errorMessage: message, nextAttemptAt: null };
  return {
    kind: "failed",
    errorCode: code,
    errorMessage: message,
    nextAttemptAt: nextNewsletterRetryAt(attemptNumber, now),
  };
}

/** 5, 15, 45, then 120 minutes; never creates a busy retry loop. */
export function nextNewsletterRetryAt(attemptNumber: number, now = new Date()): string {
  const minutes = [5, 15, 45, 120][Math.max(0, Math.min(attemptNumber - 1, 3))] ?? 120;
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function contactInputToRow(input: Partial<NewsletterContactInput>, now: string): RawRecord {
  const row: RawRecord = {};
  if (input.email !== undefined) row.email = input.email.trim();
  if (input.displayName !== undefined) row.display_name = input.displayName;
  if (input.status !== undefined) {
    row.status = input.status;
    if (input.status === "subscribed") {
      row.consented_at = input.consentedAt ?? now;
      if (input.unsubscribedAt === undefined) row.unsubscribed_at = null;
    }
    if (input.status === "unsubscribed" && input.unsubscribedAt === undefined) row.unsubscribed_at = now;
  }
  if (input.consentSource !== undefined) row.consent_source = input.consentSource;
  if (input.consentedAt !== undefined) row.consented_at = input.consentedAt;
  if (input.unsubscribedAt !== undefined) row.unsubscribed_at = input.unsubscribedAt;
  if (input.suppressionReason !== undefined) row.suppression_reason = input.suppressionReason;
  if (input.contactMetadata !== undefined) row.contact_metadata = input.contactMetadata;
  return row;
}

function emptyAudienceSummary(audienceId: string, audienceName: string, audienceActive: boolean): NewsletterAudienceDeliverySummary {
  return {
    audienceId,
    audienceName,
    audienceActive,
    contactCount: 0,
    subscribedCount: 0,
    unsubscribedCount: 0,
    suppressedCount: 0,
    queuedCount: 0,
    sendingCount: 0,
    deliveredCount: 0,
    failedCount: 0,
    unknownCount: 0,
  };
}

function mapClaimedDelivery(row: RawRecord): ClaimedNewsletterDelivery {
  return {
    receiptId: String(row.receipt_id),
    claimToken: String(row.claim_token),
    userId: String(row.user_id),
    contentDraftId: String(row.content_draft_id),
    newsletterAudienceId: String(row.newsletter_audience_id),
    contactId: String(row.newsletter_contact_id),
    recipientEmail: String(row.recipient_email),
    recipientName: typeof row.recipient_name === "string" ? row.recipient_name : null,
    subject: String(row.subject),
    headline: typeof row.headline === "string" ? row.headline : null,
    body: String(row.body),
    cta: typeof row.cta === "string" ? row.cta : null,
    excerpt: typeof row.excerpt === "string" ? row.excerpt : null,
    idempotencyKey: String(row.idempotency_key),
    attemptNumber: numeric(row.attempt_number),
  };
}

function mapReceipt(row: RawRecord): NewsletterDeliveryReceiptView {
  const safeStates = new Set<NewsletterDeliveryReceiptState>(["queued", "sending", "delivered", "failed", "suppressed", "cancelled", "unknown"]);
  const rawState = String(row.state);
  return {
    id: String(row.id),
    contentDraftId: String(row.content_draft_id),
    audienceId: String(row.newsletter_audience_id),
    state: safeStates.has(rawState as NewsletterDeliveryReceiptState) ? rawState as NewsletterDeliveryReceiptState : "unknown",
    attemptCount: numeric(row.attempt_count),
    maxAttempts: numeric(row.max_attempts),
    nextAttemptAt: typeof row.next_attempt_at === "string" ? row.next_attempt_at : null,
    lastAttemptAt: typeof row.last_attempt_at === "string" ? row.last_attempt_at : null,
    deliveredAt: typeof row.delivered_at === "string" ? row.delivered_at : null,
    providerMessageId: typeof row.provider_message_id === "string" ? row.provider_message_id : null,
    lastErrorCode: typeof row.last_error_code === "string" ? row.last_error_code : null,
    lastErrorMessage: typeof row.last_error_message === "string" ? row.last_error_message : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function numeric(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}
