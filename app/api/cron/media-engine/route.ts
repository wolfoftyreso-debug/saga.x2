import { NextRequest, NextResponse } from "next/server";
import { getMediaEngineConfiguration, getMediaEngineCronRunLimit, runDueMediaEngineResearch } from "@/lib/services/media-engine-pipeline";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseServiceConfigured, missingSupabaseServiceConfiguration } from "@/lib/supabase/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Vercel Cron / an external scheduler wakes this endpoint. It checks durable
 * next_run_at receipts and creates private research handoffs only. Publication
 * remains the explicit Content Studio workflow.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Otillåten cron-förfrågan." }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: "Researchmotorn saknar Supabase-konfiguration.", missing: missingSupabaseServiceConfiguration() }, {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  const configuration = getMediaEngineConfiguration();
  if (!configuration.ready) {
    return NextResponse.json({
      error: "Researchmotorn är inte redo för schemalagda körningar.",
      configuration,
      noPublication: true,
    }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  try {
    const runLimit = getMediaEngineCronRunLimit();
    const results = await runDueMediaEngineResearch({ database: createAdminClient(), limit: runLimit });
    return NextResponse.json({
      ok: results.every((result) => result.status !== "failed"),
      runLimit,
      processed: results.length,
      message: `Cron kör högst ${runLimit} researchregel${runLimit === 1 ? "" : "r"} per anrop; övriga förfallna regler väntar till nästa 15-minuterskörning.`,
      runs: results.map((result) => ({ id: result.run.id, status: result.status, message: result.message })),
      noPublication: true,
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Researchcron kunde inte köras.",
      noPublication: true,
    }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
