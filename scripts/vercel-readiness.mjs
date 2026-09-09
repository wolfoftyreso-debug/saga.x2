#!/usr/bin/env node

/**
 * Secret-safe deployment preflight for SAGA's Vercel-first runtime.
 *
 * It deliberately validates configuration shape and repository wiring only.
 * It never opens a database connection, calls Blob, invokes a model, or
 * prints environment-variable values. Use /api/health after deploy for the
 * live Neon probe.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import nextEnv from "@next/env";

const root = process.cwd();
const argumentsSet = new Set(process.argv.slice(2));
const staticOnly = argumentsSet.has("--static");
const json = argumentsSet.has("--json");
const invalidArguments = [...argumentsSet].filter((argument) => !["--static", "--json"].includes(argument));

if (invalidArguments.length > 0) {
  process.stderr.write("Unknown option.\nUsage: node scripts/vercel-readiness.mjs [--static] [--json]\n");
  process.exitCode = 2;
} else {
  const checks = [];

  function check(id, title, status, detail) {
    checks.push({ id, title, status, detail });
  }

  // Match Next's CLI defaults: production unless development/test is explicit.
  // Static checks must not open local secret files. Never forward loader logs:
  // dotenv expansion/read failures may include source text or sensitive paths.
  const environmentMode = process.env.NODE_ENV ?? "production";
  const environment = { mode: staticOnly ? null : environmentMode, loadedFiles: [] };
  if (!staticOnly) {
    let loadFailed = !["production", "development", "test"].includes(environmentMode);
    if (!loadFailed) {
      try {
        const loaded = nextEnv.loadEnvConfig(root, environmentMode === "development", {
          info() {},
          error() { loadFailed = true; },
        });
        environment.loadedFiles = loaded.loadedEnvFiles.map((file) => file.path);
      } catch {
        loadFailed = true;
      }
    } else {
      // Do not echo arbitrary NODE_ENV values into a supposedly secret-safe report.
      environment.mode = "invalid";
    }
    check(
      "environment-loading",
      "Next.js-miljö",
      loadFailed ? "fail" : "pass",
      loadFailed
        ? "Miljöfilerna kunde inte läsas eller expanderas. Kontrollera filerna lokalt och använd NODE_ENV=production, development eller test. Inga filvärden visas."
        : `Next.js laddningsordning används (${environmentMode}). ${environment.loadedFiles.length} miljöfiler lästes; befintliga processvariabler har företräde.`,
    );
  }

  function textFile(relativePath) {
    const file = resolve(root, relativePath);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8");
  }

  function parseJson(relativePath) {
    const text = textFile(relativePath);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function hasValue(name) {
    return Boolean(process.env[name]?.trim());
  }

  function validPostgresUrl(value) {
    if (!value?.trim()) return false;
    try {
      const url = new URL(value);
      return (url.protocol === "postgres:" || url.protocol === "postgresql:")
        && Boolean(url.hostname)
        && Boolean(url.pathname && url.pathname !== "/")
        && url.searchParams.get("sslmode") !== "disable";
    } catch {
      return false;
    }
  }

  const packageJson = parseJson("package.json");
  if (!packageJson) {
    check("package-json", "package.json", "fail", "Filen kunde inte läsas som JSON.");
  } else {
    // SAGA deliberately requires a canonical major pin, not every semver range
    // Vercel accepts: open-ended ranges can silently select a future runtime.
    // Supported majors verified 2026-09-09 against Vercel's Node.js versions guide.
    const pinnedNodeVersion = typeof packageJson.engines?.node === "string"
      ? packageJson.engines.node.trim()
      : "";
    const hasSupportedNodeMajor = /^(20|22|24)\.x$/.test(pinnedNodeVersion);
    check(
      "node-runtime",
      "Node-runtime",
      hasSupportedNodeMajor ? "pass" : "fail",
      hasSupportedNodeMajor
        ? `Projektet låser Node till ${pinnedNodeVersion}.`
        : "Lås engines.node i package.json till 24.x (rekommenderad), 22.x eller 20.x. Använd formatet major.x; öppna intervall och andra versionsuttryck godkänns inte.",
    );
    const missingDependencies = ["@neondatabase/serverless", "@vercel/blob"].filter((name) => !packageJson.dependencies?.[name]);
    check(
      "vercel-dependencies",
      "Vercel/Neon-beroenden",
      missingDependencies.length === 0 ? "pass" : "fail",
      missingDependencies.length === 0 ? "Neon och privat Blob finns i produktionsberoenden." : `Saknas: ${missingDependencies.join(", ")}.`,
    );
    const hasBuildAndTest = Boolean(packageJson.scripts?.build && packageJson.scripts?.test);
    check(
      "verification-scripts",
      "Bygg- och testkommandon",
      hasBuildAndTest ? "pass" : "fail",
      hasBuildAndTest ? "npm run build och npm test är definierade." : "Definiera build och test i package.json.",
    );
  }

  const vercelConfig = parseJson("vercel.json");
  const tickCron = Array.isArray(vercelConfig?.crons)
    ? vercelConfig.crons.find((cron) => cron?.path === "/api/cron/tick")
    : null;
  const mediaCron = Array.isArray(vercelConfig?.crons)
    ? vercelConfig.crons.find((cron) => cron?.path === "/api/cron/media-generation")
    : null;
  const cronRoutesReady = tickCron?.schedule === "* * * * *" && mediaCron?.schedule === "* * * * *";
  check(
    "cron-route",
    "Vercel Cron",
    cronRoutesReady ? "pass" : "fail",
    cronRoutesReady
      ? "Cron väcker den Vercel-ägda textkön och den separata privata mediekön varje minut. Kräver Vercel Pro för minutprecision."
      : "vercel.json måste innehålla både /api/cron/tick och /api/cron/media-generation med schema * * * * *.",
  );

  const runtimeFence = textFile("lib/runtime/vercel-only.ts");
  const proxy = textFile("proxy.ts");
  const hasRuntimeFence = Boolean(
    runtimeFence?.includes("isVercelOnlyMode")
      && runtimeFence.includes("assertSupabaseAllowed")
      && proxy?.includes("isLegacySupabaseApiPath"),
  );
  check(
    "legacy-store-fence",
    "Ingen Supabase-fallback",
    hasRuntimeFence ? "pass" : "fail",
    hasRuntimeFence
      ? "Vercel-läget spärrar gamla API-vägar och Supabase-klienter innan de kan användas."
      : "Runtime-fencen för gamla Supabase-vägar saknas eller är ofullständig.",
  );

  const migrationsDirectory = resolve(root, "db/migrations");
  const migrations = existsSync(migrationsDirectory)
    ? readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()
    : [];
  const validMigrationNames = migrations.length > 0 && migrations.every((name) => /^\d{12}_neon_[a-z0-9_]+\.sql$/i.test(name));
  check(
    "neon-migrations",
    "Neon-migrationer",
    validMigrationNames ? "pass" : "fail",
    validMigrationNames
      ? `${migrations.length} migrationer hittades. Ny databas: kör i namnordning. Befintlig databas: kör endast ännu inte tillämpade migrationer efter säkerhetskopiering.`
      : "db/migrations måste innehålla namngivna Neon-migrationer (YYYYMMDDNNNN_neon_*.sql).",
  );

  const environmentTemplate = textFile(".env.example") ?? "";
  const templateKeys = new Set(
    [...environmentTemplate.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
  );
  const requiredTemplateKeys = [
    "DATABASE_URL",
    "BLOB_READ_WRITE_TOKEN",
    "NEXT_PUBLIC_VERCEL_APP_CLIENT_ID",
    "VERCEL_APP_CLIENT_SECRET",
    "CRON_SECRET",
  ];
  const absentTemplateKeys = requiredTemplateKeys.filter((key) => !templateKeys.has(key));
  const legacyTemplateKeys = [...templateKeys].filter((key) => /SUPABASE/.test(key));
  check(
    "environment-template",
    "Vercel-miljömall",
    absentTemplateKeys.length === 0 && legacyTemplateKeys.length === 0 ? "pass" : "fail",
    absentTemplateKeys.length === 0 && legacyTemplateKeys.length === 0
      ? "Mallen listar bara den Vercel-first grund som behövs utan Supabase-variabler."
      : [
        absentTemplateKeys.length ? `Saknar: ${absentTemplateKeys.join(", ")}.` : "",
        legacyTemplateKeys.length ? `Ta bort äldre Supabase-nycklar: ${legacyTemplateKeys.join(", ")}.` : "",
      ].filter(Boolean).join(" "),
  );

  if (!staticOnly) {
    check(
      "database-url",
      "Neon-databas",
      validPostgresUrl(process.env.DATABASE_URL) ? "pass" : "fail",
      validPostgresUrl(process.env.DATABASE_URL)
        ? "DATABASE_URL har giltig PostgreSQL-form utan uttryckligen avstängd TLS. Anslutningen är inte provad."
        : "Anslut Neon via Vercel Marketplace så att DATABASE_URL finns och använder TLS.",
    );
    check(
      "blob-token",
      "Privat Blob-media",
      hasValue("BLOB_READ_WRITE_TOKEN") ? "pass" : "fail",
      hasValue("BLOB_READ_WRITE_TOKEN")
        ? "BLOB_READ_WRITE_TOKEN finns; privata original kan lagras och läsas via appens skyddade route."
        : "Skapa och koppla en private Vercel Blob store (BLOB_READ_WRITE_TOKEN).",
    );
    const identityKeys = ["NEXT_PUBLIC_VERCEL_APP_CLIENT_ID", "VERCEL_APP_CLIENT_SECRET"];
    const missingIdentity = identityKeys.filter((key) => !hasValue(key));
    check(
      "vercel-identity",
      "Sign in with Vercel",
      missingIdentity.length === 0 ? "pass" : "fail",
      missingIdentity.length === 0
        ? "Inloggningskonfigurationen är närvarande. Verifiera callback-URL efter deploy."
        : `Skapa en Sign in with Vercel-app och lägg till: ${missingIdentity.join(", ")}.`,
    );
    const cronSecret = process.env.CRON_SECRET?.trim() ?? "";
    check(
      "cron-secret",
      "Cron-skydd",
      cronSecret.length >= 16 ? "pass" : "fail",
      cronSecret.length >= 16
        ? "CRON_SECRET är konfigurerad med minst 16 tecken."
        : "Lägg till en slumpmässig CRON_SECRET på minst 16 tecken.",
    );
    const aiGateway = hasValue("AI_GATEWAY_API_KEY") || hasValue("VERCEL_OIDC_TOKEN");
    check(
      "ai-gateway",
      "Vercel AI Gateway",
      aiGateway ? "pass" : "warn",
      aiGateway
        ? "AI Gateway-autentisering finns för riktig utkastsgenerering."
        : "Ingen lokal Gateway-credential hittades. I Production kan Vercel OIDC användas; lokalt krävs AI_GATEWAY_API_KEY för att testa riktig generering.",
    );
    const configuredLegacyKeys = Object.keys(process.env).filter((key) => /^(?:NEXT_PUBLIC_)?SUPABASE(?:_|$)/.test(key));
    check(
      "no-supabase-environment",
      "Ren Vercel-miljö",
      configuredLegacyKeys.length === 0 ? "pass" : "fail",
      configuredLegacyKeys.length === 0
        ? "Inga Supabase-miljövariabler är satta."
        : `Ta bort äldre Supabase-variabler från Vercel: ${configuredLegacyKeys.sort().join(", ")}.`,
    );
    const guardianKey = hasValue("GUARDIAN_OPEN_PLATFORM_API_KEY");
    const guardianLicensed = process.env.SAGA_NEWS_GUARDIAN_COMMERCIAL_LICENSED?.trim().toLowerCase() === "true";
    check(
      "guardian-license-gate",
      "Guardian-licensgrind",
      guardianKey === guardianLicensed ? "pass" : "fail",
      guardianKey === guardianLicensed
        ? guardianKey
          ? "Guardian är markerad som kommersiellt licensierad."
          : "Guardian är avstängd tills både licensflagga och servernyckel har godkänts."
        : "Guardian kräver både GUARDIAN_OPEN_PLATFORM_API_KEY och SAGA_NEWS_GUARDIAN_COMMERCIAL_LICENSED=true — eller inget av dem.",
    );
  }

  const failed = checks.filter((entry) => entry.status === "fail");
  const warned = checks.filter((entry) => entry.status === "warn");
  const report = {
    ok: failed.length === 0,
    staticOnly,
    environment,
    checks,
    migrationFiles: migrations,
    next: staticOnly
      ? "Kör npm run check:vercel i den miljö som ska deployas."
      : failed.length === 0
        ? "Kör npm run lint, npm test och npm run build. Efter Production-deploy: kontrollera /api/health och genomför den manuella Studio-proven i docs/VERCEL_SETUP.md."
        : "Åtgärda varje röd rad utan att kopiera hemligheter till koden. Kör sedan npm run check:vercel igen.",
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`\nSAGA Vercel preflight${staticOnly ? " (statisk)" : ""}\n\n`);
    for (const entry of checks) {
      const marker = entry.status === "pass" ? "✓" : entry.status === "warn" ? "!" : "✗";
      process.stdout.write(`${marker} ${entry.title}: ${entry.detail}\n`);
    }
    process.stdout.write(`\n${failed.length === 0 ? "Klar" : "Inte redo"}: ${failed.length} fel, ${warned.length} varningar.\n${report.next}\n`);
  }

  if (failed.length > 0) process.exitCode = 1;
}
