import { NextRequest, NextResponse } from "next/server";
import { flowControlsSchema } from "@/lib/domain/flow-controls";
import { getFlowControls, updateFlowControls } from "@/lib/services/flow-controls";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseServiceConfigured, missingSupabaseServiceConfiguration } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function configurationRequired() {
  return NextResponse.json(
    {
      code: "configuration_required",
      error: "Flödesinställningar kan inte läsas eller sparas förrän arbetsytans datalager är anslutet.",
      missing: missingSupabaseServiceConfiguration(),
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  if (!isSupabaseServiceConfigured()) return configurationRequired();
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa flödesinställningarna." }, { status: 401 });
  try {
    const controls = await getFlowControls(createAdminClient(), userId);
    return NextResponse.json({ controls });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa flödesinställningarna." }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  if (!isSupabaseServiceConfigured()) return configurationRequired();
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra flödesinställningarna." }, { status: 401 });
  const payload = flowControlsSchema.safeParse(await request.json());
  if (!payload.success) return NextResponse.json({ error: "Flödesinställningarna innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const controls = await updateFlowControls(createAdminClient(), userId, payload.data);
    return NextResponse.json({ ok: true, controls });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte spara flödesinställningarna." }, { status: 500 });
  }
}
