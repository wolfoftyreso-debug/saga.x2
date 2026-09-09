import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  createAdAutomation,
  createAdAutomationManualTestReceipt,
  updateAdAutomation,
} from "@/lib/neon/ad-automation-repository";
import { StudioContentAccessError, StudioContentConflictError } from "@/lib/neon/studio-content-repository";
import { adAutomationCreateIdempotencyKey, validAdAutomationCreateInput, validAdAutomationInput } from "@/tests/fixtures/ad-automation";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.test",
  displayName: "Owner",
};
const automationId = "33333333-3333-4333-8333-333333333333";
const receiptId = "44444444-4444-4444-8444-444444444444";
const idempotencyKey = "55555555-5555-4555-8555-555555555555";
const now = "2026-08-25T09:00:00.000Z";

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

function automationRow(overrides: Record<string, unknown> = {}) {
  const input = validAdAutomationInput();
  return {
    id: automationId,
    name: input.name,
    active: input.active,
    revision: 1,
    workflow: input.workflow,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: receiptId,
    automation_id: automationId,
    idempotency_key: idempotencyKey,
    state: "queued",
    draft_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("Neon ad automation repository", () => {
  it("stores a complete, workspace-scoped canvas and reports destinations as unavailable instead of publishable", async () => {
    const { sql, query } = sqlWith([automationRow()]);
    const saved = await createAdAutomation(actor, validAdAutomationCreateInput(), sql);

    expect(saved).toMatchObject({ reused: false, automation: { id: automationId, revision: 1, name: "Sätra – provkörningsannons" } });
    expect(saved.automation.destinations[0]).toMatchObject({
      provider: "meta_ads",
      execution: { status: "unavailable" },
    });
    expect(query.mock.calls[0]?.[0]).toContain("insert into studio_ad_automations");
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([actor.workspaceId, actor.userId]));
    const workflow = JSON.parse(query.mock.calls[0]?.[1]?.[5] as string);
    expect(workflow.creative.creativeBrief).toMatchObject({ hook: expect.any(String), callToAction: expect.any(String) });
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([adAutomationCreateIdempotencyKey]));
  });

  it("blocks a shock scene before it reaches Neon", async () => {
    const { sql, query } = sqlWith();
    const unsafe = validAdAutomationInput({
      workflow: {
        ...validAdAutomationInput().workflow,
        creative: {
          ...validAdAutomationInput().workflow.creative,
          creativeBrief: {
            ...validAdAutomationInput().workflow.creative.creativeBrief,
            customVisualDirection: "Ett hjul faller från en balkong mot en folksamling på gatan nedan.",
          },
        },
      },
    });
    await expect(createAdAutomation(actor, { ...unsafe, createIdempotencyKey: adAutomationCreateIdempotencyKey }, sql)).rejects.toMatchObject({ name: "SagaCreativeSafetyError", status: 422 });
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects viewer saves before reaching Neon", async () => {
    const { sql, query } = sqlWith();
    await expect(createAdAutomation({ ...actor, role: "viewer" }, validAdAutomationCreateInput(), sql)).rejects.toBeInstanceOf(StudioContentAccessError);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns the first automation after a create retry instead of duplicating the canvas", async () => {
    const { sql, query } = sqlWith([], [automationRow()]);
    const saved = await createAdAutomation(actor, validAdAutomationCreateInput(), sql);

    expect(saved).toMatchObject({ reused: true, automation: { id: automationId } });
    expect(query.mock.calls[0]?.[0]).toContain("on conflict (workspace_id, create_idempotency_key) do nothing");
    expect(query.mock.calls[1]?.[0]).toContain("create_idempotency_key = $2::uuid");
  });

  it("uses optimistic revision locking for full-flow saves", async () => {
    const { sql, query } = sqlWith([automationRow()], [automationRow({ revision: 2, name: "Sätra – ny annons" })]);
    const saved = await updateAdAutomation(actor, automationId, { name: "Sätra – ny annons", expectedRevision: 1 }, sql);

    expect(saved).toMatchObject({ name: "Sätra – ny annons", revision: 2 });
    expect(query.mock.calls[1]?.[0]).toContain("revision = revision + 1");
    expect(query.mock.calls[1]?.[0]).toContain("revision = $3::integer");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([actor.workspaceId, automationId, 1]));
  });

  it("reports a stale canvas save as a conflict instead of overwriting another editor", async () => {
    const { sql } = sqlWith([automationRow()], []);
    await expect(updateAdAutomation(actor, automationId, { name: "Sen ändring", expectedRevision: 1 }, sql))
      .rejects.toBeInstanceOf(StudioContentConflictError);
  });

  it("creates one idempotent private test receipt and makes no external call", async () => {
    const { sql, query } = sqlWith([automationRow()], [receiptRow()]);
    const prepared = await createAdAutomationManualTestReceipt(actor, { automationId, idempotencyKey }, sql);

    expect(prepared).toMatchObject({ reused: false, receipt: { state: "queued", draftId: null } });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]?.[0]).toContain("studio_ad_automation_test_receipts");
    expect(query.mock.calls[1]?.[0]).toContain("on conflict (workspace_id, automation_id, idempotency_key) do nothing");
    expect(query.mock.calls[1]?.[0]).not.toContain("publish");
    expect(query.mock.calls[1]?.[1]).toEqual([actor.workspaceId, automationId, actor.userId, idempotencyKey]);
  });

  it("reuses a test receipt instead of consuming an external provider retry", async () => {
    const { sql, query } = sqlWith([automationRow()], [], [receiptRow()]);
    const prepared = await createAdAutomationManualTestReceipt(actor, { automationId, idempotencyKey }, sql);

    expect(prepared).toMatchObject({ reused: true, receipt: { id: receiptId, draftId: null } });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain("and idempotency_key = $3::uuid");
  });
});
