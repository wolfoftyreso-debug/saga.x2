import "server-only";

import {
  adAutomationDestinationExecution,
  adAutomationCreateSchema,
  adAutomationIdSchema,
  adAutomationInputSchema,
  adAutomationManualTestInputSchema,
  adAutomationUpdateSchema,
  type AdAutomationCreateInput,
  type AdAutomationInput,
  type AdAutomationTestReceipt,
  type AdAutomationUpdateInput,
  type AdAutomationView,
  type AdAutomationWorkflow,
} from "@/lib/domain/ad-automation";
import { upcomingAdAutomationOccurrences } from "@/lib/domain/ad-automation-schedule";
import { createPrivateAdAutomationDraft, type PrivateAdAutomationDraft } from "@/lib/neon/ad-automation-draft";
import { assertSagaCreativeBriefCanGenerate } from "@/lib/services/saga-creative-safety";
import { StudioContentAccessError, StudioContentConflictError } from "@/lib/neon/studio-content-repository";
import type { AppActor } from "@/lib/neon/auth-repository";
import { createNeonSql, type NeonSql } from "@/lib/neon/database";

type AutomationRow = {
  id: string;
  name: string;
  active: boolean;
  revision: number | string;
  workflow: unknown;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

type TestReceiptRow = {
  id: string;
  automation_id: string;
  idempotency_key: string;
  state: string;
  draft_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PreparedAdAutomationManualTest = {
  automation: AdAutomationView;
  receipt: AdAutomationTestReceipt;
  draft?: PrivateAdAutomationDraft;
  reused: boolean;
};

export type CreatedAdAutomation = {
  automation: AdAutomationView;
  /** True when a network retry reused the original workspace-scoped save. */
  reused: boolean;
};

function assertCanWrite(actor: AppActor): void {
  if (actor.role === "viewer") throw new StudioContentAccessError();
}

function mapAutomation(row: AutomationRow): AdAutomationView {
  const parsed = adAutomationInputSchema.safeParse({
    name: row.name,
    active: row.active,
    workflow: row.workflow,
  });
  if (!parsed.success) throw new Error("Den sparade annonsautomationen har ett ogiltigt arbetsflöde.");
  return {
    id: row.id,
    name: parsed.data.name,
    active: parsed.data.active,
    revision: Number(row.revision),
    workflow: parsed.data.workflow,
    destinations: parsed.data.workflow.destinations.map((destination) => ({
      ...destination,
      execution: adAutomationDestinationExecution(destination),
    })),
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertSafeCreative(workflow: AdAutomationWorkflow): void {
  // This server-only call rejects unsafe scenes before they can be saved for a
  // later Gateway run. It deliberately permits an unverified offer as a
  // non-publishable draft; no publication path exists in this vertical slice.
  assertSagaCreativeBriefCanGenerate(workflow.creative.creativeBrief);
}

function nextRunAt(input: AdAutomationInput, now = new Date()): string | null {
  if (!input.active) return null;
  return upcomingAdAutomationOccurrences(input.workflow, { now, horizonDays: 31 })[0]?.runAt ?? null;
}

function mapReceipt(row: TestReceiptRow): AdAutomationTestReceipt {
  if ((row.state !== "queued" && row.state !== "completed") || (row.state === "queued" && row.draft_id !== null) || (row.state === "completed" && row.draft_id === null)) {
    throw new Error("Annonsautomationens testkvitto har ett ogiltigt tillstånd.");
  }
  const state: "queued" | "completed" = row.state === "completed" ? "completed" : "queued";
  return {
    id: row.id,
    automationId: row.automation_id,
    idempotencyKey: row.idempotency_key,
    state,
    draftId: row.draft_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getRow(
  actor: AppActor,
  automationId: string,
  sql: NeonSql,
): Promise<AutomationRow | null> {
  const rows = await sql.query(
    `select id::text, name, active, revision, workflow, next_run_at::text, created_at::text, updated_at::text
       from studio_ad_automations
      where workspace_id = $1::uuid and id = $2::uuid
      limit 1`,
    [actor.workspaceId, automationId],
  ) as unknown as AutomationRow[];
  return rows[0] ?? null;
}

/** Lists only workflows belonging to the current signed-in workspace. */
export async function listAdAutomations(
  actor: AppActor,
  sql: NeonSql = createNeonSql(),
): Promise<AdAutomationView[]> {
  const rows = await sql.query(
    `select id::text, name, active, revision, workflow, next_run_at::text, created_at::text, updated_at::text
       from studio_ad_automations
      where workspace_id = $1::uuid
      order by updated_at desc, name asc`,
    [actor.workspaceId],
  ) as unknown as AutomationRow[];
  return rows.map(mapAutomation);
}

export async function getAdAutomation(
  actor: AppActor,
  automationId: string,
  sql: NeonSql = createNeonSql(),
): Promise<AdAutomationView | null> {
  const id = adAutomationIdSchema.parse(automationId);
  const row = await getRow(actor, id, sql);
  return row ? mapAutomation(row) : null;
}

/**
 * Saves a complete canvas workflow. It cannot persist provider credentials.
 * The UUID is supplied once by the client per intentional create operation so
 * a retry after a lost response returns the original workflow instead of a
 * second automation.
 */
export async function createAdAutomation(
  actor: AppActor,
  input: AdAutomationCreateInput,
  sql: NeonSql = createNeonSql(),
): Promise<CreatedAdAutomation> {
  assertCanWrite(actor);
  const parsed = adAutomationCreateSchema.parse(input);
  assertSafeCreative(parsed.workflow);
  const rows = await sql.query(
    `insert into studio_ad_automations (
       workspace_id, created_by_user_id, updated_by_user_id, create_idempotency_key,
       name, active, workflow, next_run_at
     ) values ($1::uuid, $2::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::timestamptz)
     on conflict (workspace_id, create_idempotency_key) do nothing
     returning id::text, name, active, revision, workflow, next_run_at::text, created_at::text, updated_at::text`,
    [
      actor.workspaceId,
      actor.userId,
      parsed.createIdempotencyKey,
      parsed.name,
      parsed.active,
      JSON.stringify(parsed.workflow),
      nextRunAt(parsed),
    ],
  ) as unknown as AutomationRow[];
  const row = rows[0];
  if (row) return { automation: mapAutomation(row), reused: false };

  const existing = await getRowByCreateIdempotencyKey(actor, parsed.createIdempotencyKey, sql);
  if (!existing) throw new Error("Annonsautomationen kunde inte återläsas efter en sparretry.");
  return { automation: mapAutomation(existing), reused: true };
}

async function getRowByCreateIdempotencyKey(
  actor: AppActor,
  createIdempotencyKey: string,
  sql: NeonSql,
): Promise<AutomationRow | null> {
  const rows = await sql.query(
    `select id::text, name, active, revision, workflow, next_run_at::text, created_at::text, updated_at::text
       from studio_ad_automations
      where workspace_id = $1::uuid and create_idempotency_key = $2::uuid
      limit 1`,
    [actor.workspaceId, createIdempotencyKey],
  ) as unknown as AutomationRow[];
  return rows[0] ?? null;
}

/** Updates top-level fields atomically; a supplied workflow must be complete. */
export async function updateAdAutomation(
  actor: AppActor,
  automationId: string,
  patch: AdAutomationUpdateInput,
  sql: NeonSql = createNeonSql(),
): Promise<AdAutomationView | null> {
  assertCanWrite(actor);
  const id = adAutomationIdSchema.parse(automationId);
  const parsedPatch = adAutomationUpdateSchema.parse(patch);
  const existingRow = await getRow(actor, id, sql);
  if (!existingRow) return null;
  const existing = mapAutomation(existingRow);
  const next = adAutomationInputSchema.parse({
    name: parsedPatch.name ?? existing.name,
    active: parsedPatch.active ?? existing.active,
    workflow: parsedPatch.workflow ?? existing.workflow,
  });
  assertSafeCreative(next.workflow);
  const rows = await sql.query(
    `update studio_ad_automations
        set name = $4,
            active = $5,
            workflow = $6::jsonb,
            updated_by_user_id = $7::uuid,
            revision = revision + 1,
            next_run_at = $8::timestamptz
      where workspace_id = $1::uuid and id = $2::uuid and revision = $3::integer
      returning id::text, name, active, revision, workflow, next_run_at::text, created_at::text, updated_at::text`,
    [actor.workspaceId, id, parsedPatch.expectedRevision, next.name, next.active, JSON.stringify(next.workflow), actor.userId, nextRunAt(next)],
  ) as unknown as AutomationRow[];
  if (!rows[0]) throw new StudioContentConflictError("Annonsflödet ändrades på annat håll. Ladda om och försök igen.");
  return mapAutomation(rows[0]);
}

export async function deleteAdAutomation(
  actor: AppActor,
  automationId: string,
  sql: NeonSql = createNeonSql(),
): Promise<boolean> {
  assertCanWrite(actor);
  const id = adAutomationIdSchema.parse(automationId);
  const rows = await sql.query(
    `delete from studio_ad_automations
      where workspace_id = $1::uuid and id = $2::uuid
      returning id::text`,
    [actor.workspaceId, id],
  ) as unknown as Array<{ id: string }>;
  return Boolean(rows[0]);
}

/**
 * Records an idempotent private test request. It deliberately does not call an
 * AI provider, a social publisher, a newsletter service or an ad platform.
 */
export async function createAdAutomationManualTestReceipt(
  actor: AppActor,
  input: { automationId: string; idempotencyKey: string },
  sql: NeonSql = createNeonSql(),
): Promise<PreparedAdAutomationManualTest | null> {
  assertCanWrite(actor);
  const automationId = adAutomationIdSchema.parse(input.automationId);
  const idempotencyKey = adAutomationManualTestInputSchema.parse({ idempotencyKey: input.idempotencyKey }).idempotencyKey;
  const automationRow = await getRow(actor, automationId, sql);
  if (!automationRow) return null;
  const automation = mapAutomation(automationRow);
  assertSafeCreative(automation.workflow);

  const inserted = await sql.query(
    `insert into studio_ad_automation_test_receipts (
       workspace_id, automation_id, requested_by_user_id, idempotency_key, state, draft_id
     ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'queued', null)
     on conflict (workspace_id, automation_id, idempotency_key) do nothing
     returning id::text, automation_id::text, idempotency_key::text, state, draft_id::text, created_at::text, updated_at::text`,
    [actor.workspaceId, automationId, actor.userId, idempotencyKey],
  ) as unknown as TestReceiptRow[];
  const created = inserted[0];
  if (created) return { automation, receipt: mapReceipt(created), reused: false };

  const existingRows = await sql.query(
    `select id::text, automation_id::text, idempotency_key::text, state, draft_id::text, created_at::text, updated_at::text
       from studio_ad_automation_test_receipts
      where workspace_id = $1::uuid
        and automation_id = $2::uuid
        and idempotency_key = $3::uuid
      limit 1`,
    [actor.workspaceId, automationId, idempotencyKey],
  ) as unknown as TestReceiptRow[];
  const existing = existingRows[0];
  if (!existing) throw new Error("Testkvitto kunde inte återläsas.");
  return { automation, receipt: mapReceipt(existing), reused: true };
}

/**
 * Turns a manual receipt into one deterministic private creative-brief draft.
 * It calls no model and has no external delivery seam. Reusing the same UUID
 * returns the same receipt and draft.
 */
export async function runAdAutomationManualTest(
  actor: AppActor,
  input: { automationId: string; idempotencyKey: string },
  sql: NeonSql = createNeonSql(),
): Promise<PreparedAdAutomationManualTest | null> {
  const prepared = await createAdAutomationManualTestReceipt(actor, input, sql);
  if (!prepared) return null;
  const draft = await createPrivateAdAutomationDraft({
    workspaceId: actor.workspaceId,
    authorUserId: actor.userId,
    automationId: prepared.automation.id,
    automationName: prepared.automation.name,
    workflow: prepared.automation.workflow,
    source: { kind: "manual_test", id: prepared.receipt.id },
  }, sql);
  let receipt = prepared.receipt;
  if (receipt.state === "queued") {
    const rows = await sql.query(
      `update studio_ad_automation_test_receipts
          set state = 'completed', draft_id = $4::uuid
        where workspace_id = $1::uuid and automation_id = $2::uuid and id = $3::uuid
          and state = 'queued'
        returning id::text, automation_id::text, idempotency_key::text, state, draft_id::text, created_at::text, updated_at::text`,
      [actor.workspaceId, prepared.automation.id, receipt.id, draft.id],
    ) as unknown as TestReceiptRow[];
    if (rows[0]) receipt = mapReceipt(rows[0]);
    else {
      const existing = await readTestReceipt(sql, actor.workspaceId, prepared.automation.id, input.idempotencyKey);
      if (!existing) throw new Error("Det privata testkvittot kunde inte uppdateras.");
      receipt = mapReceipt(existing);
    }
  }
  return { ...prepared, receipt, draft };
}

async function readTestReceipt(
  sql: NeonSql,
  workspaceId: string,
  automationId: string,
  idempotencyKey: string,
): Promise<TestReceiptRow | null> {
  const rows = await sql.query(
    `select id::text, automation_id::text, idempotency_key::text, state, draft_id::text, created_at::text, updated_at::text
       from studio_ad_automation_test_receipts
      where workspace_id = $1::uuid
        and automation_id = $2::uuid
        and idempotency_key = $3::uuid
      limit 1`,
    [workspaceId, automationId, idempotencyKey],
  ) as unknown as TestReceiptRow[];
  return rows[0] ?? null;
}

/** Exposed for UI type documentation without letting a route write an arbitrary workflow. */
export function workflowFromAdAutomation(automation: AdAutomationView): AdAutomationWorkflow {
  return automation.workflow;
}
