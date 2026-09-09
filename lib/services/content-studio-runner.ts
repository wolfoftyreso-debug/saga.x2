import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ContentAutomationJobView,
  ContentAutomationRuleView,
  ContentChannel,
  ContentDraftView,
} from "@/lib/domain/content-studio";
import { ContentGenerationError, generateContentDraft } from "@/lib/services/content-generation";
import {
  createContentMediaSignedUrl,
  downloadContentMediaForUser,
} from "@/lib/services/content-media";
import {
  claimContentAutomationJob,
  createManualContentAutomationJob,
  ensureContentAutomationJobs,
  failContentAutomationJob,
  getContentAutomationJobForUser,
  getDueContentAutomationJobs,
  getNewsletterAudienceForUser,
  getContentDraftForUser,
  listContentDrafts,
  markContentDraftPublicationResult,
  materializeContentAutomationJobDraft,
  type ContentAutomationDraftPayload,
} from "@/lib/services/content-studio";
import {
  claimNewsletterDeliveryReceipts,
  completeNewsletterDeliveryReceipt,
  newsletterMessageForClaim,
  outcomeForNewsletterDeliveryError,
  stageNewsletterDeliveryReceipts,
} from "@/lib/services/newsletter-delivery";
import { sendNewsletterMessage } from "@/lib/services/newsletter-publishing";
import { createNewsletterUnsubscribeUrl } from "@/lib/services/newsletter-unsubscribe";
import {
  getDefaultSocialConnectionSecret,
} from "@/lib/services/social-connections";
import {
  publishReadySocialPost,
  uploadLinkedInImageAsset,
} from "@/lib/services/social-publishing";
import { providerForChannel, type ReadySocialPost, type SocialChannel } from "@/lib/domain/social";
import { createAdminClient } from "@/lib/supabase/admin";

type DatabaseClient = SupabaseClient;

// A 15-minute wake-up is a queue pulse, not a parallel batch farm. Keeping
// this small lets a slow model/provider failure finish inside the cron window.
const MAX_AUTOMATION_JOBS_PER_TICK = 3;
// Sends are deliberately sequential and the provider can take up to 30 s.
// A small batch leaves the 15-minute cron enough room for the rest of the
// studio queue and continues from the durable receipt ledger next tick.
const MAX_NEWSLETTER_RECIPIENTS_PER_TICK = 5;

export type ContentStudioRunResult = {
  queue: { rulesScanned: number; jobsCreated: number };
  automation: { due: number; claimed: number; draftsCreated: number; failed: number };
  publication: { candidates: number; published: number; failed: number; awaitingApproval: number };
  newsletter: { stagedRecipients: number; sent: number; failed: number; unknown: number };
  errors: string[];
};

export type ContentAutomationManualRunResult = {
  /** `draft_created` is the only successful terminal state for a manual run. */
  status: "draft_created" | "queued" | "processing" | "failed";
  automation: ContentAutomationRuleView;
  job: ContentAutomationJobView;
  draft: ContentDraftView | null;
  message: string | null;
  /** Safe HTTP-compatible status for a terminal generation failure. */
  errorStatus: number | null;
};

/**
 * Handle one explicit user request to make a draft now.
 *
 * This path deliberately does not call publication or newsletter delivery.
 * The durable manual job is tagged in the database and the materializer turns
 * it into an unscheduled `draft`, even when the rule normally auto-publishes.
 */
