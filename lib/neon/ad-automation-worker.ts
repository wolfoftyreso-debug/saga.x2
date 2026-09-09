import "server-only";

import { randomUUID } from "node:crypto";

import { adAutomationInputSchema, adAutomationWorkflowSchema, type AdAutomationWorkflow } from "@/lib/domain/ad-automation";
import { upcomingAdAutomationOccurrences } from "@/lib/domain/ad-automation-schedule";
import {
  AdAutomationDraftGuardError,
  createPrivateAdAutomationDraft,
  type PrivateAdAutomationDraft,
} from "@/lib/neon/ad-automation-draft";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { assertSagaCreativeBriefCanGenerate } from "@/lib/services/saga-creative-safety";
import { SagaProductionQualityError } from "@/lib/services/saga-production-quality";

const MAX_AUTOMATIONS_PER_TICK = 20;
const MAX_RUNS_PER_TICK = 3;
const DEFAULT_HORIZON_DAYS = 14;
const DEFAULT_LEASE_MS = 2 * 60 * 1_000;
const DEFAULT_TIME_BUDGET_MS = 45_000;
const MIN_TIME_BUDGET_MS = 5_000;
const MAX_TIME_BUDGET_MS = 50_000;
const MAX_CLAIM_CANDIDATES = 120;
const MATERIALIZATION_CURSOR_KEY = "saga_ad_automation_materialization_v1";
const CLAIM_CURSOR_KEY = "saga_ad_automation_claim_v1";

type ActiveAutomationRow = {
  id: string;
  workspace_id: string;
  created_by_user_id: string;
  name: string;
  active: boolean;
  revision: number | string;
  workflow: unknown;
};

type ClaimedRunRow = {
  id: string;
  workspace_id: string;
  automation_id: string;
  workflow_revision: number | string;
  scheduled_for: string;
  claim_token: string;
};

export type ClaimedAdAutomation = {
  id: string;
  workspaceId: string;
  authorUserId: string;
  name: string;
  revision: number;
  workflow: AdAutomationWorkflow;
};

export type ClaimedAdAutomationRun = ClaimedRunRow & { automation: ClaimedAdAutomation };

export type AdAutomationMaterializationResult = {
  automationsScanned: number;
  runsCreated: number;
  nextRunsUpdated: number;
  unsafeFlowsSkipped: number;
};

export type AdAutomationWorkerRunResult = {
  runId: string;
  status: "draft_created" | "failed" | "cancelled" | "lease_lost";
  draftId?: string;
  code?: string;
};

export type AdAutomationWorkerResult = {
  materialization: AdAutomationMaterializationResult;
  runsClaimed: number;
  draftsCreated: number;
  failuresRecorded: number;
  leasesLost: number;
  timeBudgetReached: boolean;
  runs: AdAutomationWorkerRunResult[];
};

/**
 * Dedicated ad scheduler. It never calls the generic Studio worker, an AI
 * model, an ad platform, a social provider, RSS, or a newsletter provider.
 * Its only side effect is one deterministic private Studio draft per receipt.
 */
