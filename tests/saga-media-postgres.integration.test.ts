import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NeonSql } from "@/lib/neon/database";
import {
  attachGeneratedSagaAutomationMedia, claimDueSagaAutomationMediaJobs,
  completeSagaAutomationMediaJob, failSagaAutomationMediaJob,
  materializeSagaAutomationMediaGenerationJobs,
} from "@/lib/neon/saga-media-generation-worker";
import type { SagaGeneratedPrivateMedia } from "@/lib/services/saga-media-generation";
import { createStudioBlobPath } from "@/lib/vercel/blob-media";
import { sagaBrandOnboardingDraftSchema, calculateSagaBrandOnboardingDecisionSupport } from "@/lib/domain/saga-brand-onboarding";

let db: PGlite;
const sql = { query: async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows } as unknown as NeonSql;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const directory = resolve("db/migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(resolve(directory, name), "utf8"));
  }
}, 60_000);
afterAll(async () => { await db?.close(); });

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), brandId = randomUUID();
  const ruleId = randomUUID(), sourceId = randomUUID(), draftId = randomUUID();
  await db.query("insert into app_workspaces(id,slug,name) values($1,$2,'QA media')", [workspaceId, workspaceId]);
  await db.query("insert into app_users(id,vercel_subject) values($1,$2)", [userId, userId]);
  await db.query("insert into app_workspace_memberships(workspace_id,user_id,role) values($1,$2,'owner')", [workspaceId,userId]);
  const onboarding = sagaBrandOnboardingDraftSchema.parse({
    completionState: "completed", makeDefaultOnCompletion: false,
    brand: { slug: `b-${brandId}`, name: "QA", organizationName: "QA", summary: "Ett isolerat testvarumärke.", defaultLanguage: "sv",
      voice: { positioning: "Tydlig redaktionell kommunikation.", audience: "Svenska företagsledare", toneTraits: ["rak"], vocabulary: [], avoidPhrases: [], writingSamples: [] }, profileConfig: {} },
    annualPlan: { planYear: 2026, primaryObjective: "demand_creation", objectiveStatement: "Skapa begripligt innehåll för rätt målgrupp.",
      objectives: [{ id: "interest", kind: "demand_creation", statement: "Skapa kvalificerat intresse.", measurement: { metric: "förfrågningar", unit: "count", provenance: "unknown" } }],
      audience: { description: "Företagsledare som uppskattar tydligt innehåll.", geography: "Sverige", sizeEvidence: "unknown" },
      marketContext: { productReadiness: "ready", demandEvidence: "hypothesis", historicalPerformance: "none", conversionMeasurement: "none", competitiveContext: "unknown", timingConfidence: "unknown" },
      channels: ["organic_social"], activity: { reviewCadence: "quarterly" },
      budget: { status: "provisional", annualBudgetMinor: 100000, fixedCommitmentsMinor: 0, allocationIntent: "learning_first" } },
  });
  await db.query("insert into content_engine_brand_profiles(id,workspace_id,created_by_user_id,slug,name,active) values($1,$2,$3,$4,'QA',false)", [brandId, workspaceId, userId, onboarding.brand.slug]);
  await db.query(`insert into saga_brand_onboardings(workspace_id,brand_profile_id,created_by_user_id,updated_by_user_id,create_idempotency_key,completion_state,annual_plan_input,decision_support,calculation_version,completed_at)
    values($1,$2,$3,$3,$4,'completed',$5::jsonb,$6::jsonb,'saga-brand-plan-v1',now())`,
  [workspaceId, brandId, userId, randomUUID(), JSON.stringify(onboarding.annualPlan), JSON.stringify(calculateSagaBrandOnboardingDecisionSupport(onboarding))]);
  await db.query("update content_engine_brand_profiles set active=true where id=$1", [brandId]);
  await db.query("insert into studio_automations(id,workspace_id,created_by_user_id,brand_profile_id,name,content_type,enabled) values($1,$2,$3,$4,'QA media','social_post',true)", [ruleId,workspaceId,userId,brandId]);
  await db.query("insert into studio_jobs(id,workspace_id,automation_id,kind,status,completed_at) values($1,$2,$3,'draft_generation','completed',now())", [sourceId,workspaceId,ruleId]);
  await db.query(`insert into studio_drafts(id,workspace_id,author_user_id,brand_profile_id,automation_job_id,content_type,status,title,body,publication_channels,metadata)
    values($1,$2,$3,$4,$5,'social_post','in_review','Mänskligt arbete','En kontrollerad process ger tid åt människan.','["linkedin"]',$6::jsonb)`,
  [draftId,workspaceId,userId,brandId,sourceId,JSON.stringify({imagePrompt:"Lugn redaktionell miljö utan text.",sagaProductionQuality:{version:"saga-production-quality/v1",canCreatePrivateDraft:true}})]);
  await db.query("update studio_jobs set draft_id=$1 where id=$2", [draftId,sourceId]);
  await materializeSagaAutomationMediaGenerationJobs({}, sql);
  const [claim] = await claimDueSagaAutomationMediaJobs({}, sql);
  if (!claim || claim.draftId !== draftId) throw new Error("Expected this fixture's real media lease");
  const pathname = createStudioBlobPath({workspaceId,draftId},"qa.png","image/png",claim.id);
  const generated: SagaGeneratedPrivateMedia = {
    runId:claim.id,source:"ai_gateway",privateOnly:true,status:"ready",
    storage:{pathname,contentType:"image/png",byteSize:1024},altText:"Privat testbild.",
    generation:{model:"test-only",aspectRatio:"landscape",safetyPolicyVersion:"saga-creative-safety/v1",artDirectionPolicyVersion:"saga-visual-art-direction/v1",editorialFinishVersion:"saga-editorial-image-finish/v1"},
  };
  const uploaded = {pathname,contentType:"image/png" as const,size:1024,url:`https://qa.private.blob.vercel-storage.com/${pathname}`};
  return {claim,generated,uploaded,brandId};
}

