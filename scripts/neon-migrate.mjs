#!/usr/bin/env node
/**
 * Guarded SAGA preview bootstrap/resume. No cloud provisioning or env writes.
 * Default is a READ ONLY transaction. --apply is deliberately explicit.
 * Only a pristine database or this runner's matching checksum ledger is accepted.
 * Use a verified, isolated Neon preview branch and its DIRECT connection URL.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Pin this clone to its own verified Vercel project before running migrations.
// The placeholder intentionally matches no existing linked deployment.
export const SAGA_PROJECT_ID = "prj_CONFIGURE_SAGA_X2_BEFORE_MIGRATING";
const LEDGER_SCHEMA = "saga_migration_control";
const USAGE = "node scripts/neon-migrate.mjs [--apply] --expected-host <direct-neon-host> --expected-project <vercel-project-id> [--json]";

export class MigrationGuardError extends Error {
  constructor(code) { super(code); this.name = "MigrationGuardError"; this.code = code; }
}
function fail(code) { throw new MigrationGuardError(code); }

export function parseArguments(args) {
  const options = { apply: false, json: false, help: false, expectedHost: "", expectedProject: "" };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) fail("INVALID_ARGUMENTS");
    seen.add(arg);
    if (arg === "--apply") options.apply = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--expected-host" || arg === "--expected-project") {
      const value = args[++i];
      if (!value || value.startsWith("--")) fail("INVALID_ARGUMENTS");
      options[arg === "--expected-host" ? "expectedHost" : "expectedProject"] = value;
    } else fail("INVALID_ARGUMENTS");
  }
  if (!options.help && (!options.expectedHost || !options.expectedProject)) fail("TARGET_CONFIRMATION_REQUIRED");
  return options;
}

export function validateTarget({ connectionString, expectedHost, expectedProject, linkedProject }) {
  if (expectedProject !== SAGA_PROJECT_ID || linkedProject !== expectedProject) fail("PROJECT_MISMATCH");
  let url;
  try { url = new URL(connectionString); } catch { fail("DATABASE_URL_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password || url.pathname === "/" || !url.pathname) fail("DATABASE_URL_INVALID");
  if (!/^[a-z0-9.-]+\.neon\.tech$/.test(url.hostname) || url.hostname.includes("-pooler.") || url.port && url.port !== "5432") fail("DIRECT_NEON_URL_REQUIRED");
  if (!["require", "verify-full", "verify-ca"].includes(url.searchParams.get("sslmode"))) fail("SECURE_DATABASE_URL_REQUIRED");
  if (url.hostname !== expectedHost) fail("HOST_MISMATCH");
  let database;
  try { database = decodeURIComponent(url.pathname.slice(1)); } catch { fail("DATABASE_URL_INVALID"); }
  if (!database || database.includes("/")) fail("DATABASE_URL_INVALID");
  return { host: url.hostname, database, project: expectedProject };
}

/** Top-level SQL splitter, not a SQL rewriter. Quoted function bodies stay intact. */
export function sqlStatements(sql) {
  const statements = [];
  let start = 0;
  let meaningful = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2); i = end < 0 ? sql.length : end + 1; meaningful += " "; continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) fail("MIGRATION_SQL_UNTERMINATED");
      meaningful += " "; continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) fail("MIGRATION_SQL_UNTERMINATED");
      meaningful += " quoted_body "; i = end + dollar.length; continue;
    }
    const char = sql[i];
    if (char === "'" || char === '"') {
      const quote = char;
      const escape = quote === "'" && /(?:^|[^A-Za-z0-9_])[eE]$/.test(sql.slice(Math.max(0, i - 2), i));
      let closed = false; i++;
      while (i < sql.length) {
        if (escape && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; closed = true; break;
        }
        i++;
      }
      if (!closed) fail("MIGRATION_SQL_UNTERMINATED");
      meaningful += " quoted_value "; continue;
    }
    if (char === ";") {
      if (meaningful.trim()) statements.push({ start, end: i + 1, command: meaningful.trim() });
      start = i + 1; meaningful = ""; i++; continue;
    }
    meaningful += char; i++;
  }
  if (meaningful.trim()) fail("MIGRATION_SQL_UNTERMINATED");
  return statements;
}

