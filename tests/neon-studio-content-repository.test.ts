import { describe, expect, it, vi } from "vitest";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";

vi.mock("@/lib/neon/saga-brand-api-eligibility", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/neon/saga-brand-api-eligibility")>(),
  resolveSagaBrandActor: vi.fn(async (actor: AppActor, requested?: string | null) => ({
    ...actor, brandProfileId: requested ?? "abababab-abab-4bab-8bab-abababababab",
  })),
}));
import {
  StudioContentAccessError,
  StudioContentNotFoundError,
  claimStudioManualAutomationJob,
  claimDueStudioAutomationJobs,
  completeStudioAutomationJob,
  createStudioAutomation,
  createStudioManualAutomationJob,
  createStudioTemplate,
  failStudioAutomationJob,
  getStudioAutomationRunOverview,
  getStudioDraft,
  listStudioCalendarDrafts,
  materializeClaimedStudioAutomationDraft,
  materializeStudioAutomationJobs,
  updateStudioAutomation,
} from "@/lib/neon/studio-content-repository";

const actor: AppActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  email: "owner@example.com",
  displayName: "Owner",
};

const draftId = "33333333-3333-4333-8333-333333333333";
const mediaId = "44444444-4444-4444-8444-444444444444";
const templateId = "55555555-5555-4555-8555-555555555555";
const seriesId = "56565656-5656-4565-8565-565656565656";
const automationId = "66666666-6666-4666-8666-666666666666";
const jobId = "77777777-7777-4777-8777-777777777777";
const claimToken = "88888888-8888-4888-8888-888888888888";

function sqlWith(...responses: unknown[]) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  return { sql: { query } as unknown as NeonSql, query };
}

const draftRow = {
  id: draftId,
  author_user_id: actor.userId,
  brand_profile_id: "abababab-abab-4bab-8bab-abababababab",
  template_id: null,
  content_type: "social_post",
  status: "draft",
  title: "Viktigt i dag",
  body: "Kort och rakt.",
  excerpt: null,
  publication_channels: ["linkedin"],
  metadata: { hashtags: ["#ai"], language: "sv", timezone: "Europe/Stockholm", approvalRequired: true },
  scheduled_at: null,
  published_at: null,
  created_at: "2026-08-23T09:00:00.000Z",
  updated_at: "2026-08-23T09:00:00.000Z",
};

const automationRow = {
  id: automationId,
  brand_profile_id: "abababab-abab-4bab-8bab-abababababab",
  created_by_user_id: actor.userId,
  template_id: null,
  name: "Veckans inlägg",
  content_type: "social_post",
  schedule_kind: "trigger",
  cron_expression: null,
  trigger_config: {
    scheduleMode: "weekly_count",
    weeklyCount: 1,
    weekdays: [1],
    localTimes: ["09:00"],
    startsOn: null,
    endsOn: null,
  },
  generation_config: {
    channels: ["linkedin"],
    newsletterAudienceId: null,
    generationPrompt: "Skriv sakligt.",
    imagePrompt: "",
    desiredLength: null,
    tone: null,
    language: "sv",
    timezone: "Europe/Stockholm",
  },
  enabled: true,
  approval_required: true,
  next_run_at: "2026-08-24T07:00:00.000Z",
  last_run_at: null,
  created_at: "2026-08-23T09:00:00.000Z",
  updated_at: "2026-08-23T09:00:00.000Z",
};

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: jobId,
    workspace_id: actor.workspaceId,
    automation_id: automationId,
    draft_id: null,
    kind: "draft_generation",
    status: "queued",
    idempotency_key: null,
    claim_token: null,
    run_after: "2026-08-24T07:00:00.000Z",
    started_at: null,
    completed_at: null,
    lease_expires_at: null,
    locked_by: null,
    attempts: 0,
    max_attempts: 3,
    payload: {
      triggerKind: "scheduled",
      timezone: "Europe/Stockholm",
      scheduledLocalDate: "2026-08-24",
      scheduledLocalTime: "09:00",
    },
    result: {},
    failure_code: null,
    failure_detail: null,
    created_at: "2026-08-23T09:00:00.000Z",
    updated_at: "2026-08-23T09:00:00.000Z",
    ...overrides,
  };
}