export async function runDueAdAutomationWorker(
  options: {
    now?: Date;
    maxRuns?: number;
    automationLimit?: number;
    horizonDays?: number;
    /** Stops before a new lease if the bounded Vercel tick is nearly spent. */
    timeBudgetMs?: number;
    workerId?: string;
    sql?: NeonSql;
  } = {},
): Promise<AdAutomationWorkerResult> {
  const now = options.now ?? new Date();
  const sql = options.sql ?? createNeonSql();
  const timeBudgetMs = bounded(options.timeBudgetMs, DEFAULT_TIME_BUDGET_MS, MIN_TIME_BUDGET_MS, MAX_TIME_BUDGET_MS);
  const startedAt = Date.now();
  const materialization = await materializeAdAutomationRuns({
    now,
    automationLimit: bounded(options.automationLimit, MAX_AUTOMATIONS_PER_TICK, 1, MAX_AUTOMATIONS_PER_TICK),
    horizonDays: bounded(options.horizonDays, DEFAULT_HORIZON_DAYS, 1, 31),
    sql,
  });
  const result: AdAutomationWorkerResult = {
    materialization,
    runsClaimed: 0,
    draftsCreated: 0,
    failuresRecorded: 0,
    leasesLost: 0,
    timeBudgetReached: false,
    runs: [],
  };
  const maxRuns = bounded(options.maxRuns, MAX_RUNS_PER_TICK, 1, MAX_RUNS_PER_TICK);
  const workerId = options.workerId?.trim().slice(0, 160) || "vercel-ad-automation";
  await expireExhaustedAdAutomationLeases(now, sql);

  for (let index = 0; index < maxRuns; index += 1) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      result.timeBudgetReached = true;
      break;
    }
    const claim = await claimDueAdAutomationRun(now, workerId, sql);
    if (!claim) break;
    result.runsClaimed += 1;
    const outcome = await processClaimedAdAutomationRun(claim, { now, sql });
    result.runs.push(outcome);
    if (outcome.status === "draft_created") result.draftsCreated += 1;
    else if (outcome.status === "failed") result.failuresRecorded += 1;
    else if (outcome.status === "lease_lost") result.leasesLost += 1;
  }
  return result;
}

/** Materializes bounded, revision-scoped future receipts without provider calls. */
export async function materializeAdAutomationRuns(input: {
  now?: Date;
  automationLimit?: number;
  horizonDays?: number;
  sql?: NeonSql;
}): Promise<AdAutomationMaterializationResult> {
  const now = input.now ?? new Date();
  const sql = input.sql ?? createNeonSql();
  const limit = bounded(input.automationLimit, MAX_AUTOMATIONS_PER_TICK, 1, MAX_AUTOMATIONS_PER_TICK);
  const horizonDays = bounded(input.horizonDays, DEFAULT_HORIZON_DAYS, 1, 31);
  await ensureAdAutomationSchedulerCursor(MATERIALIZATION_CURSOR_KEY, sql);
  const rows = await sql.query(
    // At most one workflow per workspace per tick prevents a busy tenant from
    // consuming the bounded Vercel cron scan. The cursor advances atomically
    // within this statement, so low UUID workspaces cannot starve later ones.
    `with locked_cursor as (
       select last_workspace_id
         from studio_ad_automation_scheduler_cursors
        where scheduler_key = $2
        for update
     ), workspace_candidates as (
       select id, workspace_id, created_by_user_id, name, active, revision, workflow,
              row_number() over (
                partition by workspace_id
                order by next_run_at asc nulls first, updated_at asc, id asc
              ) as workspace_rank
         from studio_ad_automations
        where active = true
     ), eligible as (
       select workspace_candidates.*, locked_cursor.last_workspace_id
         from workspace_candidates
         cross join locked_cursor
        where workspace_rank = 1
     ), ordered as (
       select eligible.*,
              row_number() over (
                order by case when last_workspace_id is null or workspace_id > last_workspace_id then 0 else 1 end,
                         workspace_id asc
              ) as round_robin_rank
         from eligible
     ), candidates as (
       select *
         from ordered
        where round_robin_rank <= $1::int
     ), advance_cursor as (
       update studio_ad_automation_scheduler_cursors as cursor
          set last_workspace_id = (
                select workspace_id
                  from candidates
                 order by round_robin_rank desc
                 limit 1
              ),
              updated_at = now()
        where cursor.scheduler_key = $2
          and exists (select 1 from candidates)
       returning cursor.scheduler_key
     )
     select id::text, workspace_id::text, created_by_user_id::text, name, active, revision, workflow
       from candidates
      where exists (select 1 from advance_cursor)
      order by round_robin_rank asc`,
    [limit, MATERIALIZATION_CURSOR_KEY],
  ) as unknown as ActiveAutomationRow[];

  const result: AdAutomationMaterializationResult = {
    automationsScanned: 0,
    runsCreated: 0,
    nextRunsUpdated: 0,
    unsafeFlowsSkipped: 0,
  };
  for (const row of rows) {
    result.automationsScanned += 1;
    const parsed = adAutomationInputSchema.safeParse({ name: row.name, active: row.active, workflow: row.workflow });
    if (!parsed.success) {
      result.unsafeFlowsSkipped += 1;
      continue;
    }
    try {
      assertSagaCreativeBriefCanGenerate(parsed.data.workflow.creative.creativeBrief);
    } catch {
      result.unsafeFlowsSkipped += 1;
      continue;
    }
    const occurrences = upcomingAdAutomationOccurrences(parsed.data.workflow, { now, horizonDays });
    for (const occurrence of occurrences) {
      const inserted = await sql.query(
        `insert into studio_ad_automation_runs (
           workspace_id, automation_id, workflow_revision, scheduled_for,
           scheduled_local_date, scheduled_local_time, timezone, state
         ) values (
           $1::uuid, $2::uuid, $3::integer, $4::timestamptz,
           $5::date, $6::time, $7, 'queued'
         ) on conflict (workspace_id, automation_id, workflow_revision, scheduled_for) do nothing
         returning id::text`,
        [row.workspace_id, row.id, Number(row.revision), occurrence.runAt, occurrence.localDate, occurrence.localTime, parsed.data.workflow.schedule.timezone],
      ) as unknown as Array<{ id: string }>;
      result.runsCreated += inserted.length;
    }
    await sql.query(
      `update studio_ad_automations
          set next_run_at = $3::timestamptz
        where workspace_id = $1::uuid and id = $2::uuid and revision = $4::integer`,
      [row.workspace_id, row.id, occurrences[0]?.runAt ?? null, Number(row.revision)],
    );
    result.nextRunsUpdated += 1;
  }
  return result;
}

