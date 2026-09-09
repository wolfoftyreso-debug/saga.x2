import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const directory = path.resolve("db/migrations");
  for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(directory, name), "utf8"));
  }
}, 30_000);
afterAll(async () => { await db?.close(); });

type Seed = { workspace: string; user: string; brand: string; draft: string };
type Run = { run_id: string; reused: boolean };
type Command = { run_id: string; receipt_id: string; command_id: string; command_claim_token: string; reused: boolean; should_process: boolean };
type Claim = { job_id: string; claim_token: string; candidate_id: string };

async function seed(): Promise<Seed> {
  const workspace = randomUUID(), user = randomUUID(), brand = randomUUID(), draft = randomUUID();
  await db.query("insert into app_workspaces (id,slug,name) values ($1,$2,'Integration fixture')", [workspace, `qa-${workspace}`]);
  await db.query("insert into app_users (id,vercel_subject,display_name) values ($1,$2,'Fixture author')", [user, `qa-${user}`]);
  await db.query("insert into app_workspace_memberships (workspace_id,user_id,role) values ($1,$2,'owner')", [workspace,user]);
  await db.query("insert into content_engine_brand_profiles (id,workspace_id,created_by_user_id,slug,name,active) values ($1,$2,$3,'fixture','Fixture brand',false)", [brand,workspace,user]);
  await db.query(`insert into saga_brand_onboardings (workspace_id,brand_profile_id,created_by_user_id,updated_by_user_id,
    create_idempotency_key,completion_state,annual_plan_input,decision_support,calculation_version,completed_at)
    values ($1,$2,$3,$3,$4,'completed','{}','{}','saga-brand-plan-v1',now())`, [workspace,brand,user,randomUUID()]);
  await db.query("update content_engine_brand_profiles set active=true where id=$1", [brand]);
  await db.query(`insert into studio_drafts (id,workspace_id,author_user_id,brand_profile_id,content_type,title,body,publication_channels)
    values ($1,$2,$3,$4,'social_post','Reference','Reference body','["linkedin"]')`, [draft,workspace,user,brand]);
  return { workspace,user,brand,draft };
}

async function create(seed: Seed, key = randomUUID()): Promise<Run> {
  return (await db.query<Run>(`select * from saga_create_adobe_authoring_run($1,$2,$3,$4,1,
    'Teach useful automation','Write a private variation',true,'{}'::uuid[],1)`, [seed.workspace,seed.user,key,seed.draft])).rows[0];
}
async function prepare(seed: Seed, run: Run, key = randomUUID()): Promise<Command> {
  return (await db.query<Command>("select * from saga_prepare_adobe_authoring_run_generation($1,$2,$3,$4,1,false)", [seed.workspace,seed.user,run.run_id,key])).rows[0];
}
async function claim(seed: Seed, command: Command): Promise<Claim> {
  return (await db.query<Claim>("select * from saga_claim_adobe_authoring_generation_job($1,$2,$3,$4,$5,'integration-fixture',60)",
    [seed.workspace,command.run_id,command.receipt_id,command.command_id,command.command_claim_token])).rows[0];
}
async function complete(seed: Seed, command: Command, job: Claim, token = command.command_claim_token) {
  return (await db.query<{ candidate_id: string | null; stale: boolean }>("select * from saga_complete_adobe_authoring_generation_job($1,$2,$3,$4,$5,$6::jsonb)",
    [seed.workspace,command.command_id,token,job.job_id,job.claim_token,JSON.stringify({
      content: { title:"Private candidate", body:"Private candidate body" },
      quality: { canCreatePrivateDraft:true, canDeliver:false, decision:"review_required" },
      model:"integration-fixture", responseId:"integration-fixture",
    })])).rows[0];
}

