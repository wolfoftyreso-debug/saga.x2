import "server-only";

import type { AdAutomationWorkflow } from "@/lib/domain/ad-automation";
import { assertSagaCreativeBriefCanGenerate } from "@/lib/services/saga-creative-safety";
import {
  assessAdAutomationPrivateDraftQuality,
  SagaProductionQualityError,
} from "@/lib/services/saga-production-quality";
import type { NeonSql } from "@/lib/neon/database";

export type PrivateAdAutomationDraft = {
  id: string;
  title: string;
  status: "draft";
  scheduledAt: null;
};

export type CreatePrivateAdAutomationDraftInput = {
  workspaceId: string;
  authorUserId: string;
  automationId: string;
  automationName: string;
  workflow: AdAutomationWorkflow;
  /** Exactly one durable source owns the draft's idempotency boundary. */
  source: { kind: "scheduled_run"; id: string } | { kind: "manual_test"; id: string };
  /**
   * Scheduled receipts must still point at the active workflow revision at
   * the exact database write. Manual tests intentionally do not need this.
   */
  scheduledGuard?: { workflowRevision: number };
};

export class AdAutomationDraftGuardError extends Error {
  constructor() {
    super("Annonsflödet pausades, ändrades eller togs bort innan det privata utkastet kunde skapas.");
    this.name = "AdAutomationDraftGuardError";
  }
}

type DraftRow = {
  id: string;
  title: string;
  status: string;
  scheduled_at: string | null;
};

/**
 * Produces a deterministic, editor-ready creative brief — it does not call an
 * AI model. This narrow output makes the draft-first promise auditable while a
 * later Gateway generation pass can be added behind the same safety boundary.
 */
export async function createPrivateAdAutomationDraft(
  input: CreatePrivateAdAutomationDraftInput,
  sql: NeonSql,
): Promise<PrivateAdAutomationDraft> {
  const assessment = assertSagaCreativeBriefCanGenerate(input.workflow.creative.creativeBrief);
  const quality = assessAdAutomationPrivateDraftQuality(input.automationName, input.workflow.creative.creativeBrief);
  if (!quality.canCreatePrivateDraft) {
    throw new SagaProductionQualityError(
      quality.findings.find((finding) => finding.severity === "blocker")?.message
        ?? "Annonsunderlaget klarade inte SAGA:s produktionskvalitet.",
      quality,
    );
  }
  const metadataKey = input.source.kind === "scheduled_run" ? "adAutomationRunId" : "adAutomationTestReceiptId";
  const existing = await findExistingDraft(sql, input.workspaceId, metadataKey, input.source.id);
  if (existing) return mapDraft(existing);

  const title = `Annonsutkast: ${input.automationName}`.slice(0, 240);
  const body = deterministicCreativeBriefBody(input.automationName, input.workflow, assessment.publishable);
  const metadata = JSON.stringify({
    adAutomationId: input.automationId,
    [metadataKey]: input.source.id,
    adAutomationDraftKind: "deterministic_creative_brief",
    // Server-owned invariant consumed by the generic draft repository. It
    // keeps this output private even if it is later opened in the Studio UI.
    adAutomationDeliveryLocked: true,
    adAutomationOrigin: "private_draft_only",
    adAutomationSafety: {
      draftAllowed: assessment.draftAllowed,
      publishable: assessment.publishable,
      violations: assessment.violations.map((violation) => ({ code: violation.code, field: violation.field })),
    },
    adAutomationQuality: quality,
    approvalRequired: true,
    language: "sv",
    timezone: input.workflow.schedule.timezone,
  });
  const inserted = await sql.query(
    input.scheduledGuard
      ? `insert into studio_drafts (
           workspace_id, author_user_id, content_type, status, title, body, excerpt,
           publication_channels, metadata, scheduled_at
         ) select
           $1::uuid, $2::uuid, 'article', 'draft', $3, $4, null,
           '[]'::jsonb, $5::jsonb, null
         from studio_ad_automations as current
         where current.workspace_id = $1::uuid
           and current.id = $6::uuid
           and current.active = true
           and current.revision = $7::integer
         on conflict do nothing
         returning id::text, title, status, scheduled_at::text`
      : `insert into studio_drafts (
           workspace_id, author_user_id, content_type, status, title, body, excerpt,
           publication_channels, metadata, scheduled_at
         ) values (
           $1::uuid, $2::uuid, 'article', 'draft', $3, $4, null,
           '[]'::jsonb, $5::jsonb, null
         ) on conflict do nothing
         returning id::text, title, status, scheduled_at::text`,
    input.scheduledGuard
      ? [input.workspaceId, input.authorUserId, title, body, metadata, input.automationId, input.scheduledGuard.workflowRevision]
      : [input.workspaceId, input.authorUserId, title, body, metadata],
  ) as unknown as DraftRow[];
  const created = inserted[0];
  if (created) return mapDraft(created);

  // A retry may race immediately after another Vercel invocation created the
  // row. The unique metadata expression index from migration 010 makes this
  // re-read the sole private draft instead of creating another one.
  const afterConflict = await findExistingDraft(sql, input.workspaceId, metadataKey, input.source.id);
  if (!afterConflict && input.scheduledGuard) {
    const stillCurrent = await isCurrentScheduledAutomation(
      sql,
      input.workspaceId,
      input.automationId,
      input.scheduledGuard.workflowRevision,
    );
    if (!stillCurrent) throw new AdAutomationDraftGuardError();
  }
  if (!afterConflict) throw new Error("Det privata annonsutkastet kunde inte sparas.");
  return mapDraft(afterConflict);
}