export async function runContentAutomationNow(input: {
  userId: string;
  automationRuleId: string;
  idempotencyKey: string;
  now?: Date;
  database?: DatabaseClient;
}): Promise<ContentAutomationManualRunResult | null> {
  const database = input.database ?? createAdminClient();
  const now = input.now ?? new Date();
  const prepared = await createManualContentAutomationJob(database, {
    userId: input.userId,
    automationRuleId: input.automationRuleId,
    idempotencyKey: input.idempotencyKey,
    now,
  });
  if (!prepared) return null;

  const resultForJob = async (
    job: ContentAutomationJobView,
    message: string | null = null,
    errorStatus: number | null = null,
  ): Promise<ContentAutomationManualRunResult> => {
    const draft = job.contentDraftId ? await getContentDraftForUser(database, input.userId, job.contentDraftId) : null;
    if (draft) return { status: "draft_created", automation: prepared.rule, job, draft, message: null, errorStatus: null };
    if (job.state === "failed" || job.state === "cancelled" || job.state === "skipped") {
      return {
        status: "failed",
        automation: prepared.rule,
        job,
        draft: null,
        message: message ?? job.lastError ?? "Körningen avslutades utan att skapa ett utkast.",
        errorStatus: errorStatus ?? 502,
      };
    }
    return {
      status: job.state === "processing" ? "processing" : "queued",
      automation: prepared.rule,
      job,
      draft: null,
      message,
      errorStatus: null,
    };
  };

  // The same idempotency key always surfaces a terminal/claimed result. A
  // previously queued item may be claimed below once configuration has been
  // added, which makes a user retry useful without making a second job.
  if (prepared.reused && prepared.job.state !== "queued") return resultForJob(prepared.job);

  // A queued receipt is more honest than pretending that a draft was made when
  // local development has not received an OpenAI key yet. A later scheduler
  // pulse can safely materialize the same manual job; it can never publish it.
  if (!process.env.OPENAI_API_KEY) {
    return resultForJob(prepared.job, "AI-skrivningen är inte konfigurerad ännu. Körningen ligger kvar i kö.");
  }

  const claimed = await claimContentAutomationJob(database, prepared.job.id, { now });
  if (!claimed) {
    const current = await getContentAutomationJobForUser(database, input.userId, prepared.job.id);
    return resultForJob(current ?? prepared.job, "Körningen hanteras redan av en annan arbetsprocess.");
  }

  try {
    const generated = await generateContentForAutomation(claimed);
    const draft = await materializeContentAutomationJobDraft(database, {
      jobId: claimed.id,
      claimToken: claimed.claimToken,
      content: generated,
      now,
    });
    const current = await getContentAutomationJobForUser(database, input.userId, claimed.id);
    if (draft) {
      return {
        status: "draft_created",
        automation: prepared.rule,
        job: current ?? prepared.job,
        draft,
        message: null,
        errorStatus: null,
      };
    }
    return resultForJob(current ?? prepared.job, "Körningen slutfördes inte. Försök igen med en ny körning.", 502);
  } catch (error) {
    const message = displayError("", error);
    try {
      await failContentAutomationJob(database, {
        jobId: claimed.id,
        claimToken: claimed.claimToken,
        errorMessage: message,
        retry: false,
        now,
      });
    } catch {
      // The original safe error is returned below; the job lease will become
      // visible in history if the receipt update itself was unavailable.
    }
    const current = await getContentAutomationJobForUser(database, input.userId, claimed.id);
    return resultForJob(current ?? prepared.job, message, error instanceof ContentGenerationError ? error.status : 502);
  }
}

/**
 * The content cron is intentionally separate from the editorial brief
 * pipeline. It can fail visibly without suppressing a morning brief or a
 * watch monitor. Every provider operation is idempotent or has a durable
 * receipt before it runs.
 */
export async function runContentStudioScheduler(input: {
  userId: string;
  now?: Date;
  database?: DatabaseClient;
}): Promise<ContentStudioRunResult> {
  const database = input.database ?? createAdminClient();
  const now = input.now ?? new Date();
  const result: ContentStudioRunResult = {
    queue: { rulesScanned: 0, jobsCreated: 0 },
    automation: { due: 0, claimed: 0, draftsCreated: 0, failed: 0 },
    publication: { candidates: 0, published: 0, failed: 0, awaitingApproval: 0 },
    newsletter: { stagedRecipients: 0, sent: 0, failed: 0, unknown: 0 },
    errors: [],
  };

  try {
    result.queue = await ensureContentAutomationJobs(database, { userId: input.userId, now });
  } catch (error) {
    result.errors.push(displayError("Kunde inte bygga innehållskön", error));
    return result;
  }

  let dueJobs;
  try {
    dueJobs = await getDueContentAutomationJobs(database, {
      userId: input.userId,
      now,
      limit: MAX_AUTOMATION_JOBS_PER_TICK,
    });
    result.automation.due = dueJobs.length;
  } catch (error) {
    result.errors.push(displayError("Kunde inte läsa innehållskön", error));
    return result;
  }

  for (const due of dueJobs) {
    let claimed: Awaited<ReturnType<typeof claimContentAutomationJob>> = null;
    try {
      claimed = await claimContentAutomationJob(database, due.id, { now });
      if (!claimed) continue;
      result.automation.claimed += 1;

      const generated = await generateContentForAutomation(claimed);
      const draft = await materializeContentAutomationJobDraft(database, {
        jobId: claimed.id,
        claimToken: claimed.claimToken,
        content: generated,
        now,
      });
      if (draft) result.automation.draftsCreated += 1;
    } catch (error) {
      result.automation.failed += 1;
      result.errors.push(displayError("Automationen " + due.id + " misslyckades", error));
      // A configuration/validation error should be visible and stop here;
      // it must not burn the cron repeatedly. A later user edit queues a new
      // job through the ordinary rule update path.
      try {
        if (claimed) {
          await failContentAutomationJob(database, {
            jobId: claimed.id,
            claimToken: claimed.claimToken,
            errorMessage: displayError("", error),
            retry: false,
            now,
          });
        }
      } catch {
        // The original error is already retained in this run receipt.
      }
    }
  }

  await publishDueContent(database, input.userId, now, result);
  await deliverQueuedNewsletters(database, input.userId, now, result);
  return result;
}

