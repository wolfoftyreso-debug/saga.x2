import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";
import {
  loadMigrations, parseArguments, prepareMigration, runMigrations, safeFailure,
  SAGA_PROJECT_ID, sqlStatements, validateLedger, validateTarget,
} from "../scripts/neon-migrate.mjs";

const host = "ep-test.eu-central-1.aws.neon.tech";
const target = { host, project: SAGA_PROJECT_ID, database: "postgres" };
function clientFor(db: PGlite) {
  const commands: string[] = [];
  return {
    commands,
    async query(sql: string, values?: unknown[]) {
      commands.push(sql);
      return values?.length ? db.query(sql, values) : (await db.exec(sql)).at(-1)!;
    },
  };
}
const first = prepareMigration("202609090001_neon_first.sql", "begin; create table runner_fixture(id integer primary key); commit;");

describe("Neon migration runner guards", () => {
  it("defaults to status and requires explicit exact target confirmation", () => {
    expect(parseArguments(["--expected-host", host, "--expected-project", SAGA_PROJECT_ID]).apply).toBe(false);
    expect(() => parseArguments([])).toThrow("TARGET_CONFIRMATION_REQUIRED");
    expect(() => parseArguments(["--apply", "--apply"])).toThrow("INVALID_ARGUMENTS");
    expect(() => parseArguments(["--database-url", "secret"])).toThrow("INVALID_ARGUMENTS");
    expect(parseArguments(["--help"]).help).toBe(true);
  });

  it("rejects wrong project, host, pooler, plaintext and non-Neon URL before connecting", () => {
    const input = { connectionString: `postgresql://user:password@${host}/neondb?sslmode=require`, expectedHost: host, expectedProject: SAGA_PROJECT_ID, linkedProject: SAGA_PROJECT_ID };
    expect(validateTarget(input)).toEqual({ host, database: "neondb", project: SAGA_PROJECT_ID });
    expect(() => validateTarget({ ...input, linkedProject: "another" })).toThrow("PROJECT_MISMATCH");
    expect(() => validateTarget({ ...input, expectedHost: "another.neon.tech" })).toThrow("HOST_MISMATCH");
    expect(() => validateTarget({ ...input, connectionString: input.connectionString.replace("ep-test.", "ep-test-pooler.") })).toThrow("DIRECT_NEON_URL_REQUIRED");
    expect(() => validateTarget({ ...input, connectionString: input.connectionString.replace("require", "disable") })).toThrow("SECURE_DATABASE_URL_REQUIRED");
    expect(() => validateTarget({ ...input, connectionString: input.connectionString.replace(host, "example.com") })).toThrow("DIRECT_NEON_URL_REQUIRED");
  });

  it("preserves PL/pgSQL bodies, quoted semicolons and nested comments while removing only outer wrappers", () => {
    const body = "\n/* nested /* commit; */ comment */\ncreate function fixture() returns text language plpgsql as $fn$ begin return 'commit;'; end; $fn$;\n";
    const migration = prepareMigration("202609090002_neon_parser.sql", `-- header\nbegin;${body}commit; -- end`);
    expect(migration.body.trimEnd()).toBe(body.trimEnd());
    expect(sqlStatements(`begin;${body}commit;`)).toHaveLength(3);
    expect(() => prepareMigration("202609090003_neon_break.sql", "begin; select 1; commit; begin; commit;")).toThrow("MIGRATION_TRANSACTION_CONTROL");
    expect(() => prepareMigration("202609090003_neon_break.sql", "begin; select 'unfinished; commit;")).toThrow("MIGRATION_SQL_UNTERMINATED");
  });

  it("requires contiguous known history with matching hashes", () => {
    const row = { sequence: 1, filename: first.name, sha256: first.sha256 };
    expect(validateLedger([row], [first])).toBe(1);
    expect(() => validateLedger([{ ...row, sha256: "changed" }], [first])).toThrow("LEDGER_CHECKSUM_MISMATCH");
    expect(() => validateLedger([{ ...row, sequence: 2 }], [first])).toThrow("LEDGER_CHECKSUM_MISMATCH");
    expect(() => validateLedger([], [first])).toThrow("LEDGER_HISTORY_UNKNOWN");
  });

  it("never exposes raw connection errors or credentials in its safe report", () => {
    const result = safeFailure(new Error("postgres://user:super-secret@host syntax error leaking SQL"));
    expect(JSON.stringify(result)).not.toMatch(/super-secret|postgres:|syntax error|leaking SQL/);
    expect(result.code).toBe("MIGRATION_CONNECTION_OR_STATE_FAILED");
  });

  it("refuses a second runner before opening any migration transaction", async () => {
    const commands: string[] = [];
    const client = { async query(sql: string) { commands.push(sql); return { rows: [{ locked: false }] }; } };
    await expect(runMigrations(client, [first], target, true)).rejects.toThrow("MIGRATION_ALREADY_RUNNING");
    expect(commands).toEqual(["select pg_try_advisory_lock(987311,910090) as locked"]);
  });
});

