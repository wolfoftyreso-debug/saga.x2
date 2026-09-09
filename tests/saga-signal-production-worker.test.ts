import { describe, expect, it, vi } from "vitest";
import {
  SagaSignalProductionDraftGuardError,
  type ClaimedSagaSignalProductionJob,
} from "@/lib/neon/saga-signal-production-repository";
import {
  processClaimedSagaSignalProductionJob,
  qualityInputForSignalDraft,
  runDueSagaSignalProductionWorker,
  signalProductionDraftForClaim,
  type SagaSignalProductionWorkerDependencies,
} from "@/lib/neon/saga-signal-production-worker";
import type { SagaProductionQualityAssessment } from "@/lib/services/saga-production-quality";
import { assessSagaProductionQuality } from "@/lib/services/saga-production-quality";

const NOW = new Date("2026-08-25T08:00:00.000Z");
const CLAIM: ClaimedSagaSignalProductionJob = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  authorUserId: "33333333-3333-4333-8333-333333333333",
  signalCandidateId: "44444444-4444-4444-8444-444444444444",
  claimToken: "55555555-5555-4555-8555-555555555555",
  policyRevision: 2,
  calendarEnabled: true,
  calendarScheduledAt: "2026-08-26T08:00:00.000Z",
  calendarTimezone: "Europe/Stockholm",
  attempts: 1,
  maxAttempts: 3,
  signal: {
    signalKey: "signal-elbil-system",
    topic: "system och elbilar",
    headline: "Nya system kortar vägen från verkstad till vardag",
    summary: "Två oberoende publicister beskriver samma utveckling.",
    editorialAngle: "Vad betyder det när teknik minskar vardagsfriktion?",
    evidenceCount: 2,
    independentSourceCount: 2,
    distinctPublisherCount: 2,
    lastSeenAt: "2026-08-25T07:45:00.000Z",
  },
};

function assessment(overrides: Partial<SagaProductionQualityAssessment> = {}): SagaProductionQualityAssessment {
  return {
    version: "saga-production-quality/v1",
    decision: "approved",
    score: 100,
    findings: [],
    canCreatePrivateDraft: true,
    canEnterCalendar: true,
    canDeliver: false,
    ...overrides,
  };
}

function dependencies(overrides: Partial<SagaSignalProductionWorkerDependencies> = {}): SagaSignalProductionWorkerDependencies {
  return {
    materialize: vi.fn().mockResolvedValue({ qualifiedSignalsScanned: 0, jobsCreated: 0 }),
    cancelStale: vi.fn().mockResolvedValue(0),
    expireLeases: vi.fn().mockResolvedValue(0),
    claim: vi.fn().mockResolvedValue(null),
    assess: vi.fn().mockReturnValue(assessment()),
    createDraft: vi.fn().mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666", calendarWithheld: false, scheduledAt: CLAIM.calendarScheduledAt }),
    complete: vi.fn().mockResolvedValue(true),
    block: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue("retry_scheduled"),
    ...overrides,
  };
}