async function generateContentForAutomation(job: {
  rule: {
    contentType: "social_post" | "newsletter" | "article";
    channels: ContentChannel[];
    generationPrompt: string;
    imagePrompt: string;
    tone: string | null;
    desiredLength: number | null;
    language: string;
  };
  template: {
    generationPrompt: string;
    imagePrompt: string;
    defaultCta: string | null;
  } | null;
}): Promise<ContentAutomationDraftPayload> {
  if (job.rule.language !== "sv") {
    throw new Error("Automatiserad AI-skrivning stöder just nu svenska. Ändra språk eller skapa utkastet manuellt.");
  }
  const generated = await generateContentDraft({
    contentType: job.rule.contentType,
    channels: job.rule.channels,
    topic: job.rule.generationPrompt,
    brief: "",
    voice: job.rule.tone ?? "Rak, varm och konkret svenska.",
    targetLength: lengthFromDesiredWordCount(job.rule.desiredLength),
    templateInstructions: job.template?.generationPrompt ?? "",
    desiredCallToAction: job.template?.defaultCta ?? "",
    imageDirection: job.rule.imagePrompt || job.template?.imagePrompt || "",
    language: "sv",
  });
  return {
    title: generated.draft.title,
    headline: generated.draft.headline,
    subject: generated.draft.subject,
    body: generated.draft.body,
    cta: generated.draft.callToAction,
    excerpt: generated.draft.excerpt,
    hashtags: generated.draft.hashtags,
    generationPrompt: job.rule.generationPrompt,
    imagePrompt: generated.draft.imagePrompt,
    language: "sv",
  };
}

async function publishDueContent(
  database: DatabaseClient,
  userId: string,
  now: Date,
  result: ContentStudioRunResult,
): Promise<void> {
  let drafts: ContentDraftView[];
  try {
    drafts = await listContentDrafts(database, userId, {
      includeMedia: true,
      statuses: ["approved", "scheduled"],
      limit: 250,
    });
  } catch (error) {
    result.errors.push(displayError("Kunde inte läsa schemalagda utkast", error));
    return;
  }

  const due = drafts.filter((draft) => draft.scheduledAt && new Date(draft.scheduledAt).getTime() <= now.getTime());
  result.publication.candidates += due.length;
  for (const draft of due) {
    if (draft.approvalRequired && draft.status !== "approved" && !draft.approvedAt) {
      result.publication.awaitingApproval += 1;
      continue;
    }
    if (draft.contentType === "newsletter") {
      await stageNewsletterDraft(database, userId, draft, result);
      continue;
    }
    if (!draft.channels.length) continue;
    const outcome = await publishSocialDraft(database, userId, draft);
    if (outcome.ok) result.publication.published += 1;
    else {
      result.publication.failed += 1;
      result.errors.push(outcome.error);
    }
  }
}

