import { NextRequest, NextResponse } from "next/server";
import {
  contentAutomationManualRunInputSchema,
  contentAutomationRuleIdSchema,
} from "@/lib/domain/content-studio";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import {
  claimStudioManualAutomationJob,
  createStudioManualAutomationJob,
  getStudioDraft,
} from "@/lib/neon/studio-content-repository";
import { processNeonStudioAutomationClaim } from "@/lib/neon/studio-automation-worker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/** A manual click uses the same bounded, lease-safe worker as Vercel Cron. */
export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * Explicitly make one private draft. This route never invokes a publishing
 * provider: the durable job is tagged `manual` and its draft has no schedule.
 */
export async function POST(request: NextRequest, context: Context) {
  const configuration = neonConfigurationResponse("Studio behöver en Vercel-ansluten arbetsyta för att köra automationen.");
  if (configuration) return configuration;

  const resolved = await requireNeonActor("Logga in för att köra automationen.");
  if (resolved.response) return resolved.response;
  const id = contentAutomationRuleIdSchema.safeParse((await context.params).id);
  if (!id.success) return NextResponse.json({ error: "Ogiltigt automations-id." }, { status: 400 });
  const body = await readJson(request);
  const payload = contentAutomationManualRunInputSchema.safeParse(body);
  if (!payload.success) {
    return NextResponse.json({ error: "Skicka ett giltigt idempotensnyckelvärde för körningen." }, { status: 400 });
  }

  try {
    const prepared = await createStudioManualAutomationJob(resolved.actor, {
      automationId: id.data,
      idempotencyKey: payload.data.idempotencyKey,
    });
    if (!prepared) return NextResponse.json({ error: "Automationen hittades inte." }, { status: 404 });

      const job = prepared.job;
      const draft = job.contentDraftId
        ? await getStudioDraft(resolved.actor, job.contentDraftId)
        : null;
      if (draft) {
        return NextResponse.json({
          status: "draft_created",
          automation: prepared.rule,
          job,
          draft,
          message: prepared.reused ? "Det här utkastet skapades redan av samma körning." : "Utkastet är klart att redigera.",
        }, { status: 201, headers: { "cache-control": "no-store" } });
      }
      if (job.state === "failed" || job.state === "cancelled") {
        return NextResponse.json({
          status: "failed",
          automation: prepared.rule,
          job,
          draft: null,
          message: job.lastError ?? "Körningen kunde inte slutföras.",
        }, { status: 502, headers: { "cache-control": "no-store" } });
      }

      // Claim the precise manual receipt rather than running the global cron
      // queue. A user clicking “Kör nu” must never generate another rule's
      // content just because it happened to be due first.
      const claim = await claimStudioManualAutomationJob(resolved.actor, {
        automationId: id.data,
        idempotencyKey: payload.data.idempotencyKey,
        workerId: "studio-manual",
      });
      if (claim) {
        const outcome = await processNeonStudioAutomationClaim(claim);
        if (outcome.status === "draft_created" && outcome.draftId) {
          const created = await getStudioDraft(resolved.actor, outcome.draftId);
          if (created) {
            return NextResponse.json({
              status: "draft_created",
              automation: prepared.rule,
              job: { ...job, state: "completed", contentDraftId: created.id },
              draft: created,
              message: "Ett privat utkast är klart. Det är inte schemalagt eller publicerat.",
            }, { status: 201, headers: { "cache-control": "no-store" } });
          }
        }
        if (outcome.status === "retry_scheduled" || outcome.status === "failed") {
          return NextResponse.json({
            status: "failed",
            automation: prepared.rule,
            job,
            draft: null,
            message: outcome.status === "retry_scheduled"
              ? "AI-tjänsten svarade tillfälligt fel. Samma körning kan försökas igen utan dubbelt utkast."
              : "Utkastet kunde inte skapas. Kontrollera automationens innehåll och försök igen.",
          }, { status: outcome.status === "retry_scheduled" ? 503 : 502, headers: { "cache-control": "no-store" } });
        }
      }
      const retryAt = Date.parse(job.scheduledFor);
      if (job.state === "queued" && Number.isFinite(retryAt) && retryAt > Date.now()) {
        return NextResponse.json({
          status: "failed",
          automation: prepared.rule,
          job,
          draft: null,
          message: "Samma körning väntar på ett säkert nytt försök. Försök igen om en liten stund — ett nytt utkast skapas inte.",
        }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      return NextResponse.json({
        status: "processing",
        automation: prepared.rule,
        job,
        draft: null,
        message: "Samma körning behandlas redan. Den skapar bara ett privat utkast och publicerar inget.",
      }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte lägga automationen i kön.");
  }
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
