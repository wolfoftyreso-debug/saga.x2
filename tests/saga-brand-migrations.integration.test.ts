import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { upsertSagaEditorialLens, getSagaEditorialLens } from "@/lib/neon/saga-editorial-lens-repository";
import { sagaEditorialLensInputSchema } from "@/lib/domain/saga-editorial-lens";
import type { NeonSql } from "@/lib/neon/database";
import { contentDraftInputSchema } from "@/lib/domain/content-studio";
import { createStudioDraft, getStudioDraft, updateStudioDraft, StudioContentConflictError } from "@/lib/neon/studio-content-repository";

// Executes unmodified migrations on real embedded PostgreSQL, not SQL-string
// mocks. Neon network behavior/production concurrency remain a separate gate.
let db: PGlite;
const actor = randomUUID();
const single = randomUUID();
const multiple = randomUUID();
const former = randomUUID();
const singleBrand = randomUUID();
const brandA = randomUUID();
const brandB = randomUUID();
const inactiveBrand = randomUUID();
const currentBrand = randomUUID();
const draftIds = new Map<string, string>();
const policyIds = new Map<string, string>();
const applied: string[] = [];

async function addBrand(workspace: string, id: string, active = true) {
  await db.query(`insert into content_engine_brand_profiles(id,workspace_id,created_by_user_id,slug,name,active)
    values ($1,$2,$3,$4,'Testvarumärke',false)`, [id, workspace, actor, `brand-${id}`]);
  await db.query(`insert into saga_brand_onboardings(workspace_id,brand_profile_id,created_by_user_id,updated_by_user_id,
    create_idempotency_key,completion_state,annual_plan_input,decision_support,calculation_version,completed_at)
    values ($1,$2,$3,$3,$4,'completed','{}','{}','saga-brand-plan-v1',now())`, [workspace, id, actor, randomUUID()]);
  if (active) await db.query("update content_engine_brand_profiles set active=true where id=$1", [id]);
}

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const directory = resolve(process.cwd(), "db/migrations");
  const migrations = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  for (const name of migrations.filter((file) => file < "202609")) {
    await db.exec(readFileSync(resolve(directory, name), "utf8"));
    applied.push(name);
  }
  await db.query("insert into app_users(id,vercel_subject) values ($1,'qa-postgres')", [actor]);
  for (const workspace of [single, multiple, former]) {
    await db.query("insert into app_workspaces(id,slug,name) values ($1,$2,'QA arbetsyta')", [workspace, `qa-${workspace}`]);
    await db.query("insert into app_workspace_memberships(workspace_id,user_id,role) values ($1,$2,'owner')", [workspace, actor]);
  }
  await addBrand(single, singleBrand);
  await addBrand(multiple, brandA);
  await addBrand(multiple, brandB);
  await addBrand(former, inactiveBrand, false);
  await addBrand(former, currentBrand);
  for (const workspace of [single, multiple, former]) {
    const draftId = randomUUID();
    draftIds.set(workspace, draftId);
    await db.query(`insert into studio_drafts(id,workspace_id,author_user_id,content_type,title,body)
      values ($1,$2,$3,'social_post','Historiskt utkast','Texten ska finnas kvar')`, [draftId, workspace, actor]);
    await db.query(`insert into saga_editorial_lenses(workspace_id,created_by_user_id,updated_by_user_id,mission)
      values ($1,$2,$2,'Historisk inriktning')`, [workspace, actor]);
    const policy = randomUUID();
    policyIds.set(workspace, policy);
    await db.query(`insert into saga_daily_knowledge_policies(id,workspace_id,created_by_user_id,updated_by_user_id,
      enabled,topics,source_ids) values ($1,$2,$3,$3,true,ARRAY['Teknik'],$4::uuid[])`, [policy, workspace, actor, [randomUUID()]]);
    await db.query(`insert into saga_daily_knowledge_jobs(workspace_id,policy_id,policy_revision,knowledge_date,
      idempotency_key,retention_expires_at) values ($1,$2,1,current_date,$3,now()+interval '90 days')`, [workspace, policy, `qa-knowledge-${policy}`]);
  }
  for (const name of migrations.filter((file) => file >= "202609")) {
    await db.exec(readFileSync(resolve(directory, name), "utf8"));
    applied.push(name);
  }
}, 60_000);
afterAll(async () => { await db?.close(); });

