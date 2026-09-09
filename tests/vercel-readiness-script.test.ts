import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
const script = resolve("scripts/vercel-readiness.mjs");
const configured = {
  DATABASE_URL: "postgresql://saga:fixture-db-secret@db.example.test/saga?sslmode=require",
  BLOB_READ_WRITE_TOKEN: "fixture-blob-secret",
  NEXT_PUBLIC_VERCEL_APP_CLIENT_ID: "fixture-client-id",
  VERCEL_APP_CLIENT_SECRET: "fixture-client-secret",
  CRON_SECRET: "fixture-cron-secret-long-enough",
  AI_GATEWAY_API_KEY: "fixture-gateway-secret",
};

function fixture(files: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "saga-readiness-"));
  fixtures.push(directory);
  for (const file of ["package.json", "vercel.json", ".env.example", "lib/runtime/vercel-only.ts", "proxy.ts"]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    copyFileSync(resolve(file), join(directory, file));
  }
  mkdirSync(join(directory, "db/migrations"), { recursive: true });
  writeFileSync(join(directory, "db/migrations/202601010001_neon_fixture.sql"), "-- fixture only\n");
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(directory, file), contents);
  return directory;
}

function run(directory: string, env: Record<string, string> = {}, args = ["--json"]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: directory,
    encoding: "utf8",
    // Do not inherit credentials or Vitest's test NODE_ENV into subprocesses.
    env: { SystemRoot: process.env.SystemRoot, NODE_ENV: "production", ...env },
  });
  return { ...result, report: args.includes("--json") ? JSON.parse(result.stdout) : null };
}

function envText(values: Record<string, string>) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n");
}

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Vercel deployment preflight", () => {
  it.each(["20.x", "22.x", "24.x", " 24.x "])("accepts the supported explicit Node major pin %s", (node) => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    packageJson.engines = { ...packageJson.engines, node };
    const result = run(fixture({ "package.json": JSON.stringify(packageJson) }), {}, ["--static", "--json"]);

    expect(result.status).toBe(0);
    expect(result.report.checks.find((check: { id: string }) => check.id === "node-runtime"))
      .toMatchObject({ status: "pass", detail: `Projektet låser Node till ${node.trim()}.` });
  });

  it.each([
    undefined, null, 24, {}, "", "*", "18.x", "26.x", "120.x", ">=20.9.0", "^24.0.0", "20.x || 24.x", "garbage20", "24.x\nprivate-sentinel",
  ])("rejects non-canonical, unsupported or malformed Node engine %j", (node) => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    packageJson.engines = { node };
    const result = run(fixture({ "package.json": JSON.stringify(packageJson) }), {}, ["--static", "--json"]);

    expect(result.status).toBe(1);
    expect(result.report.checks.filter((check: { status: string }) => check.status === "fail").map((check: { id: string }) => check.id))
      .toEqual(["node-runtime"]);
    expect(result.report.checks.find((check: { id: string }) => check.id === "node-runtime")?.detail)
      .toContain("24.x (rekommenderad), 22.x eller 20.x");
    expect(result.stdout).not.toContain("private-sentinel");
    expect(result.stderr).toBe("");
  });

  it("has a passing static preflight without reading deployment secrets", () => {
    const result = spawnSync(process.execPath, ["scripts/vercel-readiness.mjs", "--static", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      staticOnly: boolean;
      checks: Array<{ id: string; status: string }>;
      migrationFiles: string[];
    };
    expect(report.ok).toBe(true);
    expect(report.staticOnly).toBe(true);
    expect(report.migrationFiles.length).toBeGreaterThan(0);
    expect(report.checks.find((check) => check.id === "legacy-store-fence")?.status).toBe("pass");
    expect(report.checks.find((check) => check.id === "cron-route")?.status).toBe("pass");
  });

  it("loads local Next configuration and never prints configured values", () => {
    const directory = fixture({ ".env.local": envText(configured) });
    for (const args of [["--json"], []]) {
      const result = run(directory, {}, args);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      for (const value of Object.values(configured)) expect(result.stdout).not.toContain(value);
      if (result.report) {
        expect(result.report.environment).toEqual({ mode: "production", loadedFiles: [".env.local"] });
        expect(result.report.checks.find((check: { id: string }) => check.id === "database-url")?.status).toBe("pass");
      }
    }
  });

  it("honors process > production.local > local > production > env precedence", () => {
    const directory = fixture({
      ".env": envText({ ...configured, DATABASE_URL: "base-is-invalid", CRON_SECRET: "short" }),
      ".env.production": "DATABASE_URL=production-is-invalid\nCRON_SECRET=production-cron-secret",
      ".env.local": `DATABASE_URL=${configured.DATABASE_URL}`,
      ".env.production.local": "DATABASE_URL=production-local-is-invalid",
    });
    const fileResult = run(directory);
    expect(fileResult.report.checks.find((check: { id: string }) => check.id === "database-url")?.status).toBe("fail");
    const processResult = run(directory, { DATABASE_URL: configured.DATABASE_URL });
    expect(processResult.status).toBe(0);
    expect(processResult.report.environment.loadedFiles).toEqual([".env.production.local", ".env.local", ".env.production", ".env"]);
    const localDirectory = fixture({ ".env": envText({ ...configured, DATABASE_URL: "invalid" }), ".env.local": `DATABASE_URL=${configured.DATABASE_URL}` });
    expect(run(localDirectory).status).toBe(0);
  });

  it("uses development and test files explicitly and excludes local secrets in test mode", () => {
    const directory = fixture({
      ".env.development": envText(configured),
      ".env.test": envText(configured),
      ".env.local": "DATABASE_URL=invalid-local-url",
    });
    expect(run(directory, { NODE_ENV: "test" }).status).toBe(0);
    expect(run(directory, { NODE_ENV: "test" }).report.environment.loadedFiles).toEqual([".env.test"]);
    expect(run(directory, { NODE_ENV: "development" }).status).toBe(1);
    const developmentDirectory = fixture({ ".env.development": envText(configured) });
    expect(run(developmentDirectory, { NODE_ENV: "development" }).status).toBe(0);
  });

  it("reports missing configuration accurately without claiming live readiness", () => {
    const result = run(fixture());
    expect(result.status).toBe(1);
    expect(result.report.checks.filter((check: { status: string }) => check.status === "fail").map((check: { id: string }) => check.id))
      .toEqual(["database-url", "blob-token", "vercel-identity", "cron-secret"]);
    expect(result.report.checks.find((check: { id: string }) => check.id === "ai-gateway")?.status).toBe("warn");
  });

  it("fails closed on dotenv expansion errors without leaking loader diagnostics", () => {
    const directory = fixture({ ".env.local": "PRIVATE_SENTINEL=do-not-log-this\nA=$B\nB=$A" });
    const result = run(directory);
    expect(result.status).toBe(1);
    expect(result.report.checks.find((check: { id: string }) => check.id === "environment-loading")?.status).toBe("fail");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("do-not-log-this");
    expect(result.stdout).not.toContain("RangeError");
    expect(run(directory, {}, ["--static", "--json"]).status).toBe(0);
  });

  it("does not echo arbitrary NODE_ENV or command-line values", () => {
    const directory = fixture();
    const result = run(directory, { NODE_ENV: "private-invalid-value" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("private-invalid-value");
    const invalidArgument = run(directory, {}, ["--private-argument"]);
    expect(invalidArgument.status).toBe(2);
    expect(invalidArgument.stderr).not.toContain("--private-argument");
  });
});