describe("Neon migration runner real PostgreSQL execution", { timeout: 30_000 }, () => {
  it("keeps pristine status read-only without creating a ledger", async () => {
    const db = new PGlite();
    try {
      const client = clientFor(db);
      expect(await runMigrations(client, [first], target)).toMatchObject({ mode: "status", applied: 0, pending: 1 });
      expect(client.commands[0]).toBe("begin read only");
      expect(client.commands.some((command) => /create schema|advisory_lock/.test(command))).toBe(false);
      expect((await db.query("select to_regnamespace('saga_migration_control') as ledger")).rows[0]).toEqual({ ledger: null });
    } finally { await db.close(); }
  });

  it("refuses a non-empty unknown database, even one with only an otherwise empty schema", async () => {
    const db = new PGlite();
    try {
      await db.exec("create schema someone_elses_schema");
      await expect(runMigrations(clientFor(db), [first], target, true)).rejects.toThrow("UNKNOWN_EXISTING_DATABASE");
      expect((await db.query("select to_regclass('runner_fixture') as fixture")).rows[0]).toEqual({ fixture: null });
    } finally { await db.close(); }
  });

  it("atomically rolls back a failing file and its ledger entry, then resumes without rerunning committed files", async () => {
    const db = new PGlite();
    try {
      const broken = prepareMigration("202609090002_neon_second.sql", "begin; insert into runner_fixture values(7); select missing_function(); commit;");
      await expect(runMigrations(clientFor(db), [first, broken], target, true)).rejects.toThrow("MIGRATION_STOPPED_CHECK_STATUS");
      expect((await db.query("select * from runner_fixture")).rows).toHaveLength(0);
      expect((await db.query("select filename from saga_migration_control.files")).rows).toEqual([{ filename: first.name }]);
      const fixed = prepareMigration(broken.name, "begin; insert into runner_fixture values(8); commit;");
      const resume = await runMigrations(clientFor(db), [first, fixed], target, true);
      expect(resume).toMatchObject({ previouslyApplied: 1, applied: 2, pending: 0 });
      expect((await db.query("select * from runner_fixture")).rows).toEqual([{ id: 8 }]);
      expect(await runMigrations(clientFor(db), [first, fixed], target, true)).toMatchObject({ previouslyApplied: 2, applied: 2 });
      const changed = prepareMigration(first.name, "begin; create table runner_fixture(id text); commit;");
      await expect(runMigrations(clientFor(db), [changed, fixed], target, true)).rejects.toThrow("LEDGER_CHECKSUM_MISMATCH");
    } finally { await db.close(); }
  });

  it("rolls the entire initial bootstrap back when its first migration fails", async () => {
    const db = new PGlite();
    try {
      const broken = prepareMigration(first.name, "begin; create table runner_fixture(id int); select missing_function(); commit;");
      await expect(runMigrations(clientFor(db), [broken], target, true)).rejects.toThrow("MIGRATION_STOPPED_CHECK_STATUS");
      expect((await db.query("select to_regnamespace('saga_migration_control') as ledger,to_regclass('runner_fixture') as fixture")).rows[0]).toEqual({ ledger: null, fixture: null });
      expect(await runMigrations(clientFor(db), [first], target, true)).toMatchObject({ applied: 1 });
    } finally { await db.close(); }
  });

  it("executes all actual migration bodies with ledger entries in the same transaction and safely reruns status/apply", async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    try {
      const migrations = loadMigrations(process.cwd());
      expect(migrations).toHaveLength(32);
      const client = clientFor(db);
      expect(await runMigrations(client, migrations, target, true)).toMatchObject({ applied: 32, pending: 0 });
      expect(client.commands.filter((command) => command === "begin")).toHaveLength(32);
      expect((await db.query("select count(*)::int as count from saga_migration_control.files")).rows[0]).toEqual({ count: 32 });
      expect(await runMigrations(clientFor(db), migrations, target)).toMatchObject({ mode: "status", applied: 32, source: "verified-ledger" });
      expect(await runMigrations(clientFor(db), migrations, target, true)).toMatchObject({ previouslyApplied: 32, applied: 32 });
      await expect(runMigrations(clientFor(db), migrations, { ...target, host: "another.neon.tech" }, true)).rejects.toThrow("LEDGER_TARGET_MISMATCH");
    } finally { await db.close(); }
  }, 60_000);
});