describe("brand migration execution and database invariants", () => {
  it("executes the complete migration chain without stripping SQL or stubbing functions", () => {
    expect(applied.length).toBeGreaterThanOrEqual(29);
    expect(applied).toContain("202608260025_neon_saga_adobe_authoring_runs.sql");
    expect(applied).toContain("202609080028_neon_saga_authoring_brand_scope.sql");
    expect(applied).toContain("202609080029_neon_saga_knowledge_brand_scope.sql");
  });

  it("backfills the unambiguous single historical brand only", async () => {
    const rows = await db.query<{ workspace_id: string; brand_profile_id: string | null }>("select workspace_id,brand_profile_id from studio_drafts");
    expect(rows.rows.find((row) => row.workspace_id === single)?.brand_profile_id).toBe(singleBrand);
    expect(rows.rows.find((row) => row.workspace_id === multiple)?.brand_profile_id).toBeNull();
    // One active brand is not proof when another historical profile exists.
    expect(rows.rows.find((row) => row.workspace_id === former)?.brand_profile_id).toBeNull();
    expect(rows.rows).toHaveLength(3);
  });

  it("retains ambiguous knowledge, pauses policies and cancels their outstanding jobs", async () => {
    const policies = await db.query<{ workspace_id: string; brand_profile_id: string | null; enabled: boolean }>("select workspace_id,brand_profile_id,enabled from saga_daily_knowledge_policies");
    expect(policies.rows.find((row) => row.workspace_id === single)).toMatchObject({ enabled: true, brand_profile_id: singleBrand });
    for (const workspace of [multiple, former]) {
      expect(policies.rows.find((row) => row.workspace_id === workspace)).toMatchObject({ enabled: false, brand_profile_id: null });
      const jobs = await db.query<{ state: string; completed_at: unknown }>("select state,completed_at from saga_daily_knowledge_jobs where workspace_id=$1", [workspace]);
      expect(jobs.rows[0]?.state).toBe("cancelled");
      expect(jobs.rows[0]?.completed_at).not.toBeNull();
    }
  });

  it("allows two distinct per-brand lenses without changing or deleting the old unassigned lens", async () => {
    for (const brand of [brandA, brandB]) {
      await db.query(`insert into saga_editorial_lenses(workspace_id,created_by_user_id,updated_by_user_id,brand_profile_id)
        values ($1,$2,$2,$3)`, [multiple, actor, brand]);
    }
    const lenses = await db.query("select brand_profile_id from saga_editorial_lenses where workspace_id=$1", [multiple]);
    expect(lenses.rows).toHaveLength(3);
    await expect(db.query(`insert into saga_editorial_lenses(workspace_id,created_by_user_id,updated_by_user_id,brand_profile_id)
      values ($1,$2,$2,$3)`, [multiple, actor, brandA])).rejects.toThrow();
  });

  it("rejects cross-workspace brand assignment and subsequent ownership changes", async () => {
    await expect(db.query(`insert into studio_drafts(workspace_id,author_user_id,content_type,brand_profile_id)
      values ($1,$2,'social_post',$3)`, [single, actor, brandA])).rejects.toThrow();
    await expect(db.query("update studio_drafts set brand_profile_id=$1 where id=$2", [brandA, draftIds.get(single)])).rejects.toThrow();
    await expect(db.query("update saga_editorial_lenses set brand_profile_id=$1 where workspace_id=$2 and brand_profile_id=$3", [brandB, multiple, brandA])).rejects.toThrow();
    await expect(db.query("update saga_daily_knowledge_policies set brand_profile_id=$1 where id=$2", [brandA, policyIds.get(single)])).rejects.toThrow();
  });

  it("uses an explicitly selected brand for a new reference and inherits it on the authoring run", async () => {
    const draftId = randomUUID();
    await db.query(`insert into studio_drafts(id,workspace_id,author_user_id,content_type,title,body,brand_profile_id)
      values ($1,$2,$3,'social_post','Ny referens','Valt varumärke',$4)`, [draftId, multiple, actor, brandB]);
    const run = await db.query<{ brand_profile_id: string }>(`insert into saga_adobe_authoring_runs(workspace_id,created_by_user_id,
      create_idempotency_key,reference_draft_id,reference_draft_revision,objective,author_prompt,candidate_count)
      values ($1,$2,$3,$4,1,'Informera rätt målgrupp','Skapa tio variationer',10) returning brand_profile_id`, [multiple, actor, randomUUID(), draftId]);
    expect(run.rows[0]?.brand_profile_id).toBe(brandB);
    await expect(db.query(`insert into saga_adobe_authoring_runs(workspace_id,created_by_user_id,create_idempotency_key,
      reference_draft_id,reference_draft_revision,objective,author_prompt,candidate_count,brand_profile_id)
      values ($1,$2,$3,$4,1,'Informera rätt målgrupp','Skapa variationer',3,$5)`, [multiple, actor, randomUUID(), draftId, brandA])).rejects.toThrow();
  });

  it("creates and updates a brand Lens through the real repository without returning a stale snapshot", async () => {
    const brand = randomUUID();
    await addBrand(multiple, brand);
    const sourceId = randomUUID();
    await db.query(`insert into content_engine_sources(id,workspace_id,created_by_user_id,slug,name,source_kind,reference_text)
      values ($1,$2,$3,$4,'Vald källa','manual','Manuellt godkänt underlag för QA')`, [sourceId, multiple, actor, `source-${sourceId}`]);
    const sql = { query: async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows } as unknown as NeonSql;
    const owner = { userId: actor, workspaceId: multiple, brandProfileId: brand, role: "owner" as const, displayName: "QA", email: "qa@example.test" };
    const input = sagaEditorialLensInputSchema.parse({ brandProfileId: brand, mission: "Första inriktningen", tone: {}, construction: {}, sourceRules: {}, sourceSelections: [{ sourceId, role: "preferred", priority: 1 }] });
    const created = await upsertSagaEditorialLens(owner, input, sql);
    expect(created.mission).toBe("Första inriktningen");
    const updated = await upsertSagaEditorialLens(owner, { ...input, mission: "Andra inriktningen" }, sql);
    expect(updated.id).toBe(created.id);
    expect(updated.mission).toBe("Andra inriktningen");
    expect((await getSagaEditorialLens(owner, sql))?.mission).toBe("Andra inriktningen");
    await expect(upsertSagaEditorialLens(owner, { ...input, mission: "Får inte sparas", sourceSelections: [{ sourceId: randomUUID(), role: "required", priority: 1 }] }, sql)).rejects.toThrow();
    const retained = await getSagaEditorialLens(owner, sql);
    expect(retained?.mission).toBe("Andra inriktningen");
    expect(retained?.sourceSelections).toEqual([{ sourceId, role: "preferred", priority: 1 }]);
  });

  it("saves and reloads a real draft, rejects a stale edit and preserves the successful write", async () => {
    const sql = { query: async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows } as unknown as NeonSql;
    const owner = { userId: actor, workspaceId: multiple, brandProfileId: brandB, role: "owner" as const, displayName: "QA", email: "qa@example.test" };
    const draft = await createStudioDraft(owner, contentDraftInputSchema.parse({
      contentType: "social_post", channels: ["linkedin"], title: "En faktisk referens", body: "Ursprunglig sparad text",
      hashtags: [], status: "draft", timezone: "Europe/Stockholm", scheduledAt: null,
      scheduledLocalDate: null, scheduledLocalTime: null, approvalRequired: true,
    }), sql);
    const saved = await updateStudioDraft(owner, draft.id, { body: "Ny sparad formulering", expectedRevision: draft.revision }, sql);
    if (!saved) throw new Error("Det nyss skapade utkastet kunde inte sparas.");
    expect(saved.body).toBe("Ny sparad formulering");
    expect(draft.brandProfileId).toBe(brandB);
    expect(saved.brandProfileId).toBe(brandB);
    expect(saved.revision).toBe(draft.revision + 1);
    await expect(updateStudioDraft(owner, draft.id, { body: "Gammal flik försöker skriva", expectedRevision: draft.revision }, sql)).rejects.toBeInstanceOf(StudioContentConflictError);
    const reloaded = await getStudioDraft(owner, draft.id, sql);
    expect(reloaded?.body).toBe("Ny sparad formulering");
    expect(reloaded?.brandProfileId).toBe(brandB);
    expect(reloaded?.revision).toBe(saved.revision);
    expect(await getStudioDraft({ ...owner, brandProfileId: brandA }, draft.id, sql)).toBeNull();
  });
});
