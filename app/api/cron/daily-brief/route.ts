import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex",
};

/**
 * Retired safety stub for the old Supabase daily scheduler.
 *
 * The former implementation could run legacy brief, social and newsletter
 * delivery code when invoked directly. Vercel now wakes only the Neon-owned
 * private-draft workers at `/api/cron/tick` and `/api/cron/media-generation`.
 * Keep this handler so an old Vercel Cron configuration gets an explicit,
 * non-cacheable answer rather than a missing-route surprise.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: false,
      code: "legacy_cron_retired",
      error: "Den äldre dagliga cron-rutten är avvecklad. Inget innehåll har skapats, skickats eller publicerats.",
      noPublication: true,
      replacement: "/api/cron/tick",
    },
    { status: 410, headers: noStoreHeaders },
  );
}
