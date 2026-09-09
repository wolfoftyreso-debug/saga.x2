import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentAutomationRuleInputSchema } from "@/lib/domain/content-studio";
import { calculateSagaBrandOnboardingDecisionSupport, sagaBrandOnboardingDraftSchema } from "@/lib/domain/saga-brand-onboarding";
import type { AppActor } from "@/lib/neon/auth-repository";
import type { NeonSql } from "@/lib/neon/database";
import {
  claimDueStudioAutomationJobs, claimStudioManualAutomationJob, createStudioAutomation,
  createStudioManualAutomationJob, materializeClaimedStudioAutomationDraft,
  completeStudioAutomationJob, failStudioAutomationJob, materializeStudioAutomationJobs, updateStudioAutomation,
} from "@/lib/neon/studio-content-repository";

let db: PGlite;
const sql = { query: async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows } as unknown as NeonSql;
const historical: Array<{ actor: AppActor; ruleId: string; brand: string | null; jobId: string }> = [];

async function owner(): Promise<AppActor> {
  const workspaceId = randomUUID(), userId = randomUUID();
  await db.query("insert into app_workspaces(id,slug,name) values($1,$2,'QA Studio')", [workspaceId, `qa-${workspaceId}`]);
  await db.query("insert into app_users(id,vercel_subject) values($1,$2)", [userId, `qa-${userId}`]);
  await db.query("insert into app_workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')", [workspaceId,userId]);
  return { workspaceId,userId,role:"owner",displayName:"QA",email:"qa@example.test" };
}

async function brand(actor: AppActor, active = true): Promise<string> {
  const id = randomUUID();
  const input = sagaBrandOnboardingDraftSchema.parse({
    completionState:"completed", makeDefaultOnCompletion:false,
    brand: { slug:`b-${id}`, name:"QA varumärke", organizationName:"QA", summary:"Ett isolerat testvarumärke.", defaultLanguage:"sv",
      voice:{ positioning:"Tydlig redaktionell kommunikation.", audience:"Svenska företagsledare", toneTraits:["rak"], vocabulary:[], avoidPhrases:[], writingSamples:[] }, profileConfig:{} },
    annualPlan: { planYear:2026, primaryObjective:"demand_creation", objectiveStatement:"Skapa begripligt innehåll för rätt målgrupp.",
      objectives:[{ id:"interest",kind:"demand_creation",statement:"Skapa återkommande kvalificerat intresse.",measurement:{metric:"förfrågningar",unit:"count",provenance:"unknown"} }],
      audience:{description:"Företagsledare som uppskattar tydligt innehåll.",geography:"Sverige",sizeEvidence:"unknown"},
      marketContext:{productReadiness:"ready",demandEvidence:"hypothesis",historicalPerformance:"none",conversionMeasurement:"none",competitiveContext:"unknown",timingConfidence:"unknown"},
      channels:["organic_social"],activity:{reviewCadence:"quarterly"},
      budget:{status:"provisional",annualBudgetMinor:100000,fixedCommitmentsMinor:0,allocationIntent:"learning_first"} },
  });
  const support = calculateSagaBrandOnboardingDecisionSupport(input);
  await db.query("insert into content_engine_brand_profiles(id,workspace_id,created_by_user_id,slug,name,active) values($1,$2,$3,$4,'QA varumärke',false)", [id,actor.workspaceId,actor.userId,input.brand.slug]);
  await db.query(`insert into saga_brand_onboardings(workspace_id,brand_profile_id,created_by_user_id,updated_by_user_id,
    create_idempotency_key,completion_state,annual_plan_input,decision_support,calculation_version,completed_at)
    values($1,$2,$3,$3,$4,'completed',$5::jsonb,$6::jsonb,'saga-brand-plan-v1',now())`,
  [actor.workspaceId,id,actor.userId,randomUUID(),JSON.stringify(input.annualPlan),JSON.stringify(support)]);
  if (active) await db.query("update content_engine_brand_profiles set active=true where id=$1", [id]);
  return id;
}

function input(brandProfileId: string | null) {
  return contentAutomationRuleInputSchema.parse({ brandProfileId,name:"QA återkommande utkast",active:true,contentType:"social_post",channels:["linkedin"],
    generationPrompt:"Skriv ett konkret utkast om mänskligt arbete.",imagePrompt:"",approvalRequired:true,timezone:"UTC",scheduleMode:"weekly_count",
    weeklyCount:1,weekdays:[(new Date().getUTCDay()+1)%7],localTimes:["09:00"],cronExpression:null,startsOn:null,endsOn:null });
}