describe("real PostgreSQL authoring lifecycle", () => {
  it("creates, prepares, claims, completes and explicitly selects one brand-owned private draft with idempotent replay", async () => {
    const fixture = await seed();
    const createKey = randomUUID(), commandKey = randomUUID(), selectionKey = randomUUID();
    const run = await create(fixture, createKey);
    expect(await create(fixture, createKey)).toEqual({ ...run, reused: true });
    const command = await prepare(fixture, run, commandKey);
    expect(command.should_process).toBe(true);
    expect(await prepare(fixture, run, commandKey)).toMatchObject({ command_id:command.command_id, reused:true, should_process:false });
    const job = await claim(fixture, command);
    expect(await complete(fixture, command, job)).toEqual({ candidate_id:job.candidate_id, stale:false });
    const persistedRun = (await db.query<{ revision:number; state:string; brand_profile_id:string }>("select revision,state,brand_profile_id from saga_adobe_authoring_runs where id=$1", [run.run_id])).rows[0];
    expect(persistedRun).toMatchObject({ state:"ready_to_select", brand_profile_id:fixture.brand });
    const candidate = (await db.query<{ revision:number }>("select revision from saga_adobe_authoring_candidates where id=$1", [job.candidate_id])).rows[0];
    const parameters = [fixture.workspace,fixture.user,run.run_id,job.candidate_id,selectionKey,persistedRun.revision,candidate.revision];
    const selected = (await db.query<{ studio_draft_id:string; reused:boolean }>("select * from saga_select_adobe_authoring_candidate($1,$2,$3,$4,$5,$6,$7)", parameters)).rows[0];
    const replay = (await db.query<{ studio_draft_id:string; reused:boolean }>("select * from saga_select_adobe_authoring_candidate($1,$2,$3,$4,$5,$6,$7)", parameters)).rows[0];
    expect(replay).toMatchObject({ studio_draft_id:selected.studio_draft_id, reused:true });
    const draft = (await db.query("select status,scheduled_at,brand_profile_id,body from studio_drafts where id=$1", [selected.studio_draft_id])).rows[0];
    expect(draft).toEqual({ status:"in_review", scheduled_at:null, brand_profile_id:fixture.brand, body:"Private candidate body" });
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where workspace_id=$1", [fixture.workspace])).rows[0].count).toBe(2);
  });

  it("refuses a stale command token without changing the candidate or creating a draft", async () => {
    const fixture = await seed();
    const run = await create(fixture);
    const command = await prepare(fixture, run);
    const job = await claim(fixture, command);
    expect(await complete(fixture, command, job, randomUUID())).toEqual({ candidate_id:null, stale:true });
    expect((await db.query("select state,generated_content from saga_adobe_authoring_candidates where id=$1", [job.candidate_id])).rows[0])
      .toEqual({ state:"generating", generated_content:null });
    expect((await db.query<{ count:number }>("select count(*)::int as count from studio_drafts where workspace_id=$1", [fixture.workspace])).rows[0].count).toBe(1);
  });

  it("rejects an empty reference channel list through the executable PL/pgSQL validation branch", async () => {
    const fixture = await seed();
    await db.query("update studio_drafts set publication_channels='[]'::jsonb where id=$1", [fixture.draft]);
    await expect(create(fixture)).rejects.toThrow("saga_adobe_authoring_reference_unsuitable");
    expect((await db.query<{ count:number }>("select count(*)::int as count from saga_adobe_authoring_runs where workspace_id=$1", [fixture.workspace])).rows[0].count).toBe(0);
  });

  it("refuses completion, blocking and failure writes after the job lease expires", async () => {
    const fixture = await seed();
    const run = await create(fixture);
    const command = await prepare(fixture, run);
    const job = await claim(fixture, command);
    await db.query("update saga_adobe_authoring_generation_jobs set lease_expires_at=now()-interval '1 second' where id=$1", [job.job_id]);
    expect(await complete(fixture, command, job)).toEqual({ candidate_id:null, stale:true });
    const fail = await db.query<{ value:boolean }>("select saga_fail_adobe_authoring_generation_job($1,$2,$3,$4,$5,'fixture','fixture') as value",
      [fixture.workspace,command.command_id,command.command_claim_token,job.job_id,job.claim_token]);
    expect(fail.rows[0].value).toBe(false);
    const block = await db.query<{ value:boolean }>("select saga_block_adobe_authoring_generation_job($1,$2,$3,$4,$5,'{}'::jsonb,'fixture') as value",
      [fixture.workspace,command.command_id,command.command_claim_token,job.job_id,job.claim_token]);
    expect(block.rows[0].value).toBe(false);
    expect((await db.query("select state,generated_content from saga_adobe_authoring_candidates where id=$1", [job.candidate_id])).rows[0])
      .toEqual({ state:"generating", generated_content:null });
  });

  it("upgrades previously installed authoring functions using migration 031 alone", async () => {
    const selectSignature = "saga_select_adobe_authoring_candidate(uuid,uuid,uuid,uuid,uuid,integer,integer)";
    const completeSignature = "saga_complete_adobe_authoring_generation_job(uuid,uuid,uuid,uuid,uuid,jsonb)";
    const definition = async (signature: string) => (await db.query<{ body:string }>("select pg_get_functiondef($1::regprocedure) as body", [signature])).rows[0].body;
    // Install the earlier, syntactically valid bodies. Their runtime errors
    // cannot be discovered by table/schema-shape tests alone.
    await db.exec((await definition(selectSignature)).replaceAll("candidate.run_id = target_run_id", "run_id = target_run_id"));
    await db.exec((await definition(completeSignature)).replace("and job.lease_expires_at > now()", ""));
    expect(await definition(completeSignature)).not.toContain("and job.lease_expires_at > now()");
    await db.exec(readFileSync(path.resolve("db/migrations/202609080031_neon_saga_authoring_runtime_repairs.sql"), "utf8"));
    expect(await definition(selectSignature)).toContain("candidate.run_id = target_run_id");
    expect(await definition(completeSignature)).toContain("and job.lease_expires_at > now()");
    expect(await definition(completeSignature)).toContain("if not found then candidate_id := null; stale := true; return next; return; end if;");
    const fixture = await seed();
    const key = randomUUID();
    const run = await create(fixture, key);
    expect((await create(fixture, key)).reused).toBe(true);
    const command = await prepare(fixture, run);
    const job = await claim(fixture, command);
    expect((await complete(fixture, command, job)).stale).toBe(false);
    const currentRun = (await db.query<{ revision:number }>("select revision from saga_adobe_authoring_runs where id=$1", [run.run_id])).rows[0];
    const candidate = (await db.query<{ revision:number }>("select revision from saga_adobe_authoring_candidates where id=$1", [job.candidate_id])).rows[0];
    const selected = await db.query<{ studio_draft_id:string }>("select * from saga_select_adobe_authoring_candidate($1,$2,$3,$4,$5,$6,$7)",
      [fixture.workspace,fixture.user,run.run_id,job.candidate_id,randomUUID(),currentRun.revision,candidate.revision]);
    expect(selected.rows[0].studio_draft_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
