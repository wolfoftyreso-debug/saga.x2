import "server-only";

import {
  deriveSagaQuarterlyActivityPlanSlots,
  deriveSagaQuarterlyBatchActionability,
  sagaQuarterlyActivityPlanCreateSchema,
  sagaQuarterlyActivityPlanInputSchema,
  sagaQuarterlyActivityPlanSchema,
  sagaQuarterlyActivityPlanSlotSchema,
  sagaQuarterlyActivityPlanSummarySchema,
  sagaQuarterlyActivityPlanUpdateSchema,
  sagaQuarterlyBatchItemSchema,
  sagaQuarterlyBatchMaterializeSchema,
  sagaQuarterlyBatchAbandonSchema,
  sagaQuarterlyBatchRequestSchema,
  sagaQuarterlyBatchReviewSchema,
  sagaQuarterlyBatchResubmitSchema,
  sagaQuarterlyBatchSchema,
  sagaQuarterlyContentThemeSchema,
  sagaQuarterlyPrivateDraftMaterializationSchema,
  sagaQuarterlyMaterializationReceiptSchema,
  sagaQuarterlyPlanCalendarSlotSchema,
  type SagaQuarterlyActivityPlan,
  type SagaQuarterlyActivityPlanCreateInput,
  type SagaQuarterlyActivityPlanSummary,
  type SagaQuarterlyActivityPlanUpdateInput,
  type SagaQuarterlyBatch,
  type SagaQuarterlyBatchMaterializeInput,
  type SagaQuarterlyBatchAbandonInput,
  type SagaQuarterlyBatchRequest,
  type SagaQuarterlyBatchReviewInput,
  type SagaQuarterlyBatchResubmitInput,
  type SagaQuarterlyGenerationClaim,
  type SagaQuarterlyMaterializationReceipt,
  type SagaQuarterlyPlanCalendarSlot,
  type SagaQuarterlyPrivateDraftMaterialization,
} from "@/lib/domain/saga-quarterly-planning";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";
import { isValidIanaTimezone } from "@/lib/utils/date";

type JsonObject = Record<string, unknown>;

type PlanRow = {
  id: string;
  brand_profile_id: string;
  brand_name: string;
  onboarding_id: string;
  revision: number | string;
  plan_input: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

type SummaryRow = {
  id: string;
  brand_profile_id: string;
  brand_name: string;
  revision: number | string;
  timezone: string;
  horizon_start_date: string | Date;
  slot_count: number | string;
  open_batch_count: number | string;
  updated_at: string | Date;
};

type SlotRow = {
  id: string;
  plan_revision: number | string;
  slot_key: string;
  channel_plan_id: string;
  week_index: number | string;
  planned_at: string | Date;
  planned_local_date: string | Date;
  planned_local_time: string;
  timezone: string;
  channel: string;
  content_type: string;
  theme: unknown;
  objective: string;
  content_direction: string;
  desired_call_to_action: string;
  image_direction: string;
  target_length: string;
  planning_label: string;
  state: string;
  revision: number | string;
  studio_draft_id: string | null;
  draft_revision: number | string | null;
};

type BatchRow = {
  id: string;
  plan_revision: number | string;
  requested_count: number | string;
  state: string;
  failure_message: string | null;
  abandoned_at: string | Date | null;
  retryable_job_count: number | string;
  exhausted_job_count: number | string;
  active_processing_job_count: number | string;
  revision: number | string;
  created_at: string | Date;
  updated_at: string | Date;
};

type BatchItemRow = {
  id: string;
  batch_id: string;
  plan_slot_id: string;
  ordinal: number | string;
  state: string;
  review_resolution: string | null;
  review_note: string;
  returned_draft_revision: number | string | null;
  error_message: string | null;
  revision: number | string;
  studio_draft_id: string | null;
  draft_revision: number | string | null;
  slot_plan_revision: number | string;
  slot_key: string;
  channel_plan_id: string;
  week_index: number | string;
  planned_at: string | Date;
  planned_local_date: string | Date;
  planned_local_time: string;
  timezone: string;
  channel: string;
  content_type: string;
  theme: unknown;
  objective: string;
  content_direction: string;
  desired_call_to_action: string;
  image_direction: string;
  target_length: string;
  planning_label: string;
  slot_state: string;
  slot_revision: number | string;
};

type ClaimRow = {
  job_id: string;
  claim_token: string;
  batch_id: string;
  batch_item_id: string;
  plan_id: string;
  plan_revision: number | string;
  materialization_receipt_id: string;
  author_user_id: string;
  timezone: string;
  brand_name: string;
  brand_summary: string;
  brand_voice: unknown;
  slot_id: string;
  slot_revision: number | string;
  slot_key: string;
  channel_plan_id: string;
  week_index: number | string;
  planned_at: string | Date;
  planned_local_date: string | Date;
  planned_local_time: string;
  channel: string;
  content_type: string;
  theme: unknown;
  objective: string;
  content_direction: string;
  desired_call_to_action: string;
  image_direction: string;
  target_length: string;
  planning_label: string;
};

type ReceiptRow = {
  id: string;
  state: string;
  job_count: number | string;
  failure_message: string | null;
};

type CalendarSlotRow = SlotRow & {
  plan_id: string;
  brand_profile_id: string;
  brand_name: string;
};

export type SagaQuarterlyActivityPlanDetail = {
  plan: SagaQuarterlyActivityPlan;
  batches: SagaQuarterlyBatch[];
};

/** Server-only cron work descriptor; it is never serialized to a browser. */
export type SagaQuarterlyDueMaterialization = {
  actor: AppActor;
  brandProfileId: string;
  batchId: string;
  materializationReceiptId: string;
};

export class SagaQuarterlyPlanningAccessError extends Error {
  constructor() {
    super("Du har bara läsrättighet i den här arbetsytan.");
    this.name = "SagaQuarterlyPlanningAccessError";
  }
}

export class SagaQuarterlyPlanningNotFoundError extends Error {
  constructor(message = "Aktivitetsplanen hittades inte i den här arbetsytan.") {
    super(message);
    this.name = "SagaQuarterlyPlanningNotFoundError";
  }
}

export class SagaQuarterlyPlanningConflictError extends Error {
  constructor(message = "Planen har ändrats eller behöver slutföra en tidigare batch först.") {
    super(message);
    this.name = "SagaQuarterlyPlanningConflictError";
  }
}

export class SagaQuarterlyPlanningValidationError extends Error {
  constructor(message = "Aktivitetsplanen är inte giltig.") {
    super(message);
    this.name = "SagaQuarterlyPlanningValidationError";
  }
}

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new SagaQuarterlyPlanningAccessError();
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function number(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw new SagaQuarterlyPlanningValidationError();
  return Math.trunc(result);
}

function iso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(typeof value === "string" ? value : "");
  if (Number.isNaN(parsed.getTime())) throw new SagaQuarterlyPlanningValidationError();
  return parsed.toISOString();
}

