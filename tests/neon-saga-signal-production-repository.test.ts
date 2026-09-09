import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  createPrivateSagaSignalProductionDraft,
  failSagaSignalProductionJob,
  materializeSagaSignalProductionJobs,
  saveSagaSignalProductionPolicy,
  SagaSignalProductionDraftGuardError,
  type ClaimedSagaSignalProductionJob,
} from "@/lib/neon/saga-signal-production-repository";
import { StudioContentAccessError } from "@/lib/neon/studio-content-repository";
import type { SagaProductionQualityAssessment } from "@/lib/services/saga-production-quality";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: null,
  displayName: null,
};
const now = new Date("2026-08-25T08:00:00.000Z");

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

function claim(): ClaimedSagaSignalProductionJob {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    workspaceId: actor.workspaceId,
    authorUserId: actor.userId,
    signalCandidateId: "44444444-4444-4444-8444-444444444444",
    claimToken: "55555555-5555-4555-8555-555555555555",
    policyRevision: 1,
    calendarEnabled: true,
    calendarScheduledAt: "2026-08-26T08:00:00.000Z",
    calendarTimezone: "Europe/Stockholm",
    attempts: 1,
    maxAttempts: 3,
    signal: {
      signalKey: "signal-system",
      topic: "system",
      headline: "System minskar friktion",
      summary: "Två publicister beskriver samma mönster.",
      editorialAngle: "Vad kan vi lära av det?",
      evidenceCount: 2,
      independentSourceCount: 2,
      distinctPublisherCount: 2,
      lastSeenAt: "2026-08-25T07:00:00.000Z",
    },
  };
}

const quality: SagaProductionQualityAssessment = {
  version: "saga-production-quality/v1",
  decision: "approved",
  score: 100,
  findings: [],
  canCreatePrivateDraft: true,
  canEnterCalendar: true,
  canDeliver: false,
};

const draft = {
  title: "SAGA Research: System minskar friktion",
  headline: "System minskar friktion",
  body: "Det här är ett privat underlag med tillräckligt många ord för att bära en redaktionell granskning innan något kan lämna arbetsytan.",
  excerpt: "Privat redaktionellt underlag.",
  cta: "Granska underlaget.",
  imagePrompt: "Trygg redaktionell bild utan text, logotyp eller watermark.",
  quality,
};

describe("Neon SAGA signal production bridge", () => {
  it("ships a Vercel/Neon-only opt-in receipt with no provider credential or delivery table", () => {
    const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608250014_neon_saga_signal_production.sql"), "utf8");
    expect(migration).toContain("create table if not exists saga_signal_production_policies");
    expect(migration).toContain("create table if not exists saga_signal_production_jobs");
    expect(migration).toContain("enabled boolean not null default false");
    expect(migration).toContain("run_after timestamptz not null default now()");
    expect(migration).toContain("studio_drafts_saga_signal_production_job_idx");
    expect(migration.toLowerCase()).not.toContain("supabase");
    expect(migration.toLowerCase()).not.toContain("api_key");
    expect(migration.toLowerCase()).not.toContain("publish_attempt");
  });

  it("requires a signed editor to save the explicit production opt-in", async () => {
    const { sql, query } = sqlWith([{
      workspace_id: actor.workspaceId,
      enabled: true,
      calendar_enabled: false,
      calendar_delay_minutes: 1440,
      timezone: "Europe/Stockholm",
      max_drafts_per_tick: 2,
      revision: 1,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }]);
    const saved = await saveSagaSignalProductionPolicy(actor, {
      enabled: true,
      calendarEnabled: false,
      calendarDelayMinutes: 1440,
      timezone: "Europe/Stockholm",
      maxDraftsPerTick: 2,
    }, sql);

    expect(saved).toMatchObject({ enabled: true, calendarEnabled: false, revision: 1 });
    expect(query.mock.calls[0]?.[0]).toContain("on conflict (workspace_id) do update");
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([actor.workspaceId, actor.userId, true]));
    await expect(saveSagaSignalProductionPolicy({ ...actor, role: "viewer" }, { enabled: true }, sql)).rejects.toBeInstanceOf(StudioContentAccessError);
  });

  it("materializes only active qualified signals under an enabled policy and uses a durable conflict key", async () => {
    const { sql, query } = sqlWith([{ scanned: 2, inserted: 1 }]);
    const result = await materializeSagaSignalProductionJobs({ now, limit: 10 }, sql);

    expect(result).toEqual({ qualifiedSignalsScanned: 2, jobsCreated: 1 });
    const statement = query.mock.calls[0]?.[0] as string;
    expect(statement).toContain("policy.enabled = true");
    expect(statement).toContain("candidate.state = 'qualified'");
    expect(statement).toContain("on conflict (workspace_id, signal_candidate_id) do nothing");
    expect(statement).toContain("calendar_delay_minutes");
  });

  it("guards the final Studio draft insert with the live claim token, policy revision and qualified signal", async () => {
    const { sql, query } = sqlWith([], [], [], []);

    await expect(createPrivateSagaSignalProductionDraft(claim(), draft, now, sql)).rejects.toBeInstanceOf(SagaSignalProductionDraftGuardError);

    const statement = query.mock.calls[1]?.[0] as string;
    expect(statement).toContain("job.claim_token = $10::uuid");
    expect(statement).toContain("policy.enabled = true");
    expect(statement).toContain("policy.revision = job.policy_revision");
    expect(statement).toContain("signal.state = 'qualified'");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([claim().id, claim().claimToken]));
  });

  it("releases retryable work at run_after rather than rewriting the durable creation timestamp", async () => {
    const { sql, query } = sqlWith([{ state: "queued" }]);
    const result = await failSagaSignalProductionJob(claim(), {
      code: "signal_production_unavailable",
      detail: "SAGA kunde inte skapa det privata granskningsutkastet just nu.",
      retry: true,
      retryAfterMs: 120_000,
    }, now, sql);

    expect(result).toBe("retry_scheduled");
    const statement = query.mock.calls[0]?.[0] as string;
    expect(statement).toContain("run_after = case when");
    expect(statement).not.toContain("created_at = case when");
  });
});