describe("SAGA qualified signal production worker", () => {
  it("builds an evidence-labelled review handoff instead of pretending an AI article is published", () => {
    const draft = signalProductionDraftForClaim(CLAIM);
    expect(draft.title).toContain("SAGA Research:");
    expect(draft.body).toContain("privat redaktionellt underlag");
    expect(draft.body).toContain("2 underlag från 2 oberoende källor");
    expect(draft.body).toContain("Ingen text, bild eller publicering har skapats utanför arbetsytan");
    expect(draft.imagePrompt).toContain("utan text, logotyp eller watermark");
    // This verifies the real default path, not only a mocked green quality
    // response: a policy that explicitly asks for calendar placement can use
    // it when the signal carries the required independent evidence.
    const defaultQuality = assessSagaProductionQuality(qualityInputForSignalDraft(CLAIM, draft));
    expect(defaultQuality.findings).toEqual([]);
    expect(defaultQuality).toMatchObject({
      decision: "approved",
      canCreatePrivateDraft: true,
      canEnterCalendar: true,
      canDeliver: false,
    });
  });

  it("completes one quality-approved claim as a private review draft and preserves calendar policy state", async () => {
    const deps = dependencies();
    const result = await processClaimedSagaSignalProductionJob(CLAIM, { now: NOW, dependencies: deps });

    expect(result).toMatchObject({
      jobId: CLAIM.id,
      status: "review_draft_created",
      draftId: "66666666-6666-4666-8666-666666666666",
      calendarScheduled: true,
      calendarWithheld: false,
    });
    expect(deps.assess).toHaveBeenCalledWith(expect.objectContaining({
      kind: "content_draft",
      contentType: "article",
      channels: [],
      deliveryIntent: "private_draft",
      claimEvidence: [{ sourceReference: `saga-news-signal:${CLAIM.signalCandidateId}`, verifiedAt: CLAIM.signal.lastSeenAt }],
    }));
    expect(deps.createDraft).toHaveBeenCalledWith(CLAIM, expect.objectContaining({ quality: assessment() }), NOW);
    expect(deps.complete).toHaveBeenCalled();
    expect(deps.block).not.toHaveBeenCalled();
  });

  it("keeps a review-required result private and lets the repository withhold calendar placement", async () => {
    const review = assessment({
      decision: "review_required",
      score: 92,
      findings: [{ code: "readability_needs_review", severity: "warning", field: "body", message: "Dela upp meningarna." }],
      canEnterCalendar: false,
    });
    const deps = dependencies({
      assess: vi.fn().mockReturnValue(review),
      createDraft: vi.fn().mockResolvedValue({ id: "66666666-6666-4666-8666-666666666666", calendarWithheld: true, scheduledAt: null }),
    });

    const result = await processClaimedSagaSignalProductionJob(CLAIM, { now: NOW, dependencies: deps });

    expect(result).toMatchObject({ status: "review_draft_created", calendarScheduled: false, calendarWithheld: true, quality: review });
    expect(deps.block).not.toHaveBeenCalled();
  });

  it("durably blocks a quality rejection before any draft or calendar write", async () => {
    const blocked = assessment({
      decision: "blocked",
      score: 20,
      findings: [{ code: "unsupported_claim_without_evidence", severity: "blocker", field: "body", message: "Underlag saknas." }],
      canCreatePrivateDraft: false,
      canEnterCalendar: false,
    });
    const deps = dependencies({ assess: vi.fn().mockReturnValue(blocked) });

    const result = await processClaimedSagaSignalProductionJob(CLAIM, { now: NOW, dependencies: deps });

    expect(result).toMatchObject({ status: "blocked", code: "production_quality_rejected", quality: blocked });
    expect(deps.block).toHaveBeenCalledWith(CLAIM, blocked, NOW);
    expect(deps.createDraft).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it("records a safe retry receipt when draft persistence fails", async () => {
    const deps = dependencies({ createDraft: vi.fn().mockRejectedValue(new Error("DATABASE_URL=not-for-response")) });

    const result = await processClaimedSagaSignalProductionJob(CLAIM, { now: NOW, dependencies: deps });

    expect(result).toEqual({ jobId: CLAIM.id, status: "retry_scheduled", code: "signal_production_unavailable" });
    expect(deps.fail).toHaveBeenCalledWith(CLAIM, {
      code: "signal_production_unavailable",
      detail: "SAGA kunde inte skapa det privata granskningsutkastet just nu.",
      retry: true,
      retryAfterMs: 120_000,
    }, NOW);
  });

  it("cancels a claimed receipt when the policy or signal changes after its lease but before the draft write", async () => {
    const deps = dependencies({ createDraft: vi.fn().mockRejectedValue(new SagaSignalProductionDraftGuardError()) });

    const result = await processClaimedSagaSignalProductionJob(CLAIM, { now: NOW, dependencies: deps });

    expect(result).toEqual({ jobId: CLAIM.id, status: "cancelled", code: "production_policy_changed" });
    expect(deps.cancel).toHaveBeenCalledWith(CLAIM, NOW);
    expect(deps.fail).not.toHaveBeenCalled();
  });

  it("runs a bounded Cron pass without claiming a second job after the queue is empty", async () => {
    const deps = dependencies({
      materialize: vi.fn().mockResolvedValue({ qualifiedSignalsScanned: 1, jobsCreated: 1 }),
      cancelStale: vi.fn().mockResolvedValue(1),
      expireLeases: vi.fn().mockResolvedValue(2),
      claim: vi.fn().mockResolvedValueOnce(CLAIM).mockResolvedValueOnce(null),
    });

    const result = await runDueSagaSignalProductionWorker({ now: NOW, maxJobs: 3, dependencies: deps });

    expect(result).toMatchObject({
      materialization: { qualifiedSignalsScanned: 1, jobsCreated: 1 },
      staleCancelled: 1,
      leasesExpired: 2,
      jobsClaimed: 1,
      reviewDraftsCreated: 1,
      qualityBlocked: 0,
    });
    expect(deps.claim).toHaveBeenCalledTimes(2);
  });
});