/** Leases one revision-matching receipt. A stale workflow cannot generate a draft. */
export async function claimDueAdAutomationRun(
  now: Date,
  workerId: string,
  sql: NeonSql,
): Promise<ClaimedAdAutomationRun | null> {
  const claimToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + DEFAULT_LEASE_MS).toISOString();
  await ensureAdAutomationSchedulerCursor(CLAIM_CURSOR_KEY, sql);
  const rows = await sql.query(
    `with locked_cursor as (
       select last_workspace_id
         from studio_ad_automation_scheduler_cursors
        where scheduler_key = $5
        for update
     ), due_runs as (
       select run.id, run.workspace_id, run.scheduled_for, run.created_at
         from studio_ad_automation_runs as run
         join studio_ad_automations as automation
           on automation.workspace_id = run.workspace_id
          and automation.id = run.automation_id
        where (run.state = 'queued' or (
                run.state = 'running'
            and coalesce(run.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
            and run.attempts < run.max_attempts
          ))
          and run.scheduled_for <= $1::timestamptz
          and automation.active = true
          and automation.revision = run.workflow_revision
     ), per_workspace as (
       -- Rank every due workspace before applying the bounded pool. A noisy
       -- tenant therefore contributes only its oldest receipt to this round.
       select due_runs.*,
              row_number() over (
                partition by workspace_id
                order by scheduled_for asc, created_at asc, id asc
              ) as workspace_rank
         from due_runs
     ), one_per_workspace as (
       select * from per_workspace where workspace_rank = 1
     ), ordered as (
       select one_per_workspace.*, locked_cursor.last_workspace_id,
              row_number() over (
                order by case when last_workspace_id is null or workspace_id > last_workspace_id then 0 else 1 end,
                         workspace_id asc
              ) as round_robin_rank
         from one_per_workspace
         cross join locked_cursor
     ), candidate_pool as (
       select * from ordered where round_robin_rank <= $6::int
     ), locked_candidates as (
       select run.id, candidate_pool.workspace_id, candidate_pool.round_robin_rank
         from studio_ad_automation_runs as run
         join candidate_pool on candidate_pool.id = run.id
         join studio_ad_automations as automation
           on automation.workspace_id = run.workspace_id
          and automation.id = run.automation_id
        where (run.state = 'queued' or (
                run.state = 'running'
            and coalesce(run.lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
            and run.attempts < run.max_attempts
          ))
          and run.scheduled_for <= $1::timestamptz
          and automation.active = true
          and automation.revision = run.workflow_revision
        order by candidate_pool.round_robin_rank asc
        for update of run skip locked
     ), candidate as (
       select * from locked_candidates order by round_robin_rank asc limit 1
     ), advance_cursor as (
       update studio_ad_automation_scheduler_cursors as cursor
          set last_workspace_id = (select workspace_id from candidate),
              updated_at = now()
        where cursor.scheduler_key = $5
          and exists (select 1 from candidate)
       returning cursor.scheduler_key
     )
     update studio_ad_automation_runs as claimed
        set state = 'running',
            claim_token = $2::uuid,
            claimed_by = $3,
            claimed_at = $1::timestamptz,
            lease_expires_at = $4::timestamptz,
            attempts = claimed.attempts + 1,
            failure_code = null,
            failure_detail = null
      where claimed.id = (select id from candidate)
        and exists (select 1 from advance_cursor)
      returning id::text, workspace_id::text, automation_id::text, workflow_revision,
                scheduled_for::text, claim_token::text`,
    [now.toISOString(), claimToken, workerId, leaseUntil, CLAIM_CURSOR_KEY, MAX_CLAIM_CANDIDATES],
  ) as unknown as ClaimedRunRow[];
  const claim = rows[0];
  if (!claim) return null;
  const automationRows = await sql.query(
    `select id::text, workspace_id::text, created_by_user_id::text, name, revision, workflow
       from studio_ad_automations
      where workspace_id = $1::uuid
        and id = $2::uuid
        and active = true
        and revision = $3::integer
      limit 1`,
    [claim.workspace_id, claim.automation_id, Number(claim.workflow_revision)],
  ) as unknown as ActiveAutomationRow[];
  const automationRow = automationRows[0];
  if (!automationRow) {
    await cancelClaimedAdAutomationRun(claim, now, sql);
    return null;
  }
  const parsed = adAutomationInputSchema.safeParse({
    name: automationRow.name,
    active: true,
    workflow: automationRow.workflow,
  });
  if (!parsed.success) {
    await cancelClaimedAdAutomationRun(claim, now, sql);
    return null;
  }
  try {
    assertSagaCreativeBriefCanGenerate(parsed.data.workflow.creative.creativeBrief);
  } catch {
    await cancelClaimedAdAutomationRun(claim, now, sql);
    return null;
  }
  const workflow = adAutomationWorkflowSchema.parse(parsed.data.workflow);
  return {
    ...claim,
    automation: {
      id: automationRow.id,
      workspaceId: automationRow.workspace_id,
      authorUserId: automationRow.created_by_user_id,
      name: automationRow.name,
      revision: Number(automationRow.revision),
      workflow,
    },
  };
}