describe("real PostgreSQL private media leases", () => {
  it("materializes, claims, attaches once and completes only the matching real media row", async () => {
    const f = await fixture();
    expect(await completeSagaAutomationMediaJob({claim:f.claim,mediaId:randomUUID()},sql)).toBe(false);
    const attached = await attachGeneratedSagaAutomationMedia(f,sql);
    expect(attached.status).toBe("attached");
    expect(await attachGeneratedSagaAutomationMedia(f,sql)).toEqual({status:"already_attached",mediaId:attached.mediaId});
    expect(await completeSagaAutomationMediaJob({claim:f.claim,mediaId:attached.mediaId!},sql)).toBe(true);
    expect((await db.query("select status,claim_token from studio_jobs where id=$1",[f.claim.id])).rows[0]).toEqual({status:"completed",claim_token:null});
    expect((await db.query("select count(*)::int as count from studio_media where job_id=$1",[f.claim.id])).rows[0]).toEqual({count:1});
    expect((await db.query("select status,scheduled_at from studio_drafts where id=$1",[f.claim.draftId])).rows[0]).toEqual({status:"in_review",scheduled_at:null});
  });

  it("fences attach, cancellation, completion and both failure paths after actual DB expiry despite stale caller time", async () => {
    const f = await fixture();
    await db.query("update studio_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",[f.claim.id]);
    const now = new Date(Date.now()-60_000);
    expect(await attachGeneratedSagaAutomationMedia({...f,now},sql)).toEqual({status:"lease_lost"});
    await db.query("update studio_drafts set title='A new revision',revision=revision+1 where id=$1",[f.claim.draftId]);
    expect(await attachGeneratedSagaAutomationMedia({...f,now},sql)).toEqual({status:"lease_lost"});
    expect(await completeSagaAutomationMediaJob({claim:f.claim,mediaId:randomUUID(),now},sql)).toBe(false);
    for (const retry of [true,false]) expect(await failSagaAutomationMediaJob({claim:f.claim,code:"late",detail:"late",retry,now},sql)).toBe("lease_lost");
    expect((await db.query("select status,claim_token,failure_code from studio_jobs where id=$1",[f.claim.id])).rows[0]).toEqual({status:"running",claim_token:f.claim.claimToken,failure_code:null});
    expect((await db.query("select count(*)::int as count from studio_media where job_id=$1",[f.claim.id])).rows[0]).toEqual({count:0});
    await db.query("update studio_jobs set status='cancelled',completed_at=now() where id=$1",[f.claim.id]);
  });

  it("rejects a replaced token, revoked brand and a revised draft before attachment", async () => {
    const f = await fixture();
    const stale = {...f.claim,claimToken:randomUUID()};
    expect(await attachGeneratedSagaAutomationMedia({...f,claim:stale},sql)).toEqual({status:"lease_lost"});
    expect(await failSagaAutomationMediaJob({claim:stale,code:"late",detail:"late",retry:false},sql)).toBe("lease_lost");
    await db.query("update content_engine_brand_profiles set active=false where id=$1",[f.brandId]);
    expect(await attachGeneratedSagaAutomationMedia(f,sql)).toEqual({status:"lease_lost"});
    await db.query("update studio_drafts set title='Revised by editor',revision=revision+1 where id=$1",[f.claim.draftId]);
    expect(await attachGeneratedSagaAutomationMedia(f,sql)).toEqual({status:"draft_revised"});
    expect((await db.query("select count(*)::int as count from studio_media where job_id=$1",[f.claim.id])).rows[0]).toEqual({count:0});
  });

  it("records retries only under a still-live receipt and permits safe reclaim with a new token", async () => {
    const f = await fixture();
    expect(await failSagaAutomationMediaJob({claim:f.claim,code:"qa",detail:"safe failure",retry:true},sql)).toBe("retry_scheduled");
    await db.query("update studio_jobs set run_after=clock_timestamp()-interval '1 second' where id=$1",[f.claim.id]);
    const [reclaimed] = await claimDueSagaAutomationMediaJobs({},sql);
    expect(reclaimed.id).toBe(f.claim.id);
    expect(reclaimed.claimToken).not.toBe(f.claim.claimToken);
    expect(await attachGeneratedSagaAutomationMedia(f,sql)).toEqual({status:"lease_lost"});
    expect(await failSagaAutomationMediaJob({claim:reclaimed,code:"qa",detail:"final safe failure",retry:true},sql)).toBe("failed");
  });
});