beforeAll(async () => {
  db = new PGlite({ extensions:{ pgcrypto } });
  const directory = resolve("db/migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    if (name === "202609080030_neon_studio_automation_brand_scope.sql") {
      for (const kind of ["single","multiple","former"] as const) {
        const actor = await owner();
        const first = await brand(actor);
        if (kind !== "single") await brand(actor, kind === "multiple");
        const ruleId = randomUUID(), jobId = randomUUID();
        await db.query("insert into studio_automations(id,workspace_id,created_by_user_id,name,content_type,enabled) values($1,$2,$3,'Historisk automation','social_post',true)", [ruleId,actor.workspaceId,actor.userId]);
        await db.query("insert into studio_jobs(id,workspace_id,automation_id,kind,status) values($1,$2,$3,'draft_generation','queued')", [jobId,actor.workspaceId,ruleId]);
        historical.push({ actor,ruleId,jobId,brand:kind === "single" ? first : null });
      }
    }
    await db.exec(readFileSync(resolve(directory,name),"utf8"));
  }
}, 60_000);
afterAll(async () => { await db?.close(); });

describe("real PostgreSQL Studio automation lifecycle", () => {
  it("backfills only the single total historical brand and preserves ambiguous rules paused", async () => {
    for (const fixture of historical) {
      const rule = (await db.query("select brand_profile_id,enabled from studio_automations where id=$1",[fixture.ruleId])).rows[0];
      expect(rule).toEqual({ brand_profile_id:fixture.brand,enabled:Boolean(fixture.brand) });
      const job = (await db.query("select status from studio_jobs where id=$1",[fixture.jobId])).rows[0];
      expect(job).toEqual({ status:fixture.brand ? "queued" : "cancelled" });
    }
  });

  it("creates a real rule, idempotent manual receipt, lease and one completed brand-owned private draft", async () => {
    const actor = await owner();
    const selected = await brand(actor);
    await brand(actor); // Never let cardinality/default selection hide a scope defect.
    const rule = await createStudioAutomation(actor,input(selected),sql);
    expect(rule.brandProfileId).toBe(selected);
    const idempotencyKey = randomUUID();
    const prepared = await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    if (!prepared) throw new Error("Manual receipt missing");
    expect((await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql))?.reused).toBe(true);
    const claim = await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    if (!claim) throw new Error("Manual lease missing");
    expect(claim.rule.brandProfileId).toBe(selected);
    const created = await materializeClaimedStudioAutomationDraft({jobId:claim.id,claimToken:claim.claimToken,content:{title:"Verifierat utkast",body:"Privat, sparad text från samma varumärke."}},sql);
    if (!created) throw new Error("Private draft missing");
    const persisted = (await db.query("select brand_profile_id,status,scheduled_at,body from studio_drafts where id=$1",[created.id])).rows[0];
    expect(persisted).toEqual({brand_profile_id:selected,status:"draft",scheduled_at:null,body:"Privat, sparad text från samma varumärke."});
    expect((await db.query("select status,draft_id,claim_token from studio_jobs where id=$1",[claim.id])).rows[0])
      .toEqual({status:"completed",draft_id:created.id,claim_token:null});
    expect(await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql)).toBeNull();
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where automation_job_id=$1",[claim.id])).rows[0].count).toBe(1);
  });

  it("rejects cross-tenant selection and immutable rule/job reassignment", async () => {
    const actor = await owner(), foreign = await owner();
    const selected = await brand(actor), other = await brand(actor), foreignBrand = await brand(foreign);
    await expect(createStudioAutomation(actor,input(null),sql)).rejects.toMatchObject({code:"brand_selection_required"});
    await expect(createStudioAutomation(actor,input(foreignBrand),sql)).rejects.toMatchObject({code:"brand_not_found"});
    const rule = await createStudioAutomation(actor,input(selected),sql);
    await expect(updateStudioAutomation(actor,rule.id,{brandProfileId:other},sql)).rejects.toMatchObject({code:"brand_not_found"});
    await expect(db.query("update studio_automations set brand_profile_id=$1 where id=$2",[other,rule.id])).rejects.toThrow();
    const secondRule = await createStudioAutomation(actor,input(other),sql);
    const prepared = await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey:randomUUID()},sql);
    await expect(db.query("update studio_jobs set automation_id=$1 where id=$2",[secondRule.id,prepared!.job.id])).rejects.toThrow();
  });

  it("cannot write a draft after the claimed brand is deactivated or with a different lease token", async () => {
    const actor = await owner(), selected = await brand(actor);
    const rule = await createStudioAutomation(actor,input(selected),sql);
    const idempotencyKey = randomUUID();
    await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    const claim = await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    if (!claim) throw new Error("Missing lease");
    expect(await materializeClaimedStudioAutomationDraft({jobId:claim.id,claimToken:randomUUID(),content:{body:"Must not be stored"}},sql)).toBeNull();
    await db.query("update content_engine_brand_profiles set active=false where id=$1",[selected]);
    expect(await materializeClaimedStudioAutomationDraft({jobId:claim.id,claimToken:claim.claimToken,content:{body:"Must not be stored"}},sql)).toBeNull();
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where automation_job_id=$1",[claim.id])).rows[0].count).toBe(0);
  });

  it("materializes actual scheduled receipts and cancels them when the rule is paused", async () => {
    const actor = await owner(), selected = await brand(actor);
    const rule = await createStudioAutomation(actor,input(selected),sql);
    const result = await materializeStudioAutomationJobs({horizonDays:8,ruleLimit:100,jobLimit:100},sql);
    expect(result.jobsCreated).toBeGreaterThan(0);
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_jobs where automation_id=$1",[rule.id])).rows[0].count).toBeGreaterThan(0);
    await updateStudioAutomation(actor,rule.id,{active:false},sql);
    expect((await db.query("select distinct status from studio_jobs where automation_id=$1",[rule.id])).rows).toEqual([{status:"cancelled"}]);
    expect((await claimDueStudioAutomationJobs({limit:100},sql)).some((claim) => claim.automationRuleId === rule.id)).toBe(false);
  });

  it("cannot persist, complete or fail an expired lease, even with a caller-supplied earlier clock", async () => {
    const actor = await owner(), selected = await brand(actor);
    const rule = await createStudioAutomation(actor,input(selected),sql);
    const idempotencyKey = randomUUID();
    await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    const claim = await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    if (!claim) throw new Error("Missing lease");
    await db.query("update studio_jobs set lease_expires_at=now()-interval '1 second' where id=$1",[claim.id]);
    const staleClock = new Date(Date.now()-60_000);
    expect(await materializeClaimedStudioAutomationDraft({jobId:claim.id,claimToken:claim.claimToken,now:staleClock,content:{body:"Expired worker must not write"}},sql)).toBeNull();
    expect(await completeStudioAutomationJob({jobId:claim.id,claimToken:claim.claimToken,now:staleClock,result:{late:true}},sql)).toBe(false);
    expect(await failStudioAutomationJob({jobId:claim.id,claimToken:claim.claimToken,now:staleClock,errorMessage:"Late worker",retry:true},sql)).toBe(false);
    expect(await failStudioAutomationJob({jobId:claim.id,claimToken:claim.claimToken,now:staleClock,errorMessage:"Late worker",retry:false},sql)).toBe(false);
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where automation_job_id=$1",[claim.id])).rows[0].count).toBe(0);
    expect((await db.query("select status,claim_token,draft_id,failure_code,result from studio_jobs where id=$1",[claim.id])).rows[0])
      .toEqual({status:"running",claim_token:claim.claimToken,draft_id:null,failure_code:null,result:{}});
    expect((await db.query("select last_run_at from studio_automations where id=$1",[rule.id])).rows[0]).toEqual({last_run_at:null});
  });

  it("checks expiry again at the locked final INSERT when a lease expires after its initial read", async () => {
    const actor = await owner(), selected = await brand(actor);
    const rule = await createStudioAutomation(actor,input(selected),sql);
    const idempotencyKey = randomUUID();
    await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    const claim = await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
    if (!claim) throw new Error("Missing lease");
    let expiredAtInsert = false;
    const racingSql = {query:async (text:string, values:unknown[] = []) => {
      if (text.includes("insert into studio_drafts")) {
        expiredAtInsert = true;
        await db.query("update studio_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[claim.id]);
      }
      return (await db.query(text,values)).rows;
    }} as unknown as NeonSql;
    expect(await materializeClaimedStudioAutomationDraft({jobId:claim.id,claimToken:claim.claimToken,content:{body:"Expired between read and write"}},racingSql)).toBeNull();
    expect(expiredAtInsert).toBe(true);
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where automation_job_id=$1",[claim.id])).rows[0].count).toBe(0);
    expect((await db.query("select status,claim_token from studio_jobs where id=$1",[claim.id])).rows[0]).toEqual({status:"running",claim_token:claim.claimToken});
  });

  it("still records a live worker failure and releases a live retry receipt", async () => {
    const actor = await owner(), selected = await brand(actor);
    const rule = await createStudioAutomation(actor,input(selected),sql);
    for (const retry of [false,true]) {
      const idempotencyKey = randomUUID();
      await createStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
      const claim = await claimStudioManualAutomationJob(actor,{automationId:rule.id,idempotencyKey},sql);
      if (!claim) throw new Error("Missing lease");
      expect(await failStudioAutomationJob({jobId:claim.id,claimToken:claim.claimToken,errorMessage:"Safe test failure",errorCode:"qa_failure",retry},sql)).toBe(true);
      expect((await db.query("select status,claim_token,failure_code,lease_expires_at from studio_jobs where id=$1",[claim.id])).rows[0])
        .toEqual({status:retry ? "queued" : "failed",claim_token:null,failure_code:"qa_failure",lease_expires_at:null});
    }
  });
});
