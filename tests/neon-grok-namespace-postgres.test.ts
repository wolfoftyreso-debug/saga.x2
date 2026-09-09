import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { expect, it } from "vitest";
import { loadMigrations, runMigrations, SAGA_PROJECT_ID } from "../scripts/neon-migrate.mjs";

it("upgrades the actual 31-file ledger with only migration32, retains legacy Grok and prevents cross-provider SQL writes", async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const client = {
    async query(sql: string, values?: unknown[]) {
      return values?.length ? db.query(sql, values) : (await db.exec(sql)).at(-1)!;
    },
  };
  const target = { host: "ep-test.eu-central-1.aws.neon.tech", project: SAGA_PROJECT_ID, database: "postgres" };
  try {
    const migrations = loadMigrations(process.cwd());
    expect(migrations.at(-1)?.name).toBe("202609090032_neon_grok_gateway_namespace.sql");
    const prior = migrations.slice(0, -1);
    expect(await runMigrations(client, prior, target, true)).toMatchObject({ applied: 31, pending: 0 });
    const workspace = randomUUID(), user = randomUUID();
    await db.query("insert into app_workspaces(id,slug,name) values ($1,$2,'Grok QA')", [workspace, `qa-${workspace}`]);
    await db.query("insert into app_users(id,vercel_subject) values ($1,$2)", [user, `qa-${user}`]);
    await db.query("insert into app_workspace_memberships(workspace_id,user_id,role) values ($1,$2,'owner')", [workspace, user]);
    async function insert(provider: string, modelId: string) {
      return db.query<{ provider: string; model_id: string }>(`insert into content_engine_model_presets(workspace_id,created_by_user_id,slug,name,provider,model_id,task_kinds)
        values($1,$2,$3,'Gateway QA',$4,$5,array['writing']) returning provider,model_id`, [workspace, user, `profile-${randomUUID()}`, provider, modelId]);
    }
    const legacyId = "xai/grok-4.1-fast-non-reasoning";
    const canonicalId = "spacexai/grok-4.1-fast-non-reasoning";
    // The original PostgreSQL regex has an illegal >255 repetition count;
    // executing real INSERTs catches what schema creation alone cannot.
    await expect(insert("xai", legacyId)).rejects.toThrow("invalid repetition count");
    // Seed a historical/imported profile in this isolated fixture, then put
    // the exact broken original check back. The upgrade must preserve it.
    await db.exec("alter table content_engine_model_presets drop constraint content_engine_model_presets_model_id_check");
    await insert("xai", legacyId);
    await db.exec("alter table content_engine_model_presets add constraint content_engine_model_presets_model_id_check check (model_id ~ '^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._:-]{0,260}$') not valid");
    await expect(insert("xai", canonicalId)).rejects.toThrow();
    expect(await runMigrations(client, migrations, target)).toMatchObject({ applied: 31, pending: 1 });
    const applied: string[] = [];
    expect(await runMigrations(client, migrations, target, true, (entry) => applied.push(entry.filename))).toMatchObject({ previouslyApplied: 31, applied: 32, pending: 0 });
    expect(applied).toEqual(["202609090032_neon_grok_gateway_namespace.sql"]);
    expect((await insert("xai", canonicalId)).rows[0]).toEqual({ provider: "xai", model_id: canonicalId });
    expect((await insert("openai", "openai/gpt-5.4")).rows[0]).toEqual({ provider: "openai", model_id: "openai/gpt-5.4" });
    expect((await db.query("select provider,model_id from content_engine_model_presets where model_id=$1", [legacyId])).rows).toEqual([{ provider: "xai", model_id: legacyId }]);
    await insert("xai", legacyId);
    await expect(insert("xai", "openai/gpt-5.4")).rejects.toThrow();
    await expect(insert("openai", canonicalId)).rejects.toThrow();
    await expect(insert("other", canonicalId)).rejects.toThrow();
    await expect(insert("spacexai", canonicalId)).rejects.toThrow();
    await expect(insert("xai", "spacexai/")).rejects.toThrow();
    await insert("openai", `openai/${"a".repeat(261)}`);
    await expect(insert("openai", `openai/${"a".repeat(262)}`)).rejects.toThrow();
    expect(await runMigrations(client, migrations, target, true)).toMatchObject({ previouslyApplied: 32, applied: 32, pending: 0 });
  } finally { await db.close(); }
}, 60_000);