async function stageNewsletterDraft(
  database: DatabaseClient,
  userId: string,
  draft: ContentDraftView,
  result: ContentStudioRunResult,
): Promise<void> {
  if (!draft.newsletterAudienceId) {
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "failed", publishedAt: null });
    result.publication.failed += 1;
    result.errors.push("Nyhetsbrevet " + draft.id + " saknar mottagargrupp.");
    return;
  }
  try {
    const audience = await getNewsletterAudienceForUser(database, userId, draft.newsletterAudienceId);
    if (!audience?.active) throw new Error("Mottagargruppen är inte aktiv.");
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "publishing" });
    const staged = await stageNewsletterDeliveryReceipts(database, userId, {
      contentDraftId: draft.id,
      newsletterAudienceId: draft.newsletterAudienceId,
    });
    result.newsletter.stagedRecipients += staged.insertedCount;
    if (staged.eligibleCount === 0) {
      await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "failed", publishedAt: null });
      result.publication.failed += 1;
      result.errors.push("Nyhetsbrevet " + draft.id + " har inga aktiva mottagare.");
    }
  } catch (error) {
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "failed", publishedAt: null });
    result.publication.failed += 1;
    result.errors.push(displayError("Nyhetsbrevet " + draft.id + " kunde inte förberedas", error));
  }
}

async function deliverQueuedNewsletters(
  database: DatabaseClient,
  userId: string,
  now: Date,
  result: ContentStudioRunResult,
): Promise<void> {
  let claims;
  try {
    claims = await claimNewsletterDeliveryReceipts(database, userId, { limit: MAX_NEWSLETTER_RECIPIENTS_PER_TICK });
  } catch (error) {
    result.errors.push(displayError("Kunde inte hämta nyhetsbrevsleveranser", error));
    return;
  }
  for (const claim of claims) {
    let providerAccepted = false;
    try {
      const unsubscribeUrl = createNewsletterUnsubscribeUrl({
        contactId: claim.contactId,
        audienceId: claim.newsletterAudienceId,
      });
      const sent = await sendNewsletterMessage({
        ...newsletterMessageForClaim(claim),
        unsubscribeUrl,
      });
      providerAccepted = true;
      const recorded = await completeNewsletterDeliveryReceipt(database, userId, claim, {
        kind: "delivered",
        providerMessageId: sent.providerMessageId,
      });
      if (!recorded) {
        // The provider accepted the email, but this worker no longer owns the
        // receipt. Do not call it delivered in the run result and, crucially,
        // do not attempt another send.
        result.newsletter.unknown += 1;
        result.errors.push("Nyhetsbrev accepterades av leverantören men kunde inte kvitteras säkert.");
      } else {
        result.newsletter.sent += 1;
      }
    } catch (error) {
      // A response may have reached the provider just before persistence
      // failed. Treat that as unknown rather than retrying and risking a
      // duplicate message.
      const outcome = providerAccepted
        ? { kind: "unknown" as const, errorCode: "receipt_update_failed", errorMessage: displayError("", error) }
        : outcomeForNewsletterDeliveryError(error, claim.attemptNumber, now);
      try {
        const recorded = await completeNewsletterDeliveryReceipt(database, userId, claim, outcome);
        if (!recorded) {
          result.newsletter.unknown += 1;
          result.errors.push("Nyhetsbrevets leveranskvitto kunde inte uppdateras säkert.");
        } else if (outcome.kind === "unknown") {
          result.newsletter.unknown += 1;
          result.errors.push(displayError("Nyhetsbrevsmottagare kunde inte nås säkert", error));
        } else {
          result.newsletter.failed += 1;
          result.errors.push(displayError("Nyhetsbrevsmottagare kunde inte nås", error));
        }
      } catch (receiptError) {
        result.newsletter.unknown += 1;
        result.errors.push(displayError("Nyhetsbrevets leveranskvitto kunde inte sparas", receiptError));
      }
    }
  }

  // A publication remains "publishing" while there are queued/sending or
  // retryable recipient receipts. It changes only once the receipt ledger is
  // conclusive; normal UI paths never inspect a recipient address.
  const openDrafts = await listContentDrafts(database, userId, {
    statuses: ["publishing"],
    limit: 250,
  });
  for (const draft of openDrafts.filter((entry) => entry.contentType === "newsletter")) {
    await reconcileNewsletterDraft(database, userId, draft.id, now, result);
  }
}

