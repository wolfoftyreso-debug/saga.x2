import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveSagaQuarterlyActivityPlanSlots,
  deriveSagaQuarterlyBatchActionability,
  sagaQuarterlyActivityPlanInputSchema,
  sagaQuarterlyBatchAbandonSchema,
  sagaQuarterlyBatchMaterializeSchema,
  sagaQuarterlyBatchResubmitSchema,
} from "@/lib/domain/saga-quarterly-planning";

const migration = readFileSync(resolve(process.cwd(), "db/migrations/202608260023_neon_saga_quarterly_activity_plans.sql"), "utf8");
const repository = readFileSync(resolve(process.cwd(), "lib/neon/saga-quarterly-planning-repository.ts"), "utf8");
const worker = readFileSync(resolve(process.cwd(), "lib/neon/saga-quarterly-planning-worker.ts"), "utf8");
const calendar = readFileSync(resolve(process.cwd(), "lib/neon/studio-content-repository.ts"), "utf8");
const materializeRoute = readFileSync(resolve(process.cwd(), "app/api/saga/quarterly-plans/[brandProfileId]/batches/[batchId]/materialize/route.ts"), "utf8");
const abandonRoute = readFileSync(resolve(process.cwd(), "app/api/saga/quarterly-plans/[brandProfileId]/batches/[batchId]/abandon/route.ts"), "utf8");

const plan = {
  name: "Rullande 13-veckorsplan",
  horizonStartDate: "2026-08-24",
  timezone: "Europe/Stockholm",
  channelPlans: [{
    id: "linkedin-plan",
    channel: "linkedin",
    contentType: "social_post",
    objective: "Hjälpa relevanta beslutsfattare att förstå värdet av välbyggda system.",
    cadence: { unit: "weekly" as const, count: 1, weekdayIds: [1], localTimes: ["09:30"] },
    themes: [{
      id: "systeminsikt",
      title: "System som frigör tid",
      intent: "Visa hur genomtänkta system frigör tid för mänskligt omdöme.",
      contentDirection: "Börja med en konkret vardagssituation och gör nyttan tydlig.",
      approved: true as const,
    }],
    desiredCallToAction: "Berätta vilken återkommande uppgift du vill frigöra först.",
    imageDirection: "Dokumentär naturbild med en liten detalj som knyter an till temat.",
    targetLength: "medium" as const,
  }],
};

describe("quarterly plan contract", () => {
  it("derives a complete 13-week horizon from human-selected cadence and rejects unsupported website batches", () => {
    const parsed = sagaQuarterlyActivityPlanInputSchema.parse(plan);
    const slots = deriveSagaQuarterlyActivityPlanSlots(parsed);
    expect(slots).toHaveLength(13);
    expect(slots[0]).toMatchObject({ weekIndex: 1, plannedLocalDate: "2026-08-24", plannedLocalTime: "09:30", channel: "linkedin" });
    expect(slots.at(-1)).toMatchObject({ weekIndex: 13, plannedLocalDate: "2026-11-16" });
    expect(sagaQuarterlyActivityPlanInputSchema.safeParse({
      ...plan,
      channelPlans: [{ ...plan.channelPlans[0], channel: "website" }],
    }).success).toBe(false);
  });

  it("requires server revision/idempotency data for resume, rework, and terminal recovery", () => {
    expect(sagaQuarterlyBatchMaterializeSchema.safeParse({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      expectedPlanRevision: 1,
      expectedBatchRevision: 1,
    }).success).toBe(true);
    expect(sagaQuarterlyBatchResubmitSchema.safeParse({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      expectedPlanRevision: 1,
      expectedBatchRevision: 1,
      expectedItemRevision: 1,
      expectedDraftRevision: 2,
    }).success).toBe(true);
    expect(sagaQuarterlyBatchAbandonSchema.safeParse({
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      expectedPlanRevision: 1,
      expectedBatchRevision: 1,
      note: "AI Gateway behöver konfigureras innan vi försöker igen.",
    }).success).toBe(true);
  });

  it("keeps desired plan time separate from Studio scheduling and pins final draft to its slot", () => {
    expect(migration).toContain("planned_at timestamptz not null");
    expect(migration).toContain("scheduled_at\n  ) values");
    expect(migration).toContain("null\n  ) returning id into new_draft_id");
    expect(migration).toContain("reviewPlannedLocalDate");
    expect(migration).toContain("saga_quarterly_private_draft_does_not_match_slot");
    expect(migration).toContain("target_draft -> 'channels' <> jsonb_build_array(current_slot_channel)");
    expect(migration).toContain("target_draft ->> 'timezone', '') <> current_slot_timezone");
    expect(worker).toContain("noPublication: true");
    expect(worker).toContain('media: "manual_action_required"');
  });

  it("enforces the 10-item review cap, receipt idempotency, recovery leases, and human review gate", () => {
    expect(migration).toContain("requested_count integer not null check (requested_count between 1 and 10)");
    expect(migration).toContain("job_count integer not null check (job_count between 1 and 10)");
    expect(migration).toContain("saga_quarterly_materialization_already_running");
    expect(migration).toContain("job.attempt_count < job.max_attempt_count");
    expect(migration).toContain("lease_attempts_exhausted");
    expect(migration).toContain("lease_reclaimed");
    expect(migration).toContain("current_batch_state <> 'ready_for_review'");
    expect(migration).toContain("returned_draft_revision");
    expect(migration).toContain("current_draft_revision <= current_returned_draft_revision");
    expect(repository).toContain("materializationReceiptId");
  });

  it("can resume a batch that was created before a browser/network loss without session-scoped state", () => {
    expect(materializeRoute).toContain("prepareSagaQuarterlyActivityPlanBatch");
    expect(materializeRoute).toContain("sagaQuarterlyBatchMaterializeSchema");
    expect(materializeRoute).not.toContain("sessionStorage");
    expect(migration).toContain("if current_batch_state = 'ready_for_review'");
    expect(migration).toContain("if exists (\n    select 1 from saga_quarterly_activity_plan_materialization_receipts receipt");
    expect(migration).toContain("current_batch_state = 'failed' and target_retry_failed");
  });

  it("provides a truthful escape hatch after attempts are exhausted and a real calendar plan_slot overlay", () => {
    expect(migration).toContain("saga_abandon_failed_quarterly_activity_plan_batch");
    expect(migration).toContain("current_batch_state <> 'failed'");
    expect(migration).toContain("state = 'stale'");
    expect(calendar).toContain('kind: "plan_slot"');
    expect(calendar).toContain('editable: false');
    expect(calendar).toContain('calendarLabel: "Planerad aktivitet"');
    expect(abandonRoute).toContain("sagaQuarterlyBatchAbandonSchema");
    expect(abandonRoute).toContain("noPublication: true");
  });

  it("exposes abandonment rather than a dead retry when the durable job budget is exhausted", () => {
    expect(deriveSagaQuarterlyBatchActionability({
      state: "failed",
      retryableJobCount: 0,
      exhaustedJobCount: 1,
      activeProcessingJobCount: 0,
    })).toEqual({
      canMaterialize: false,
      canRetry: false,
      canAbandon: true,
      retryExhausted: true,
    });
  });
});