export function prepareMigration(name, sql) {
  if (!/^\d{12}_neon_[a-z0-9_]+\.sql$/.test(name)) fail("MIGRATION_NAME_INVALID");
  const statements = sqlStatements(sql);
  if (statements.length < 3 || !/^begin$/i.test(statements[0].command) || !/^commit$/i.test(statements.at(-1).command)) fail("MIGRATION_WRAPPER_INVALID");
  for (const statement of statements.slice(1, -1)) {
    if (/^(?:begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i.test(statement.command)) fail("MIGRATION_TRANSACTION_CONTROL");
  }
  return {
    name,
    sha256: createHash("sha256").update(sql, "utf8").digest("hex"),
    // Only remove the known outer BEGIN/COMMIT. Function bodies are unchanged.
    body: sql.slice(statements[0].end, statements.at(-1).start),
  };
}

export function loadMigrations(root) {
  const directory = resolve(root, "db/migrations");
  const names = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  if (!names.length) fail("MIGRATIONS_MISSING");
  const ids = new Set();
  return names.map((name) => {
    const id = name.slice(0, 12);
    if (ids.has(id)) fail("MIGRATION_ORDER_INVALID");
    ids.add(id);
    return prepareMigration(name, readFileSync(resolve(directory, name), "utf8"));
  });
}

export function validateLedger(rows, migrations) {
  if (!rows.length || rows.length > migrations.length) fail("LEDGER_HISTORY_UNKNOWN");
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || row.filename !== migrations[index].name || row.sha256 !== migrations[index].sha256) fail("LEDGER_CHECKSUM_MISMATCH");
  }
  return rows.length;
}

async function inspect(client, migrations, target) {
  const current = (await client.query("select current_database() as database")).rows[0];
  if (current?.database !== target.database) fail("DATABASE_MISMATCH");
  const schema = (await client.query("select oid from pg_catalog.pg_namespace where nspname=$1", [LEDGER_SCHEMA])).rows;
  if (schema.length) {
    const meta = (await client.query("select format_version,vercel_project,host,database_name from saga_migration_control.identity")).rows;
    if (meta.length !== 1 || meta[0].format_version !== 1 || meta[0].vercel_project !== target.project || meta[0].host !== target.host || meta[0].database_name !== target.database) fail("LEDGER_TARGET_MISMATCH");
    const rows = (await client.query("select sequence,filename,sha256 from saga_migration_control.files order by sequence")).rows;
    return { pristine: false, applied: validateLedger(rows, migrations) };
  }
  // Refuse unknown databases, including a schema containing only a function or
  // type. Extension-owned objects are provider/Postgres setup, not application data.
  const objects = (await client.query(`
    with user_namespaces as (
      select oid,nspname from pg_catalog.pg_namespace
      where nspname !~ '^pg_' and nspname <> 'information_schema'
    ), user_objects as (
      select 'pg_class'::regclass as catalog,c.oid from pg_catalog.pg_class c join user_namespaces n on n.oid=c.relnamespace
      union all select 'pg_proc'::regclass,p.oid from pg_catalog.pg_proc p join user_namespaces n on n.oid=p.pronamespace
      union all select 'pg_type'::regclass,t.oid from pg_catalog.pg_type t join user_namespaces n on n.oid=t.typnamespace
      union all select 'pg_namespace'::regclass,n.oid from user_namespaces n where n.nspname <> 'public'
    ) select count(*)::int as count from user_objects o where not exists (
      select 1 from pg_catalog.pg_depend d where d.classid=o.catalog and d.objid=o.oid and d.deptype='e'
    )`)).rows[0];
  if (objects?.count !== 0) fail("UNKNOWN_EXISTING_DATABASE");
  return { pristine: true, applied: 0 };
}

async function createLedger(client, target) {
  await client.query(`
    create schema saga_migration_control;
    revoke all on schema saga_migration_control from public;
    create table saga_migration_control.identity (
      singleton boolean primary key default true check(singleton),
      format_version integer not null check(format_version=1),
      vercel_project text not null,host text not null,database_name text not null
    );
    create table saga_migration_control.files (
      sequence integer primary key check(sequence>0),filename text not null unique,
      sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
      applied_at timestamptz not null default now()
    );
    revoke all on all tables in schema saga_migration_control from public;
  `);
  await client.query("insert into saga_migration_control.identity(format_version,vercel_project,host,database_name) values (1,$1,$2,$3)", [target.project, target.host, target.database]);
}