describe("Neon Studio content repository", () => {
  it("cannot reassign a persisted automation to another brand", async () => {
    const { sql, query } = sqlWith([automationRow]);
    await expect(updateStudioAutomation(actor, automationId, {
      brandProfileId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
    }, sql)).rejects.toMatchObject({ code: "brand_not_found" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("saga_daily_knowledge_brand_is_eligible(workspace_id, brand_profile_id)");
  });

  it("reads a draft and exposes a protected same-origin media path, never the Blob URL", async () => {
    const { sql, query } = sqlWith([draftRow], [{
      id: mediaId,
      draft_id: draftId,
      blob_url: "https://private.blob.vercel-storage.com/workspace/photo.jpg",
      blob_pathname: "workspace/photo.jpg",
      content_type: "image/jpeg",
      byte_size: 42,
      kind: "upload",
      status: "ready",
      alt_text: "Foto",
      metadata: { contentKind: "image", source: "upload", processingStatus: "ready", sortOrder: 0 },
      created_at: "2026-08-23T09:00:00.000Z",
      updated_at: "2026-08-23T09:00:00.000Z",
    }]);

    const draft = await getStudioDraft(actor, draftId, sql);

    expect(draft?.brandProfileId).toBe(draftRow.brand_profile_id);
    expect(draft?.media).toEqual([expect.objectContaining({
      id: mediaId,
      assetUrl: `/api/content/drafts/${draftId}/media/${mediaId}/asset`,
    })]);
    const [draftQuery, draftParams] = query.mock.calls[0] ?? [];
    expect(draftQuery).toContain("workspace_id = $1::uuid and id = $2::uuid");
    expect(draftQuery).toContain("brand_profile_id::text");
    expect(draftQuery).not.toContain(actor.workspaceId);
    expect(draftParams).toEqual([actor.workspaceId, draftId, null]);
  });

  it("writes a workspace-scoped template with rich UI data retained in JSON", async () => {
    const { sql, query } = sqlWith([], [{
      id: templateId,
      created_by_user_id: actor.userId,
      name: "Veckans AI-svep",
      content_type: "social_post",
      title_template: "AI: {{headline}}",
      body_template: "{{body}}",
      prompt: "Skriv rakt på sak.",
      channel_defaults: { channels: ["linkedin"] },
      metadata: {
        slug: "veckans-ai-svep",
        description: "En sammanhängande veckosummering.",
        defaultHashtags: ["#AI"],
        imagePrompt: "Ljus redaktionell illustration",
        defaultLanguage: "sv",
      },
      is_active: true,
      created_at: "2026-08-23T09:00:00.000Z",
      updated_at: "2026-08-23T09:00:00.000Z",
    }]);

    const template = await createStudioTemplate(actor, {
      slug: "veckans-ai-svep",
      name: "Veckans AI-svep",
      description: "En sammanhängande veckosummering.",
      contentType: "social_post",
      channels: ["linkedin"],
      defaultTitle: "AI: {{headline}}",
      defaultHeadline: null,
      defaultSubject: null,
      defaultBody: "{{body}}",
      defaultCta: null,
      defaultExcerpt: null,
      defaultHashtags: ["#AI"],
      generationPrompt: "Skriv rakt på sak.",
      imagePrompt: "Ljus redaktionell illustration",
      defaultLanguage: "sv",
      active: true,
    }, sql);

    expect(template).toMatchObject({ id: templateId, slug: "veckans-ai-svep", channels: ["linkedin"] });
    expect(query).toHaveBeenCalledTimes(2);
    const [slugQuery, slugParams] = query.mock.calls[0] ?? [];
    expect(slugQuery).toContain("workspace_id = $1::uuid");
    expect(slugParams).toEqual([actor.workspaceId, "veckans-ai-svep", null]);
    const [insertQuery, insertParams] = query.mock.calls[1] ?? [];
    expect(insertQuery).toContain("insert into studio_templates");
    expect(insertParams?.[0]).toBe(actor.workspaceId);
    expect(JSON.parse(insertParams?.[7] as string)).toEqual({ channels: ["linkedin"] });
    expect(JSON.parse(insertParams?.[8] as string)).toMatchObject({ slug: "veckans-ai-svep", imagePrompt: "Ljus redaktionell illustration" });
  });

  it("blocks an automation that references a template outside the trusted workspace", async () => {
    const { sql, query } = sqlWith([]);

    await expect(createStudioAutomation(actor, {
      name: "LinkedIn varje måndag",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId,
      newsletterAudienceId: null,
      generationPrompt: "Skriv sakligt.",
      imagePrompt: "",
      desiredLength: null,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [1],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    }, sql)).rejects.toBeInstanceOf(StudioContentNotFoundError);

    expect(query).toHaveBeenCalledTimes(1);
    const [lookupQuery, lookupParams] = query.mock.calls[0] ?? [];
    expect(lookupQuery).toContain("from studio_templates");
    expect(lookupParams).toEqual([actor.workspaceId, templateId]);
  });

  it("stores only an active same-workspace Series reference, never a browser snapshot", async () => {
    const { sql, query } = sqlWith(
      [{ id: seriesId }],
      [{
        ...automationRow,
        generation_config: { ...automationRow.generation_config, seriesId },
      }],
    );

    const automation = await createStudioAutomation(actor, {
      name: "LinkedIn varje måndag",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      seriesId,
      newsletterAudienceId: null,
      generationPrompt: "Skriv sakligt.",
      imagePrompt: "",
      desiredLength: null,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [1],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    }, sql);

    expect(automation.seriesId).toBe(seriesId);
    const [seriesQuery, seriesParams] = query.mock.calls[0] ?? [];
    expect(seriesQuery).toContain("from saga_series_references");
    expect(seriesQuery).toContain("workspace_id = $1::uuid");
    expect(seriesParams).toEqual([actor.workspaceId, seriesId, automationRow.brand_profile_id]);
    expect(seriesQuery).toContain("draft.brand_profile_id = $3::uuid");
    const [, insertParams] = query.mock.calls[1] ?? [];
    expect(JSON.parse(insertParams?.[8] as string)).toMatchObject({ seriesId });
    expect(JSON.parse(insertParams?.[8] as string).automationConfigurationVersion).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("rejects an inactive or foreign Series before writing an automation", async () => {
    const { sql, query } = sqlWith([]);

    await expect(createStudioAutomation(actor, {
      name: "LinkedIn varje måndag",
      active: true,
      contentType: "social_post",
      channels: ["linkedin"],
      templateId: null,
      seriesId,
      newsletterAudienceId: null,
      generationPrompt: "Skriv sakligt.",
      imagePrompt: "",
      desiredLength: null,
      tone: null,
      language: "sv",
      approvalRequired: true,
      timezone: "Europe/Stockholm",
      scheduleMode: "weekly_count",
      weeklyCount: 1,
      weekdays: [1],
      localTimes: ["09:00"],
      cronExpression: null,
      startsOn: null,
      endsOn: null,
    }, sql)).rejects.toBeInstanceOf(StudioContentNotFoundError);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("from saga_series_references");
    expect(query.mock.calls[0]?.[0]).not.toContain("insert into studio_automations");
  });

  it("uses actor scope and local calendar bounds for scheduled draft reads", async () => {
    const { sql, query } = sqlWith([{
      ...draftRow,
      status: "scheduled",
      scheduled_at: "2026-08-25T07:00:00.000Z",
      metadata: {
        ...draftRow.metadata,
        scheduledLocalDate: "2026-08-25",
        scheduledLocalTime: "09:00",
      },
    }]);

    const drafts = await listStudioCalendarDrafts(actor, {
      from: "2026-08-25",
      to: "2026-08-31",
      timezone: "Europe/Stockholm",
    }, sql);

    expect(drafts).toHaveLength(1);
    const [calendarQuery, params] = query.mock.calls[0] ?? [];
    expect(calendarQuery).toContain("workspace_id = $1::uuid");
    expect(calendarQuery).toContain("at time zone $4::text");
    expect(params).toEqual([actor.workspaceId, "2026-08-25", "2026-08-31", "Europe/Stockholm"]);
  });

  it("reads bounded durable run receipts with only a private draft outcome", async () => {
    const { sql, query } = sqlWith(
      [automationRow],
      [jobRow({
        draft_id: draftId,
        status: "completed",
        attempts: 2,
        completed_at: "2026-08-24T07:00:08.000Z",
        failure_code: null,
        failure_detail: null,
        outcome_draft_title: "Ett privat systemutkast",
        outcome_draft_status: "draft",
      })],
    );

    const overview = await getStudioAutomationRunOverview(actor, { limit: 12 }, sql);

    expect(overview).toMatchObject({
      automations: [{ id: automationId, name: "Veckans inlägg" }],
      runs: [{
        id: jobId,
        automationRuleId: automationId,
        automationName: "Veckans inlägg",
        state: "completed",
        maxAttemptCount: 3,
        draft: { id: draftId, title: "Ett privat systemutkast", status: "draft" },
      }],
    });
    expect(query).toHaveBeenCalledTimes(2);
    const [automationQuery, automationParams] = query.mock.calls[0] ?? [];
    expect(automationQuery).toContain("from studio_automations");
    expect(automationParams).toEqual([actor.workspaceId]);
    const [runQuery, runParams] = query.mock.calls[1] ?? [];
    expect(runQuery).toContain("from studio_jobs as job");
    expect(runQuery).toContain("inner join studio_automations as automation");
    expect(runQuery).toContain("left join studio_drafts as outcome");
    expect(runQuery).toContain("job.workspace_id = $1::uuid");
    expect(runQuery).not.toContain("outcome.body");
    expect(runQuery).not.toContain("blob_url");
    expect(runParams).toEqual([actor.workspaceId, 12]);
  });

  it("creates one idempotent manual receipt that is explicitly private and unscheduled", async () => {
    const now = new Date("2026-08-23T08:00:00.000Z");
    const { sql, query } = sqlWith([automationRow], [jobRow({
      idempotency_key: "99999999-9999-4999-8999-999999999999",
      payload: {
        triggerKind: "manual",
        timezone: "Europe/Stockholm",
        scheduledLocalDate: "2026-08-23",
        scheduledLocalTime: "10:00",
      },
      run_after: now.toISOString(),
    })]);

    const prepared = await createStudioManualAutomationJob(actor, {
      automationId,
      idempotencyKey: "99999999-9999-4999-8999-999999999999",
      now,
    }, sql);

    expect(prepared).toMatchObject({ reused: false, job: { triggerKind: "manual", state: "queued", scheduledFor: now.toISOString() } });
    expect(query).toHaveBeenCalledTimes(2);
    const [insertQuery, params] = query.mock.calls[1] ?? [];
    expect(insertQuery).toContain("on conflict (workspace_id, idempotency_key) do nothing");
    expect(params?.slice(0, 4)).toEqual([actor.workspaceId, automationId, "99999999-9999-4999-8999-999999999999", now.toISOString()]);
    expect(JSON.parse(params?.[4] as string)).toMatchObject({ triggerKind: "manual", timezone: "Europe/Stockholm" });
  });

  it("returns the existing manual receipt when the same UUID is retried", async () => {
    const idempotencyKey = "99999999-9999-4999-8999-999999999999";
    const { sql, query } = sqlWith(
      [automationRow],
      [],
      [jobRow({
        idempotency_key: idempotencyKey,
        payload: { triggerKind: "manual", timezone: "Europe/Stockholm" },
      })],
    );

    const prepared = await createStudioManualAutomationJob(actor, { automationId, idempotencyKey }, sql);

    expect(prepared).toMatchObject({ reused: true, job: { id: jobId, triggerKind: "manual" } });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[0]).toContain("and idempotency_key = $3");
  });

  it("claims only the actor's exact manual receipt, never another due automation", async () => {
    const now = new Date("2026-08-23T08:00:00.000Z");
    const manualKey = "99999999-9999-4999-8999-999999999999";
    const { sql, query } = sqlWith(
      [automationRow],
      [jobRow({
        status: "running",
        idempotency_key: manualKey,
        claim_token: claimToken,
        started_at: now.toISOString(),
        lease_expires_at: "2026-08-23T08:12:00.000Z",
        payload: {
          triggerKind: "manual",
          timezone: "Europe/Stockholm",
          scheduledLocalDate: "2026-08-23",
          scheduledLocalTime: "10:00",
        },
      })],
    );

    const claim = await claimStudioManualAutomationJob(actor, {
      automationId,
      idempotencyKey: manualKey,
      now,
      workerId: "studio-click",
    }, sql);

    expect(claim).toMatchObject({ id: jobId, claimToken: expect.stringMatching(/^[0-9a-f-]{36}$/i), rule: { id: automationId } });
    const [claimQuery, params] = query.mock.calls[1] ?? [];
    expect(claimQuery).toContain("job.workspace_id = $2::uuid");
    expect(claimQuery).toContain("job.idempotency_key = $7");
    expect(claimQuery).toContain("triggerKind', 'scheduled') = 'manual'");
    expect(claimQuery).toContain("job.run_after <= $1::timestamptz");
    expect(params).toEqual(expect.arrayContaining([actor.workspaceId, automationId, manualKey, "studio-click"]));
  });

  it("materializes schedule receipts idempotently without publishing", async () => {
    const cronRule = {
      ...automationRow,
      workspace_id: actor.workspaceId,
      generation_config: {
        ...automationRow.generation_config,
        automationConfigurationVersion: "99999999-9999-4999-8999-999999999999",
      },
      schedule_kind: "cron",
      cron_expression: "0 9 * * *",
      trigger_config: {
        scheduleMode: "cron",
        weeklyCount: null,
        weekdays: [],
        localTimes: ["09:00"],
        startsOn: null,
        endsOn: null,
      },
    };
    const { sql, query } = sqlWith([cronRule], [{ id: jobId }], []);

    const result = await materializeStudioAutomationJobs({
      now: new Date("2026-08-23T00:00:00.000Z"),
      horizonDays: 1,
      ruleLimit: 1,
      jobLimit: 1,
    }, sql);

    expect(result).toEqual({ rulesScanned: 1, jobsCreated: 1, nextRunsUpdated: 1 });
    const [insertQuery, params] = query.mock.calls[1] ?? [];
    expect(insertQuery).toContain("insert into studio_jobs");
    expect(insertQuery).toContain("on conflict do nothing");
    expect(params?.[0]).toBe(actor.workspaceId);
    expect(JSON.parse(params?.[3] as string)).toMatchObject({
      triggerKind: "scheduled",
      automationConfigurationVersion: "99999999-9999-4999-8999-999999999999",
      timezone: "Europe/Stockholm",
    });
  });

  it("claims one due job with a lease token and no caller-controlled workspace", async () => {
    const now = new Date("2026-08-24T08:00:00.000Z");
    const { sql, query } = sqlWith([jobRow({
      status: "running",
      claim_token: claimToken,
      started_at: now.toISOString(),
      lease_expires_at: "2026-08-24T08:12:00.000Z",
      attempts: 1,
    })], [automationRow]);

    const claims = await claimDueStudioAutomationJobs({ now, limit: 1, workerId: "cron-test" }, sql);

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ id: jobId, state: "processing", rule: { id: automationId } });
    expect(claims[0]?.claimToken).toMatch(/^[0-9a-f-]{36}$/i);
    const [claimQuery, params] = query.mock.calls[0] ?? [];
    expect(claimQuery).toContain("for update of job skip locked");
    expect(claimQuery).toContain("claim_token = $2::uuid");
    expect(params).not.toContain(actor.workspaceId);
  });

  it("persists exactly one private manual draft behind a live claim token", async () => {
    const now = new Date("2026-08-24T08:00:00.000Z");
    const persistedDraft = {
      ...draftRow,
      automation_job_id: jobId,
      title: "Manuellt utkast",
      metadata: { ...draftRow.metadata, automationJobId: jobId, automationRuleId: automationId },
    };
    const { sql, query } = sqlWith(
      [jobRow({
        status: "running",
        claim_token: claimToken,
        idempotency_key: "99999999-9999-4999-8999-999999999999",
        started_at: now.toISOString(),
        lease_expires_at: "2026-08-24T08:12:00.000Z",
        payload: {
          triggerKind: "manual",
          timezone: "Europe/Stockholm",
          scheduledLocalDate: "2026-08-24",
          scheduledLocalTime: "10:00",
        },
      })],
      [automationRow],
      [],
      [persistedDraft],
      [],
      [{ workspace_id: actor.workspaceId, automation_id: automationId }],
      [],
    );

    const draft = await materializeClaimedStudioAutomationDraft({
      jobId,
      claimToken,
      now,
      content: { title: "Manuellt utkast", body: "Redigerbart innan publicering." },
    }, sql);

    expect(draft).toMatchObject({
      id: draftId,
      status: "draft",
      scheduledAt: null,
      automationJobId: jobId,
    });
    const [insertQuery, params] = query.mock.calls[3] ?? [];
    expect(insertQuery).toContain("automation_job_id");
    expect(insertQuery).toContain("current_rule.brand_profile_id = $16::uuid");
    expect(insertQuery).toContain("with current_lease as materialized");
    expect(insertQuery).toContain("claim_token = $17::uuid");
    expect(insertQuery).toContain("for update");
    expect(insertQuery).toContain("current_job.lease_expires_at > clock_timestamp()");
    expect(insertQuery).toContain("saga_daily_knowledge_brand_is_eligible(current_rule.workspace_id, current_rule.brand_profile_id)");
    expect(insertQuery).not.toContain("where $14::boolean");
    expect(insertQuery).toContain("on conflict (workspace_id, automation_job_id)");
    expect(params?.[3]).toBe(jobId);
    expect(params?.[5]).toBe("draft");
    expect(params?.[15]).toBe(automationRow.brand_profile_id);
    expect(params?.[16]).toBe(claimToken);
    expect(JSON.parse(params?.[10] as string)).toMatchObject({ automationJobId: jobId });
    expect(query.mock.calls[5]?.[0]).toContain("set status = 'completed'");
    for (const index of [0,4,5]) {
      expect(query.mock.calls[index]?.[0]).toContain("lease_expires_at > clock_timestamp()");
    }
  });

  it("keeps a scheduled generation receipt private until an editor schedules it", async () => {
    const persistedDraft = {
      ...draftRow,
      automation_job_id: jobId,
      status: "draft",
      scheduled_at: null,
      metadata: { ...draftRow.metadata, automationJobId: jobId, automationRuleId: automationId },
    };
    const { sql, query } = sqlWith(
      [jobRow({ status: "running", claim_token: claimToken })],
      [{ ...automationRow, approval_required: false }],
      [],
      [persistedDraft],
      [],
      [{ workspace_id: actor.workspaceId, automation_id: automationId }],
      [],
    );

    const draft = await materializeClaimedStudioAutomationDraft({
      jobId,
      claimToken,
      content: { title: "Schemat skapar bara ett utkast", body: "Redaktören avgör om och när detta går ut." },
    }, sql);

    expect(draft).toMatchObject({ status: "draft", scheduledAt: null, scheduledLocalDate: null, scheduledLocalTime: null });
    const [, params] = query.mock.calls[3] ?? [];
    expect(params?.[5]).toBe("draft");
    expect(params?.[11]).toBeNull();
  });

  it("cancels a scheduled lease at final write when its automation was paused or changed", async () => {
    const now = new Date("2026-08-24T08:00:00.000Z");
    const expectedAutomationConfigurationVersion = "99999999-9999-4999-8999-999999999999";
    const { sql, query } = sqlWith(
      [jobRow({
        status: "running",
        claim_token: claimToken,
        payload: {
          triggerKind: "scheduled",
          automationConfigurationVersion: expectedAutomationConfigurationVersion,
          timezone: "Europe/Stockholm",
          scheduledLocalDate: "2026-08-24",
          scheduledLocalTime: "09:00",
        },
      })],
      [{
        ...automationRow,
        // A scheduler update can legitimately change updated_at; only the
        // independent configuration marker decides this final-write guard.
        updated_at: "2026-08-24T07:30:00.000Z",
        generation_config: {
          ...automationRow.generation_config,
          automationConfigurationVersion: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      }],
      [],
      [],
      [],
      [],
    );

    const draft = await materializeClaimedStudioAutomationDraft({
      jobId,
      claimToken,
      now,
      content: { title: "Får inte sparas", body: "Regeln är inte längre samma regel." },
    }, sql);

    expect(draft).toBeNull();
    const [guardedInsert, guardedInsertParams] = query.mock.calls[3] ?? [];
    expect(guardedInsert).toContain("current_rule.enabled = true");
    expect(guardedInsert).toContain("current_rule.generation_config ->> 'automationConfigurationVersion' = $13::text");
    expect(guardedInsertParams?.[12]).toBe(expectedAutomationConfigurationVersion);
    expect(guardedInsertParams?.[13]).toBe(false);
    const [cancelQuery, cancelParams] = query.mock.calls[5] ?? [];
    expect(cancelQuery).toContain("status = 'cancelled'");
    expect(cancelQuery).toContain("failure_code = 'automation_reconfigured'");
    expect(cancelQuery).toContain("lease_expires_at > clock_timestamp()");
    expect(cancelParams).toEqual([jobId, claimToken, now.toISOString(), actor.workspaceId]);
  });

  it("reuses an already-persisted draft after a lease is reclaimed", async () => {
    const existingDraft = {
      ...draftRow,
      automation_job_id: jobId,
      metadata: { ...draftRow.metadata, automationJobId: jobId, automationRuleId: automationId },
    };
    const { sql, query } = sqlWith(
      [jobRow({ status: "running", claim_token: claimToken })],
      [automationRow],
      [existingDraft],
      [],
      [{ workspace_id: actor.workspaceId, automation_id: automationId }],
      [],
    );

    const draft = await materializeClaimedStudioAutomationDraft({
      jobId,
      claimToken,
      content: { title: "Ignoreras", body: "Det redan sparade utkastet återanvänds." },
    }, sql);

    expect(draft?.id).toBe(draftId);
    expect(query.mock.calls.some(([sqlText]) => String(sqlText).includes("insert into studio_drafts"))).toBe(false);
    expect(query.mock.calls[3]?.[0]).toContain("set draft_id = $3::uuid");
  });

  it("does not complete a stale or stolen lease", async () => {
    const { sql, query } = sqlWith([]);
    await expect(completeStudioAutomationJob({ jobId, claimToken }, sql)).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("status = 'running' and claim_token = $2::uuid");
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at > clock_timestamp()");
  });

  it("does not fail or retry an expired or stolen lease", async () => {
    const { sql, query } = sqlWith([]);
    await expect(failStudioAutomationJob({ jobId, claimToken, errorMessage: "Expired worker", retry: true }, sql)).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("lease_expires_at > clock_timestamp()");
  });

  it("rejects writes from a workspace viewer before reaching Neon", async () => {
    const { sql, query } = sqlWith();
    await expect(createStudioTemplate({ ...actor, role: "viewer" }, {
      name: "Låst mall",
      description: "Ska inte sparas.",
      contentType: "article",
      channels: [],
      defaultTitle: "",
      defaultHeadline: null,
      defaultSubject: null,
      defaultBody: "",
      defaultCta: null,
      defaultExcerpt: null,
      defaultHashtags: [],
      generationPrompt: "",
      imagePrompt: "",
      defaultLanguage: "sv",
      active: false,
    }, sql)).rejects.toBeInstanceOf(StudioContentAccessError);
    expect(query).not.toHaveBeenCalled();
  });
});
