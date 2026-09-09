import { describe, expect, it, vi } from "vitest";
import type { NeonSql } from "@/lib/neon/database";
import {
  claimDueAdAutomationRun,
  materializeAdAutomationRuns,
  processClaimedAdAutomationRun,
  type ClaimedAdAutomationRun,
} from "@/lib/neon/ad-automation-worker";
import { validAdAutomationInput } from "@/tests/fixtures/ad-automation";

const workspaceId = "22222222-2222-4222-8222-222222222222";
const userId = "11111111-1111-4111-8111-111111111111";
const automationId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const claimToken = "55555555-5555-4555-8555-555555555555";
const draftId = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-08-24T06:00:00.000Z");

function sqlWith(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { sql: { query } as unknown as NeonSql, query };
}

function scheduledInput() {
  const input = validAdAutomationInput();
  return {
    ...input,
    active: true,
    workflow: {
      ...input.workflow,
      trigger: { kind: "schedule" as const, summary: "Varje tisdag" },
      schedule: {
        mode: "weekly_count" as const,
        timezone: "Europe/Stockholm",
        weeklyCount: 1,
        weekdays: [1],
        localTimes: ["09:00"],
        cronExpression: null,
        startsOn: null,
        endsOn: null,
      },
      creative: {
        ...input.workflow.creative,
        creativeBrief: {
          ...input.workflow.creative.creativeBrief,
          customVisualDirection: "",
        },
      },
    },
  };
}

describe("SAGA ad automation worker", () => {
  it("materializes revision-scoped scheduled receipts after rechecking a safe creative", async () => {
    const input = scheduledInput();
    const { sql, query } = sqlWith([], [{
      id: automationId,
      workspace_id: workspaceId,
      created_by_user_id: userId,
      name: input.name,
      active: true,
      revision: 1,
      workflow: input.workflow,
    }], [{ id: runId }], []);

    const result = await materializeAdAutomationRuns({ now, horizonDays: 2, sql });
    expect(result).toEqual({ automationsScanned: 1, runsCreated: 1, nextRunsUpdated: 1, unsafeFlowsSkipped: 0 });
    expect(query.mock.calls[0]?.[0]).toContain("studio_ad_automation_scheduler_cursors");
    expect(query.mock.calls[1]?.[0]).toContain("studio_ad_automations");
    expect(query.mock.calls[1]?.[0]).toContain("workspace_rank = 1");
    expect(query.mock.calls[2]?.[0]).toContain("on conflict (workspace_id, automation_id, workflow_revision, scheduled_for) do nothing");
    expect(query.mock.calls[2]?.[0]).not.toContain("publish");
    expect(query.mock.calls[3]?.[0]).toContain("next_run_at");
  });

  it("skips a stored shock scene instead of turning it into a scheduled job", async () => {
    const input = scheduledInput();
    input.workflow.creative.creativeBrief.customVisualDirection = "Ett hjul faller från en balkong mot människor på gatan nedan.";
    const { sql, query } = sqlWith([], [{
      id: automationId,
      workspace_id: workspaceId,
      created_by_user_id: userId,
      name: input.name,
      active: true,
      revision: 1,
      workflow: input.workflow,
    }]);

    const result = await materializeAdAutomationRuns({ now, sql });
    expect(result).toEqual({ automationsScanned: 1, runsCreated: 0, nextRunsUpdated: 0, unsafeFlowsSkipped: 1 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("writes only a deterministic private Studio draft from a claimed run", async () => {
    const input = scheduledInput();
    const claim: ClaimedAdAutomationRun = {
      id: runId,
      workspace_id: workspaceId,
      automation_id: automationId,
      workflow_revision: 1,
      scheduled_for: "2026-08-24T07:00:00.000Z",
      claim_token: claimToken,
      automation: {
        id: automationId,
        workspaceId,
        authorUserId: userId,
        name: input.name,
        revision: 1,
        workflow: input.workflow,
      },
    };
    const { sql, query } = sqlWith(
      [],
      [{ id: draftId, title: "Annonsutkast: Sätra", status: "draft", scheduled_at: null }],
      [{ id: runId }],
    );

    const result = await processClaimedAdAutomationRun(claim, { now, sql });
    expect(result).toEqual({ runId, status: "draft_created", draftId });
    expect(query.mock.calls[1]?.[0]).toContain("insert into studio_drafts");
    expect(query.mock.calls[1]?.[0]).not.toContain("publish");
    expect(query.mock.calls[1]?.[1]?.[3]).toContain("deterministiskt kreativt underlag");
    expect(JSON.parse(query.mock.calls[1]?.[1]?.[4] as string)).toMatchObject({
      adAutomationRunId: runId,
      adAutomationDraftKind: "deterministic_creative_brief",
      adAutomationDeliveryLocked: true,
      approvalRequired: true,
      adAutomationQuality: {
        version: "saga-production-quality/v1",
        decision: "review_required",
        canCreatePrivateDraft: true,
        canEnterCalendar: false,
        canDeliver: false,
      },
    });
    expect(query.mock.calls[2]?.[0]).toContain("state = 'completed'");
  });

  it("reclaims only an expired lease with remaining attempts and records the lease deadline atomically", async () => {
    const input = scheduledInput();
    const { sql, query } = sqlWith(
      [],
      [{
        id: runId,
        workspace_id: workspaceId,
        automation_id: automationId,
        workflow_revision: 1,
        scheduled_for: "2026-08-24T06:00:00.000Z",
        claim_token: claimToken,
      }],
      [{
        id: automationId,
        workspace_id: workspaceId,
        created_by_user_id: userId,
        name: input.name,
        revision: 1,
        workflow: input.workflow,
      }],
    );
    const claimed = await claimDueAdAutomationRun(now, "vercel-ad-test", sql);
    expect(claimed).toMatchObject({ id: runId, automation: { id: automationId } });
    expect(query.mock.calls[0]?.[0]).toContain("studio_ad_automation_scheduler_cursors");
    expect(query.mock.calls[1]?.[0]).toContain("run.state = 'running'");
    expect(query.mock.calls[1]?.[0]).toContain("workspace_rank = 1");
    expect(query.mock.calls[1]?.[0]).toContain("run.lease_expires_at");
    expect(query.mock.calls[1]?.[0]).toContain("attempts = claimed.attempts + 1");
    expect(query.mock.calls[1]?.[0]).toContain("lease_expires_at = $4::timestamptz");
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["vercel-ad-test"]));
  });

  it("cancels a claimed receipt when its active revision changes before the private draft insert", async () => {
    const input = scheduledInput();
    const claim: ClaimedAdAutomationRun = {
      id: runId,
      workspace_id: workspaceId,
      automation_id: automationId,
      workflow_revision: 1,
      scheduled_for: "2026-08-24T07:00:00.000Z",
      claim_token: claimToken,
      automation: {
        id: automationId,
        workspaceId,
        authorUserId: userId,
        name: input.name,
        revision: 1,
        workflow: input.workflow,
      },
    };
    // Existing-draft lookup, guarded INSERT, conflict re-read and active
    // revision re-check all find no row; the receipt must be cancelled.
    const { sql, query } = sqlWith([], [], [], [], []);

    const result = await processClaimedAdAutomationRun(claim, { now, sql });

    expect(result).toEqual({ runId, status: "cancelled", code: "automation_reconfigured" });
    expect(query.mock.calls[1]?.[0]).toContain("from studio_ad_automations as current");
    expect(query.mock.calls[1]?.[0]).toContain("current.revision = $7::integer");
    expect(query.mock.calls[4]?.[0]).toContain("state = 'cancelled'");
  });
});