async function reconcileNewsletterDraft(
  database: DatabaseClient,
  userId: string,
  draftId: string,
  now: Date,
  result: ContentStudioRunResult,
): Promise<void> {
  const { data, error } = await database
    .from("newsletter_delivery_receipts")
    .select("state, next_attempt_at")
    .eq("user_id", userId)
    .eq("content_draft_id", draftId);
  if (error) {
    result.errors.push(displayError("Kunde inte läsa nyhetsbrevets leveranskvitton", error));
    return;
  }
  const receipts = (data ?? []).map((row) => ({
    state: String((row as { state?: unknown }).state),
    nextAttemptAt: typeof (row as { next_attempt_at?: unknown }).next_attempt_at === "string"
      ? (row as { next_attempt_at: string }).next_attempt_at
      : null,
  }));
  if (!receipts.length) {
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draftId, status: "failed", publishedAt: null });
    result.publication.failed += 1;
    return;
  }
  if (receipts.some((receipt) => receipt.state === "queued" || receipt.state === "sending")) return;
  if (receipts.some((receipt) => receipt.state === "failed" && receipt.nextAttemptAt)) return;
  if (receipts.some((receipt) => receipt.state === "failed" || receipt.state === "unknown" || receipt.state === "cancelled")) {
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draftId, status: "failed", publishedAt: null });
    result.publication.failed += 1;
    return;
  }
  if (receipts.every((receipt) => receipt.state === "delivered" || receipt.state === "suppressed")) {
    await markContentDraftPublicationResult(database, {
      userId,
      contentDraftId: draftId,
      status: "published",
      publishedAt: now.toISOString(),
    });
    result.publication.published += 1;
  }
}

async function publishSocialDraft(
  database: DatabaseClient,
  userId: string,
  draft: ContentDraftView,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const channels = draft.channels.filter((channel): channel is SocialChannel => channel !== "newsletter");
  if (!channels.length) return { ok: true };
  await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "publishing" });

  const messages: string[] = [];
  for (const channel of channels) {
    try {
      const post = await readyPostForDraft(database, userId, draft);
      const provider = providerForChannel(channel);
      let connectionId: string | null = null;
      if (channel === "linkedin" && post.media[0]) {
        const connection = await getDefaultSocialConnectionSecret(database, userId, provider);
        if (connection) {
          const media = draft.media.at(-1);
          if (media) {
            const image = await downloadContentMediaForUser(database, userId, media.id);
            post.media[0].linkedInAssetUrn = await uploadLinkedInImageAsset({
              connection,
              image: image.bytes,
              contentType: image.contentType,
            });
            connectionId = connection.id;
          }
        }
      }
      const published = await publishReadySocialPost(database, {
        userId,
        provider,
        post,
        connectionId,
        contentDraftId: draft.id,
        idempotencyKey: "content:" + draft.id + ":" + channel,
      });
      if (published.status !== "published") messages.push(channel + ": " + (published.errorMessage ?? "Publiceringen misslyckades."));
    } catch (error) {
      messages.push(channel + ": " + displayError("Publiceringen misslyckades", error));
    }
  }

  if (messages.length) {
    await markContentDraftPublicationResult(database, { userId, contentDraftId: draft.id, status: "failed", publishedAt: null });
    return { ok: false, error: messages.join(" ") };
  }
  await markContentDraftPublicationResult(database, {
    userId,
    contentDraftId: draft.id,
    status: "published",
    publishedAt: new Date().toISOString(),
  });
  return { ok: true };
}

async function readyPostForDraft(
  database: DatabaseClient,
  userId: string,
  draft: ContentDraftView,
): Promise<ReadySocialPost> {
  const media = draft.media.at(-1);
  const mediaUrl = media ? await createContentMediaSignedUrl(database, userId, media.id, 60 * 60) : null;
  const hashtagLine = draft.hashtags.length ? draft.hashtags.join(" ") : "";
  return {
    title: draft.title || null,
    headline: draft.headline || null,
    body: [draft.body, hashtagLine].filter(Boolean).join("\n\n"),
    cta: draft.cta || null,
    media: mediaUrl ? [{ url: mediaUrl, altText: media?.altText ?? null }] : [],
  };
}

function lengthFromDesiredWordCount(value: number | null): "short" | "medium" | "long" {
  if (!value) return "medium";
  if (value <= 100) return "short";
  if (value >= 280) return "long";
  return "medium";
}

function displayError(prefix: string, error: unknown): string {
  const message = error instanceof ContentGenerationError
    ? error.message
    : error instanceof Error ? error.message : "okänt fel";
  return prefix ? prefix + ": " + message : message;
}