async function isCurrentScheduledAutomation(
  sql: NeonSql,
  workspaceId: string,
  automationId: string,
  workflowRevision: number,
): Promise<boolean> {
  const rows = await sql.query(
    `select id::text
       from studio_ad_automations
      where workspace_id = $1::uuid
        and id = $2::uuid
        and active = true
        and revision = $3::integer
      limit 1`,
    [workspaceId, automationId, workflowRevision],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

async function findExistingDraft(
  sql: NeonSql,
  workspaceId: string,
  metadataKey: "adAutomationRunId" | "adAutomationTestReceiptId",
  sourceId: string,
): Promise<DraftRow | null> {
  // The key name is fixed by this module, never controlled by a request.
  const rows = await sql.query(
    `select id::text, title, status, scheduled_at::text
       from studio_drafts
      where workspace_id = $1::uuid
        and metadata ->> '${metadataKey}' = $2::text
      limit 1`,
    [workspaceId, sourceId],
  ) as unknown as DraftRow[];
  return rows[0] ?? null;
}

function mapDraft(row: DraftRow): PrivateAdAutomationDraft {
  if (row.status !== "draft" || row.scheduled_at !== null) {
    throw new Error("Annonsflödet får bara skapa privata, oschemalagda utkast.");
  }
  return { id: row.id, title: row.title, status: "draft", scheduledAt: null };
}

function deterministicCreativeBriefBody(
  automationName: string,
  workflow: AdAutomationWorkflow,
  publishable: boolean,
): string {
  const brief = workflow.creative.creativeBrief;
  const offerState = publishable
    ? "Verifierat erbjudande i underlaget. Publicering är ändå inte tillgänglig från detta flöde."
    : "Erbjudandet är ett arbetsunderlag och får inte publiceras förrän det verifierats. Ingen extern leverans är tillgänglig från detta flöde.";
  const destinations = workflow.destinations
    .map((destination) => `- ${destination.label} (${destination.provider}) — förbereds endast, ingen extern leverans`)
    .join("\n");

  return [
    `# ${automationName}`,
    "",
    "Detta är ett deterministiskt kreativt underlag från SAGA — ingen AI-copy eller annons har skickats.",
    "",
    "## Hook",
    brief.hook,
    "",
    "## Värde",
    brief.value,
    "",
    "## Erbjudande",
    brief.offer.copy,
    brief.offer.terms || "Inga villkor angivna.",
    "",
    "## CTA",
    brief.callToAction,
    "",
    "## Visuell riktning",
    brief.customVisualDirection || `Säker metafor: ${brief.visualMetaphor}.`,
    "",
    "## Avsiktliga destinationer",
    destinations,
    "",
    offerState,
  ].join("\n");
}