export async function runMigrations(client, migrations, target, apply = false, onApplied = () => {}) {
  let locked = false;
  try {
    if (apply) {
      locked = (await client.query("select pg_try_advisory_lock(987311,910090) as locked")).rows[0]?.locked === true;
      if (!locked) fail("MIGRATION_ALREADY_RUNNING");
    }
    let state;
    await client.query("begin read only");
    try {
      state = await inspect(client, migrations, target);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {}); throw error;
    }
    const previouslyApplied = state.applied;
    if (apply) {
      for (let index = state.applied; index < migrations.length; index++) {
        const migration = migrations[index];
        await client.query("begin");
        try {
          await client.query("set local search_path = public,pg_catalog; set local lock_timeout = '5s'; set local statement_timeout = '120s'; set local idle_in_transaction_session_timeout = '30s'");
          if (index === 0 && state.pristine) await createLedger(client, target);
          await client.query(migration.body);
          await client.query("insert into saga_migration_control.files(sequence,filename,sha256) values ($1,$2,$3)", [index + 1, migration.name, migration.sha256]);
          await client.query("commit");
          state.applied = index + 1;
          onApplied({ sequence: index + 1, filename: migration.name });
        } catch {
          // COMMIT acknowledgement might be lost: never guess or re-run here.
          // A later status/resume verifies the ledger on the same target first.
          await client.query("rollback").catch(() => {});
          fail("MIGRATION_STOPPED_CHECK_STATUS");
        }
      }
    }
    return { ok: true, mode: apply ? "apply" : "status", previouslyApplied, applied: state.applied, pending: migrations.length - state.applied, total: migrations.length, source: state.pristine ? "pristine" : "verified-ledger" };
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(987311,910090)").catch(() => {});
  }
}

export function safeFailure(error) {
  const code = error instanceof MigrationGuardError ? error.code : "MIGRATION_CONNECTION_OR_STATE_FAILED";
  return { ok: false, code, detail: "Stoppad utan automatisk återställning. Kontrollera mål/miljö och kör status igen. Databasfel och hemligheter visas inte." };
}

export async function main(args = process.argv.slice(2), root = process.cwd()) {
  let client;
  let options;
  try {
    options = parseArguments(args);
    if (options.help) { process.stdout.write(`${USAGE}\nDefault: read-only status. Requires Node 24 and a direct preview DATABASE_URL_UNPOOLED (or POSTGRES_URL_NON_POOLING / direct DATABASE_URL). Loads Next development env; never writes env files.\n`); return 0; }
    if (Number(process.versions.node.split(".")[0]) < 24 || typeof WebSocket !== "function") fail("NODE_24_REQUIRED");
    // Import after selecting development so @next/env cannot inherit test or
    // production mode. Existing process variables still retain precedence.
    process.env.NODE_ENV = "development";
    const { default: nextEnv } = await import("@next/env");
    let envFailed = false;
    nextEnv.loadEnvConfig(root, true, { info() {}, error() { envFailed = true; } });
    if (envFailed) fail("ENV_LOAD_FAILED");
    const link = JSON.parse(readFileSync(resolve(root, ".vercel/project.json"), "utf8"));
    const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING || process.env.DATABASE_URL;
    const target = validateTarget({ connectionString, expectedHost: options.expectedHost, expectedProject: options.expectedProject, linkedProject: link.projectId });
    const migrations = loadMigrations(root);
    const { Client } = await import("@neondatabase/serverless");
    client = new Client({ connectionString, connectionTimeoutMillis: 15_000, application_name: "saga-preview-migration" });
    // The driver may emit async errors/notices with sensitive SQL: never print them.
    client.on("error", () => {});
    client.on("notice", () => {});
    await client.connect();
    const report = await runMigrations(client, migrations, target, options.apply, options.json ? undefined : ({ sequence, filename }) => process.stdout.write(`Tillämpad ${sequence}/${migrations.length}: ${filename}\n`));
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : `SAGA migration ${report.mode}: ${report.applied}/${report.total} verifierade, ${report.pending} återstår.\n`);
    return 0;
  } catch (error) {
    const report = safeFailure(error);
    process.stderr.write(options?.json ? `${JSON.stringify(report)}\n` : `${report.code}: ${report.detail}\n${USAGE}\n`);
    return 1;
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