/** Re-checks the creative before the only draft write. */
export async function processClaimedAdAutomationRun(
  claim: ClaimedAdAutomationRun,
  input: { now?: Date; sql: NeonSql },
): Promise<AdAutomationWorkerRunResult> {
  const now = input.now ?? new Date();
  try {
    assertSagaCreativeBriefCanGenerate(claim.automation.workflow.creative.creativeBrief);
    const draft = await createPrivateAdAutomationDraft({
      workspaceId: claim.automation.workspaceId,
      authorUserId: claim.automation.authorUserId,
      automationId: claim.automation.id,
      automationName: claim.automation.name,
      workflow: claim.automation.workflow,
      source: { kind: "scheduled_run", id: claim.id },
      scheduledGuard: { workflowRevision: claim.automation.revision },
    }, input.sql);
    const completed = await input.sql.query(
      `update studio_ad_automation_runs
          set state = 'completed', draft_id = $3::uuid, completed_at = $4::timestamptz,
              claim_token = null, claimed_by = null
              , lease_expires_at = null
        where id = $1::uuid and claim_token = $2::uuid and state = 'running'
        returning id::text`,
      [claim.id, claim.claim_token, draft.id, now.toISOString()],
    ) as unknown as Array<{ id: string }>;
    return completed[0]
      ? { runId: claim.id, status: "draft_created", draftId: draft.id }
      : { runId: claim.id, status: "lease_lost" };
  } catch (error) {
    if (error instanceof AdAutomationDraftGuardError) {
      await cancelClaimedAdAutomationRun(claim, now, input.sql);
      return { runId: claim.id, status: "cancelled", code: "automation_reconfigured" };
    }
    const code = error instanceof SagaProductionQualityError
      ? "production_quality_rejected"
      : error instanceof Error && error.name === "SagaCreativeSafetyError"
        ? "creative_safety_rejected"
        : "ad_draft_materialization_failed";
    const failed = await input.sql.query(
      `update studio_ad_automation_runs
          set state = 'failed', completed_at = $3::timestamptz, claim_token = null,
              claimed_by = null, lease_expires_at = null, failure_code = $4, failure_detail = $5
        where id = $1::uuid and claim_token = $2::uuid and state = 'running'
        returning id::text`,
      [claim.id, claim.claim_token, now.toISOString(), code, error instanceof Error ? error.message.slice(0, 1_000) : "Kunde inte skapa privat annonsutkast."],
    ) as unknown as Array<{ id: string }>;
    return failed[0]
      ? { runId: claim.id, status: "failed", code }
      : { runId: claim.id, status: "lease_lost" };
  }
}