function date(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return iso(value).slice(0, 10);
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function time(value: unknown): string {
  if (typeof value !== "string") throw new SagaQuarterlyPlanningValidationError();
  const matched = value.match(/^(\d{2}:\d{2})/);
  if (!matched) throw new SagaQuarterlyPlanningValidationError();
  return matched[1] ?? "";
}

function object(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function draftHref(draftId: string | null): string | null {
  return draftId && isUuid(draftId) ? `/studio/content/${encodeURIComponent(draftId)}?edit=1` : null;
}

function mapSlot(row: SlotRow) {
  return sagaQuarterlyActivityPlanSlotSchema.parse({
    id: row.id,
    planRevision: number(row.plan_revision),
    slotKey: row.slot_key,
    channelPlanId: row.channel_plan_id,
    weekIndex: number(row.week_index),
    plannedAt: iso(row.planned_at),
    plannedLocalDate: date(row.planned_local_date),
    plannedLocalTime: time(row.planned_local_time),
    timezone: row.timezone,
    channel: row.channel,
    contentType: row.content_type,
    theme: sagaQuarterlyContentThemeSchema.parse(object(row.theme)),
    objective: row.objective,
    contentDirection: row.content_direction,
    desiredCallToAction: row.desired_call_to_action ?? "",
    imageDirection: row.image_direction ?? "",
    targetLength: row.target_length ?? "medium",
    planningLabel: row.planning_label,
    state: row.state,
    revision: number(row.revision),
    draftId: row.studio_draft_id,
    draftHref: draftHref(row.studio_draft_id),
  });
}

function mapBatchItem(row: BatchItemRow) {
  const slot = mapSlot({
    id: row.plan_slot_id,
    plan_revision: row.slot_plan_revision,
    slot_key: row.slot_key,
    channel_plan_id: row.channel_plan_id,
    week_index: row.week_index,
    planned_at: row.planned_at,
    planned_local_date: row.planned_local_date,
    planned_local_time: row.planned_local_time,
    timezone: row.timezone,
    channel: row.channel,
    content_type: row.content_type,
    theme: row.theme,
    objective: row.objective,
    content_direction: row.content_direction,
    desired_call_to_action: row.desired_call_to_action,
    image_direction: row.image_direction,
    target_length: row.target_length,
    planning_label: row.planning_label,
    state: row.slot_state,
    revision: row.slot_revision,
    studio_draft_id: row.studio_draft_id,
    draft_revision: row.draft_revision,
  });
  return sagaQuarterlyBatchItemSchema.parse({
    id: row.id,
    planItemId: row.plan_slot_id,
    slot,
    state: row.state,
    reviewResolution: row.review_resolution,
    reviewNote: row.review_note ?? "",
    returnedDraftRevision: row.returned_draft_revision === null ? null : number(row.returned_draft_revision),
    revision: number(row.revision),
    draftId: row.studio_draft_id,
    draftHref: draftHref(row.studio_draft_id),
    draftRevision: row.draft_revision === null ? null : number(row.draft_revision),
    error: row.error_message,
  });
}

function mapBatch(row: BatchRow, items: ReturnType<typeof mapBatchItem>[]): SagaQuarterlyBatch {
  const state = row.state;
  const retryableJobCount = number(row.retryable_job_count);
  const exhaustedJobCount = number(row.exhausted_job_count);
  const activeProcessingJobCount = number(row.active_processing_job_count);
  const actionability = deriveSagaQuarterlyBatchActionability({
    state,
    retryableJobCount,
    exhaustedJobCount,
    activeProcessingJobCount,
  });
  return sagaQuarterlyBatchSchema.parse({
    id: row.id,
    planRevision: number(row.plan_revision),
    requestedCount: number(row.requested_count),
    state,
    revision: number(row.revision),
    ...actionability,
    canRequestNextBatch: state === "resolved",
    failureMessage: row.failure_message,
    abandonedAt: row.abandoned_at ? iso(row.abandoned_at) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    items: items.sort((left, right) => left.slot.plannedAt.localeCompare(right.slot.plannedAt)),
  });
}

function databaseFailure(error: unknown): never {
  if (
    error instanceof SagaQuarterlyPlanningAccessError
    || error instanceof SagaQuarterlyPlanningNotFoundError
    || error instanceof SagaQuarterlyPlanningConflictError
    || error instanceof SagaQuarterlyPlanningValidationError
  ) throw error;
  const details = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : null;
  const code = details?.code;
  const message = typeof details?.message === "string" ? details.message : "";
  if (/saga_quarterly_(plan_not_found|batch_not_found|batch_item_not_found)/.test(message)) {
    throw new SagaQuarterlyPlanningNotFoundError();
  }
  if (message.includes("saga_quarterly_completed_onboarding_required")) {
    throw new SagaQuarterlyPlanningValidationError("Välj ett aktivt varumärke med slutförd onboarding innan aktivitetsplanen skapas.");
  }
  if (message.includes("saga_quarterly_invalid") || message.includes("saga_quarterly_return_requires_note") || message.includes("saga_quarterly_private_draft_does_not_match_slot") || code === "23514") {
    throw new SagaQuarterlyPlanningValidationError();
  }
  if (
    code === "23505"
    || /saga_quarterly_(revision_conflict|idempotency_conflict|plan_already_exists|open_batch|prior_batch|batch_slots_unavailable|batch_already_resolved|batch_requires_human_review|batch_requires_rework|batch_retry_required|batch_item_already_resolved|batch_not_ready_for_review|batch_not_waiting_for_rework|batch_item_not_returned|returned_draft_not_edited|draft_revision_conflict|draft_not_reviewable|draft_already_calendar_scheduled|materialization_already_running|materialization_still_processing|job_attempts_exhausted|no_jobs_to_materialize)/.test(message)
  ) throw new SagaQuarterlyPlanningConflictError();
  throw error;
}

const planSelect = `select
  plan.id::text,
  plan.brand_profile_id::text,
  profile.name as brand_name,
  plan.onboarding_id::text,
  plan.revision,
  plan.plan_input,
  plan.created_at::text,
  plan.updated_at::text
from saga_quarterly_activity_plans plan
join content_engine_brand_profiles profile
  on profile.workspace_id = plan.workspace_id and profile.id = plan.brand_profile_id`;

/** Selector view for the control room; full plans are read by brand ID only. */
export async function listSagaQuarterlyActivityPlanSummaries(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyActivityPlanSummary[]> {
  try {
    const rows = await sql.query(
      `select
         plan.id::text,
         plan.brand_profile_id::text,
         profile.name as brand_name,
         plan.revision,
         plan.timezone,
         plan.horizon_start_date::text,
         (select count(*)::int from saga_quarterly_activity_plan_slots slot
            where slot.workspace_id = plan.workspace_id and slot.plan_id = plan.id and slot.plan_revision = plan.revision) as slot_count,
         (select count(*)::int from saga_quarterly_activity_plan_batches batch
            where batch.workspace_id = plan.workspace_id and batch.plan_id = plan.id and batch.state not in ('resolved', 'stale')) as open_batch_count,
         plan.updated_at::text
       from saga_quarterly_activity_plans plan
       join content_engine_brand_profiles profile
         on profile.workspace_id = plan.workspace_id and profile.id = plan.brand_profile_id
       where plan.workspace_id = $1::uuid and plan.active = true
       order by plan.updated_at desc, plan.id desc`,
      [actor.workspaceId],
    ) as unknown as SummaryRow[];
    return rows.map((row) => sagaQuarterlyActivityPlanSummarySchema.parse({
      id: row.id,
      brandProfileId: row.brand_profile_id,
      brandName: row.brand_name,
      revision: number(row.revision),
      timezone: row.timezone,
      horizonStartDate: date(row.horizon_start_date),
      slotCount: number(row.slot_count),
      openBatchCount: number(row.open_batch_count),
      updatedAt: iso(row.updated_at),
    }));
  } catch (error) {
    return databaseFailure(error);
  }
}

/**
 * Calendar overlay source. These are desired plan slots, never Studio
 * `scheduled_at` events: callers must render them read-only and must not send
 * them to the existing calendar drag/reschedule mutation.
 */
export async function listSagaQuarterlyActivityPlanCalendarSlots(
  actor: AppActor,
  range: { from: string; to: string; timezone: string },
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyPlanCalendarSlot[]> {
  if (!validCalendarDate(range.from) || !validCalendarDate(range.to) || range.from > range.to || !isValidIanaTimezone(range.timezone)) {
    throw new SagaQuarterlyPlanningValidationError("Ange ett giltigt kalenderintervall.");
  }
  try {
    const rows = await sql.query(
      `select
         slot.id::text, slot.plan_id::text, plan.brand_profile_id::text, profile.name as brand_name,
         slot.plan_revision, slot.slot_key, slot.channel_plan_id, slot.week_index,
         slot.planned_at::text, slot.planned_local_date::text, slot.planned_local_time::text,
         slot.timezone, slot.channel, slot.content_type, slot.theme, slot.objective, slot.content_direction,
         slot.desired_call_to_action, slot.image_direction, slot.target_length, slot.planning_label,
         slot.state, slot.revision, item.studio_draft_id::text, draft.revision as draft_revision
       from saga_quarterly_activity_plan_slots slot
       join saga_quarterly_activity_plans plan
         on plan.workspace_id = slot.workspace_id and plan.id = slot.plan_id
       join content_engine_brand_profiles profile
         on profile.workspace_id = plan.workspace_id and profile.id = plan.brand_profile_id
       left join saga_quarterly_activity_plan_batch_items item
         on item.workspace_id = slot.workspace_id and item.plan_slot_id = slot.id
       left join studio_drafts draft
         on draft.workspace_id = item.workspace_id and draft.id = item.studio_draft_id
       where slot.workspace_id = $1::uuid
         and plan.active = true
         and slot.plan_revision = plan.revision
         and slot.state <> 'cancelled'
         -- The requested calendar window is expressed in the visible display
         -- timezone, while the original plan local time remains on the slot.
         and slot.planned_at >= ($2::date::timestamp at time zone $4::text)
         and slot.planned_at < (($3::date + interval '1 day')::timestamp at time zone $4::text)
       order by slot.planned_at, slot.id`,
      [actor.workspaceId, range.from, range.to, range.timezone],
    ) as unknown as CalendarSlotRow[];
    return rows.map((row) => sagaQuarterlyPlanCalendarSlotSchema.parse({
      id: `plan-slot-${row.id}`,
      kind: "plan_slot",
      planId: row.plan_id,
      brandProfileId: row.brand_profile_id,
      brandName: row.brand_name,
      title: row.planning_label,
      startsAt: iso(row.planned_at),
      plannedLocalDate: date(row.planned_local_date),
      plannedLocalTime: time(row.planned_local_time),
      timezone: row.timezone,
      channel: row.channel,
      contentType: row.content_type,
      state: row.state,
      draftId: row.studio_draft_id,
      draftHref: draftHref(row.studio_draft_id),
      editable: false,
      calendarLabel: "Planerad aktivitet",
    }));
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Finds already-authorized, already-requested private generation receipts for Vercel Cron. */
export async function listDueSagaQuarterlyActivityPlanMaterializations(
  limit: number,
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyDueMaterialization[]> {
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 5));
  try {
    const rows = await sql.query(
      `select
         batch.workspace_id::text,
         batch.requested_by_user_id::text as user_id,
         plan.brand_profile_id::text,
         batch.id::text as batch_id,
         receipt.id::text as materialization_receipt_id
       from saga_quarterly_activity_plan_materialization_receipts receipt
       join saga_quarterly_activity_plan_batches batch
         on batch.workspace_id = receipt.workspace_id and batch.id = receipt.batch_id
       join saga_quarterly_activity_plans plan
         on plan.workspace_id = batch.workspace_id and plan.id = batch.plan_id
       join app_workspace_memberships membership
         on membership.workspace_id = batch.workspace_id and membership.user_id = batch.requested_by_user_id
       where receipt.state = 'running'
         and batch.state = 'generating'
         and plan.active = true
       order by receipt.created_at asc, receipt.id asc
       limit $1::int`,
      [bounded],
    ) as unknown as Array<{
      workspace_id: string;
      user_id: string;
      brand_profile_id: string;
      batch_id: string;
      materialization_receipt_id: string;
    }>;
    return rows.map((row) => ({
      actor: {
        userId: row.user_id,
        workspaceId: row.workspace_id,
        // Claims and Lens lookup are server-owned reads/writes; this role is
        // not a client authorization decision and no request provides it.
        role: "editor",
        email: null,
        displayName: null,
      },
      brandProfileId: row.brand_profile_id,
      batchId: row.batch_id,
      materializationReceiptId: row.materialization_receipt_id,
    }));
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Full private state; no provider credential, recipient or delivery setting is selected here. */
export async function getSagaQuarterlyActivityPlan(
  actor: AppActor,
  brandProfileId: string,
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyActivityPlanDetail | null> {
  if (!isUuid(brandProfileId)) throw new SagaQuarterlyPlanningNotFoundError();
  try {
    const planRows = await sql.query(
      `${planSelect}
       where plan.workspace_id = $1::uuid and plan.brand_profile_id = $2::uuid and plan.active = true
       limit 1`,
      [actor.workspaceId, brandProfileId],
    ) as unknown as PlanRow[];
    const row = planRows[0];
    if (!row) return null;
    const input = sagaQuarterlyActivityPlanInputSchema.parse(object(row.plan_input));
    const [slotRows, batchRows, itemRows, openRows] = await Promise.all([
      sql.query(
        `select
           slot.id::text, slot.plan_revision, slot.slot_key, slot.channel_plan_id, slot.week_index,
           slot.planned_at::text, slot.planned_local_date::text, slot.planned_local_time::text,
           slot.timezone, slot.channel, slot.content_type, slot.theme, slot.objective, slot.content_direction,
           slot.desired_call_to_action, slot.image_direction, slot.target_length,
           slot.planning_label, slot.state, slot.revision,
           item.studio_draft_id::text, draft.revision as draft_revision
         from saga_quarterly_activity_plan_slots slot
         left join saga_quarterly_activity_plan_batch_items item
           on item.workspace_id = slot.workspace_id and item.plan_slot_id = slot.id
         left join studio_drafts draft
           on draft.workspace_id = item.workspace_id and draft.id = item.studio_draft_id
         where slot.workspace_id = $1::uuid and slot.plan_id = $2::uuid and slot.plan_revision = $3::int
         order by slot.planned_at, slot.id`,
        [actor.workspaceId, row.id, number(row.revision)],
      ) as unknown as Promise<SlotRow[]>,
      sql.query(
        `select
           batch.id::text, batch.plan_revision, batch.requested_count, batch.state,
           batch.failure_message, batch.abandoned_at::text,
           coalesce(job_health.retryable_job_count, 0)::int as retryable_job_count,
           coalesce(job_health.exhausted_job_count, 0)::int as exhausted_job_count,
           coalesce(job_health.active_processing_job_count, 0)::int as active_processing_job_count,
           batch.revision, batch.created_at::text, batch.updated_at::text
           from saga_quarterly_activity_plan_batches batch
           left join lateral (
             select
               count(*) filter (
                 where job.state = 'failed' and job.attempt_count < job.max_attempt_count
               )::int as retryable_job_count,
               count(*) filter (
                 where job.state = 'failed' and job.attempt_count >= job.max_attempt_count
               )::int as exhausted_job_count,
               count(*) filter (
                 where job.state = 'processing' and job.lease_expires_at > now()
               )::int as active_processing_job_count
             from saga_quarterly_activity_plan_jobs job
             where job.workspace_id = batch.workspace_id and job.batch_id = batch.id
           ) job_health on true
          where batch.workspace_id = $1::uuid and batch.plan_id = $2::uuid
          order by created_at desc, id desc
          limit 40`,
        [actor.workspaceId, row.id],
      ) as unknown as Promise<BatchRow[]>,
      sql.query(
        `select
           item.id::text, item.batch_id::text, item.plan_slot_id::text, item.ordinal, item.state,
           item.review_resolution, item.review_note, item.returned_draft_revision, item.error_message, item.revision,
           item.studio_draft_id::text, draft.revision as draft_revision,
           slot.plan_revision as slot_plan_revision, slot.slot_key, slot.channel_plan_id, slot.week_index,
           slot.planned_at::text, slot.planned_local_date::text, slot.planned_local_time::text,
           slot.timezone, slot.channel, slot.content_type, slot.theme, slot.objective, slot.content_direction,
           slot.desired_call_to_action, slot.image_direction, slot.target_length,
           slot.planning_label, slot.state as slot_state, slot.revision as slot_revision
         from saga_quarterly_activity_plan_batch_items item
         join saga_quarterly_activity_plan_batches batch
           on batch.workspace_id = item.workspace_id and batch.id = item.batch_id
         join saga_quarterly_activity_plan_slots slot
           on slot.workspace_id = item.workspace_id and slot.id = item.plan_slot_id
         left join studio_drafts draft
           on draft.workspace_id = item.workspace_id and draft.id = item.studio_draft_id
         where item.workspace_id = $1::uuid and batch.plan_id = $2::uuid
         order by batch.created_at desc, item.ordinal`,
        [actor.workspaceId, row.id],
      ) as unknown as Promise<BatchItemRow[]>,
      sql.query(
        `select count(*)::int as open_batch_count
           from saga_quarterly_activity_plan_batches
          where workspace_id = $1::uuid and plan_id = $2::uuid and state not in ('resolved', 'stale')`,
        [actor.workspaceId, row.id],
      ) as unknown as Promise<Array<{ open_batch_count: number | string }>>,
    ]);
    const slots = (slotRows as unknown as SlotRow[]).map(mapSlot);
    const batchItemsById = new Map<string, ReturnType<typeof mapBatchItem>[]>();
    for (const itemRow of itemRows as unknown as BatchItemRow[]) {
      const items = batchItemsById.get(itemRow.batch_id) ?? [];
      items.push(mapBatchItem(itemRow));
      batchItemsById.set(itemRow.batch_id, items);
    }
    const batches = (batchRows as unknown as BatchRow[]).map((batch) => mapBatch(batch, batchItemsById.get(batch.id) ?? []));
    const openBatchCount = number((openRows as Array<{ open_batch_count: number | string }>)[0]?.open_batch_count ?? 0);
    const plan = sagaQuarterlyActivityPlanSchema.parse({
      id: row.id,
      brandProfileId: row.brand_profile_id,
      brandName: row.brand_name,
      onboardingId: row.onboarding_id,
      revision: number(row.revision),
      plan: input,
      horizonWeeks: 13,
      slots,
      canRequestBatch: openBatchCount === 0 && slots.some((slot) => slot.state === "planned"),
      nextBatchReason: openBatchCount > 0
        ? "Slutför mänsklig granskning av den pågående batchen innan nästa batch skapas."
        : slots.some((slot) => slot.state === "planned")
          ? null
          : "Det finns inga obearbetade tillfällen i den aktuella 13-veckorshorisonten.",
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    });
    return { plan, batches };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function createSagaQuarterlyActivityPlan(
  actor: AppActor,
  input: SagaQuarterlyActivityPlanCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ plan: SagaQuarterlyActivityPlan; reused: boolean }> {
  assertCanWrite(actor);
  const payload = sagaQuarterlyActivityPlanCreateSchema.parse(input);
  const slots = deriveSagaQuarterlyActivityPlanSlots(payload.plan);
  try {
    const rows = await sql.query(
      `select plan_id::text, reused
         from saga_create_quarterly_activity_plan($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, $6::jsonb)`,
      [actor.workspaceId, actor.userId, payload.brandProfileId, payload.createIdempotencyKey, JSON.stringify(payload.plan), JSON.stringify(slots)],
    ) as unknown as Array<{ plan_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result) throw new SagaQuarterlyPlanningValidationError("Aktivitetsplanen kunde inte återläsas efter sparandet.");
    const detail = await getSagaQuarterlyActivityPlan(actor, payload.brandProfileId, sql);
    if (!detail) throw new SagaQuarterlyPlanningConflictError("Aktivitetsplanen kunde inte återläsas efter sparandet.");
    return { plan: detail.plan, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Full replacement is also the explicit, safe way to roll the horizon forward. */
export async function updateSagaQuarterlyActivityPlan(
  actor: AppActor,
  brandProfileId: string,
  input: SagaQuarterlyActivityPlanUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyActivityPlan> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyActivityPlanUpdateSchema.parse(input);
  const slots = deriveSagaQuarterlyActivityPlanSlots(payload.plan);
  try {
    await sql.query(
      `select plan_id::text, revision
         from saga_update_quarterly_activity_plan($1::uuid, $2::uuid, $3::uuid, $4::int, $5::jsonb, $6::jsonb)`,
      [actor.workspaceId, actor.userId, brandProfileId, payload.expectedRevision, JSON.stringify(payload.plan), JSON.stringify(slots)],
    );
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    if (!detail) throw new SagaQuarterlyPlanningNotFoundError();
    return detail.plan;
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function requestSagaQuarterlyActivityPlanBatch(
  actor: AppActor,
  brandProfileId: string,
  input: SagaQuarterlyBatchRequest,
  sql: NeonSql = createNeonSql(),
): Promise<{ batch: SagaQuarterlyBatch; reused: boolean }> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyBatchRequestSchema.parse(input);
  try {
    const rows = await sql.query(
      `select batch_id::text, reused
         from saga_request_quarterly_activity_plan_batch($1::uuid, $2::uuid, $3::uuid, $4::int, $5::uuid, $6::uuid[])`,
      [actor.workspaceId, actor.userId, brandProfileId, payload.expectedPlanRevision, payload.idempotencyKey, payload.planItemIds],
    ) as unknown as Array<{ batch_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result) throw new SagaQuarterlyPlanningValidationError("Batchen kunde inte återläsas efter sparandet.");
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    const batch = detail?.batches.find((entry) => entry.id === result.batch_id);
    if (!batch) throw new SagaQuarterlyPlanningConflictError("Batchen kunde inte återläsas efter sparandet.");
    return { batch, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Makes a batch eligible for job leases; this itself never creates a fake draft. */
export async function prepareSagaQuarterlyActivityPlanBatch(
  actor: AppActor,
  brandProfileId: string,
  batchId: string,
  input: SagaQuarterlyBatchMaterializeInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ batch: SagaQuarterlyBatch; receipt: SagaQuarterlyMaterializationReceipt }> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId) || !isUuid(batchId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyBatchMaterializeSchema.parse(input);
  try {
    const rows = await sql.query(
      `select batch_id::text, revision, state, materialization_receipt_id::text, reused
         from saga_prepare_quarterly_activity_plan_batch($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::int, $7::boolean)`,
      [actor.workspaceId, brandProfileId, batchId, payload.idempotencyKey, payload.expectedPlanRevision, payload.expectedBatchRevision, payload.retryFailed],
    ) as unknown as Array<{ materialization_receipt_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result?.materialization_receipt_id) {
      throw new SagaQuarterlyPlanningConflictError("Materialiseringen kunde inte reserveras.");
    }
    const receiptRows = await sql.query(
      `select id::text, state, job_count, failure_message
         from saga_quarterly_activity_plan_materialization_receipts
        where workspace_id = $1::uuid and id = $2::uuid and batch_id = $3::uuid
        limit 1`,
      [actor.workspaceId, result.materialization_receipt_id, batchId],
    ) as unknown as ReceiptRow[];
    const receiptRow = receiptRows[0];
    if (!receiptRow) throw new SagaQuarterlyPlanningConflictError("Materialiseringskvittot kunde inte återläsas.");
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    const batch = detail?.batches.find((entry) => entry.id === batchId);
    if (!batch) throw new SagaQuarterlyPlanningNotFoundError("Batchen hittades inte i den här aktivitetsplanen.");
    return {
      batch,
      receipt: sagaQuarterlyMaterializationReceiptSchema.parse({
        id: receiptRow.id,
        state: receiptRow.state,
        jobCount: number(receiptRow.job_count),
        failureMessage: receiptRow.failure_message,
        reused: result.reused === true,
      }),
    };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Explicit human recovery after a terminal failed receipt; it keeps audit drafts private. */
export async function abandonFailedSagaQuarterlyActivityPlanBatch(
  actor: AppActor,
  brandProfileId: string,
  batchId: string,
  input: SagaQuarterlyBatchAbandonInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ batch: SagaQuarterlyBatch; reused: boolean }> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId) || !isUuid(batchId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyBatchAbandonSchema.parse(input);
  try {
    const rows = await sql.query(
      `select batch_id::text, batch_revision, reused
         from saga_abandon_failed_quarterly_activity_plan_batch(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::int, $7::int, $8
         )`,
      [
        actor.workspaceId, actor.userId, brandProfileId, batchId, payload.idempotencyKey,
        payload.expectedPlanRevision, payload.expectedBatchRevision, payload.note,
      ],
    ) as unknown as Array<{ batch_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result) throw new SagaQuarterlyPlanningConflictError("Den misslyckade batchen kunde inte avslutas.");
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    const batch = detail?.batches.find((entry) => entry.id === result.batch_id);
    if (!batch) throw new SagaQuarterlyPlanningConflictError("Batchen kunde inte återläsas efter avslutet.");
    return { batch, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Claims exactly one server-owned job. The browser can never choose a slot or actor at this boundary. */
export async function claimSagaQuarterlyActivityPlanJob(
  actor: AppActor,
  brandProfileId: string,
  batchId: string,
  options: { materializationReceiptId: string; workerId: string; leaseSeconds?: number },
  sql: NeonSql = createNeonSql(),
): Promise<SagaQuarterlyGenerationClaim | null> {
  if (!isUuid(brandProfileId) || !isUuid(batchId) || !isUuid(options.materializationReceiptId)) throw new SagaQuarterlyPlanningNotFoundError();
  try {
    const rows = await sql.query(
      `select * from saga_claim_quarterly_activity_plan_job($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::int)`,
      [actor.workspaceId, brandProfileId, batchId, options.materializationReceiptId, options.workerId.slice(0, 160), Math.max(30, Math.min(options.leaseSeconds ?? 90, 300))],
    ) as unknown as ClaimRow[];
    const row = rows[0];
    if (!row) return null;
    return {
      jobId: row.job_id,
      claimToken: row.claim_token,
      batchId: row.batch_id,
      batchItemId: row.batch_item_id,
      materializationReceiptId: row.materialization_receipt_id,
      planId: row.plan_id,
      planRevision: number(row.plan_revision),
      authorUserId: row.author_user_id,
      timezone: row.timezone,
      brand: { name: row.brand_name, summary: row.brand_summary, voice: object(row.brand_voice) },
      slot: {
        ...mapSlot({
          id: row.slot_id,
          plan_revision: row.plan_revision,
          slot_key: row.slot_key,
          channel_plan_id: row.channel_plan_id,
          week_index: row.week_index,
          planned_at: row.planned_at,
          planned_local_date: row.planned_local_date,
          planned_local_time: row.planned_local_time,
          timezone: row.timezone,
          channel: row.channel,
          content_type: row.content_type,
          theme: row.theme,
          objective: row.objective,
          content_direction: row.content_direction,
          desired_call_to_action: row.desired_call_to_action,
          image_direction: row.image_direction,
          target_length: row.target_length,
          planning_label: row.planning_label,
          state: "in_batch",
          revision: row.slot_revision,
          studio_draft_id: null,
          draft_revision: null,
        }),
      },
    };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** The SQL function atomically creates one unscheduled Studio review draft and completes its lease. */
export async function completeSagaQuarterlyActivityPlanJob(
  actor: AppActor,
  input: { jobId: string; claimToken: string; draft: SagaQuarterlyPrivateDraftMaterialization },
  sql: NeonSql = createNeonSql(),
): Promise<{ draftId: string | null; stale: boolean }> {
  const payload = sagaQuarterlyPrivateDraftMaterializationSchema.parse(input.draft);
  if (!isUuid(input.jobId) || !isUuid(input.claimToken)) throw new SagaQuarterlyPlanningNotFoundError();
  try {
    const rows = await sql.query(
      `select studio_draft_id::text, stale
         from saga_complete_quarterly_activity_plan_job($1::uuid, $2::uuid, $3::uuid, $4::jsonb)`,
      [actor.workspaceId, input.jobId, input.claimToken, JSON.stringify(payload)],
    ) as unknown as Array<{ studio_draft_id: string | null; stale: boolean }>;
    const row = rows[0];
    return { draftId: row?.studio_draft_id ?? null, stale: row?.stale === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function failSagaQuarterlyActivityPlanJob(
  actor: AppActor,
  input: { jobId: string; claimToken: string; errorCode: string; errorMessage: string },
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  if (!isUuid(input.jobId) || !isUuid(input.claimToken)) return false;
  try {
    const rows = await sql.query(
      `select saga_fail_quarterly_activity_plan_job($1::uuid, $2::uuid, $3::uuid, $4, $5) as failed`,
      [actor.workspaceId, input.jobId, input.claimToken, input.errorCode.slice(0, 120), input.errorMessage.slice(0, 1200)],
    ) as unknown as Array<{ failed: boolean }>;
    return rows[0]?.failed === true;
  } catch (error) {
    return databaseFailure(error);
  }
}

export async function reviewSagaQuarterlyActivityPlanBatchItem(
  actor: AppActor,
  brandProfileId: string,
  batchId: string,
  batchItemId: string,
  input: SagaQuarterlyBatchReviewInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ batch: SagaQuarterlyBatch; item: ReturnType<typeof mapBatchItem>; reused: boolean }> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId) || !isUuid(batchId) || !isUuid(batchItemId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyBatchReviewSchema.parse(input);
  try {
    const rows = await sql.query(
      `select batch_id::text, batch_revision, item_id::text, item_revision, reused
         from saga_review_quarterly_activity_plan_batch_item(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::int, $8::int, $9::int, $10::int, $11, $12
         )`,
      [
        actor.workspaceId, actor.userId, brandProfileId, batchId, batchItemId, payload.idempotencyKey,
        payload.expectedPlanRevision, payload.expectedBatchRevision, payload.expectedItemRevision,
        payload.expectedDraftRevision, payload.resolution, payload.note,
      ],
    ) as unknown as Array<{ batch_id: string; item_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result) throw new SagaQuarterlyPlanningConflictError("Granskningsbeslutet kunde inte återläsas.");
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    const batch = detail?.batches.find((entry) => entry.id === result.batch_id);
    const item = batch?.items.find((entry) => entry.id === result.item_id);
    if (!batch || !item) throw new SagaQuarterlyPlanningConflictError("Granskningsbeslutet kunde inte återläsas.");
    return { batch, item, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}

/** Reopens a returned, edited private draft for the same human-review batch. */
export async function resubmitSagaQuarterlyActivityPlanBatchItem(
  actor: AppActor,
  brandProfileId: string,
  batchId: string,
  batchItemId: string,
  input: SagaQuarterlyBatchResubmitInput,
  sql: NeonSql = createNeonSql(),
): Promise<{ batch: SagaQuarterlyBatch; item: ReturnType<typeof mapBatchItem>; reused: boolean }> {
  assertCanWrite(actor);
  if (!isUuid(brandProfileId) || !isUuid(batchId) || !isUuid(batchItemId)) throw new SagaQuarterlyPlanningNotFoundError();
  const payload = sagaQuarterlyBatchResubmitSchema.parse(input);
  try {
    const rows = await sql.query(
      `select batch_id::text, batch_revision, item_id::text, item_revision, reused
         from saga_resubmit_quarterly_activity_plan_batch_item(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           $7::int, $8::int, $9::int, $10::int
         )`,
      [
        actor.workspaceId, actor.userId, brandProfileId, batchId, batchItemId, payload.idempotencyKey,
        payload.expectedPlanRevision, payload.expectedBatchRevision, payload.expectedItemRevision,
        payload.expectedDraftRevision,
      ],
    ) as unknown as Array<{ batch_id: string; item_id: string; reused: boolean }>;
    const result = rows[0];
    if (!result) throw new SagaQuarterlyPlanningConflictError("Utkastet kunde inte återställas till granskning.");
    const detail = await getSagaQuarterlyActivityPlan(actor, brandProfileId, sql);
    const batch = detail?.batches.find((entry) => entry.id === result.batch_id);
    const item = batch?.items.find((entry) => entry.id === result.item_id);
    if (!batch || !item) throw new SagaQuarterlyPlanningConflictError("Utkastet kunde inte återläsas efter återinsändningen.");
    return { batch, item, reused: result.reused === true };
  } catch (error) {
    return databaseFailure(error);
  }
}