async function cancelClaimedAdAutomationRun(claim: ClaimedRunRow, now: Date, sql: NeonSql): Promise<void> {
  await sql.query(
    `update studio_ad_automation_runs
        set state = 'cancelled', completed_at = $3::timestamptz, claim_token = null,
            claimed_by = null, lease_expires_at = null, failure_code = 'automation_reconfigured',
            failure_detail = 'Annonsflödet ändrades eller pausades innan körningen startade.'
      where id = $1::uuid and claim_token = $2::uuid and state = 'running'`,
    [claim.id, claim.claim_token, now.toISOString()],
  );
}

/** Terminally records a lease that exhausted its retry budget before a new claim. */
async function expireExhaustedAdAutomationLeases(now: Date, sql: NeonSql): Promise<void> {
  await sql.query(
    `update studio_ad_automation_runs
        set state = 'failed', completed_at = $1::timestamptz,
            claim_token = null, claimed_by = null, lease_expires_at = null,
            failure_code = 'lease_exhausted',
            failure_detail = 'En tidigare arbetskörning avslutades inte innan lease-tiden gick ut.'
      where state = 'running'
        and coalesce(lease_expires_at, '-infinity'::timestamptz) < $1::timestamptz
        and attempts >= max_attempts`,
    [now.toISOString()],
  );
}

/** Ensures the cursor row exists before the following fair-selection statement locks it. */
async function ensureAdAutomationSchedulerCursor(schedulerKey: string, sql: NeonSql): Promise<void> {
  await sql.query(
    `insert into studio_ad_automation_scheduler_cursors (scheduler_key, last_workspace_id)
     values ($1, null)
     on conflict (scheduler_key) do nothing`,
    [schedulerKey],
  );
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(value as number), maximum));
}

// Keep this exported type referenced in generated API docs without forcing a
// client module to import the server-only draft helper.
export type { PrivateAdAutomationDraft };
