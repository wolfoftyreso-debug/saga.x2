import { NextRequest, NextResponse } from "next/server";
import { profileSettingsSchema } from "@/lib/domain/types";
import { updateProfileSettings } from "@/lib/services/brief-reader";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupabaseServiceConfigured, missingSupabaseServiceConfiguration } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export async function PUT(request: NextRequest) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      {
        code: "configuration_required",
        error: "Inställningar kan inte sparas förrän arbetsytans datalager är anslutet.",
        missing: missingSupabaseServiceConfiguration(),
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att ändra inställningarna." }, { status: 401 });

  const payload = profileSettingsSchema.safeParse(await request.json());
  if (!payload.success) {
    return NextResponse.json({ error: "Inställningarna innehåller ett ogiltigt värde." }, { status: 400 });
  }

  try {
    // Migration 005 makes workspace configuration read-only to direct clients.
    // The authenticated route scopes the mutation to the caller, then uses the
    // service client for the coupled profile + primary-brief update.
    const supabase = createAdminClient();
    await updateProfileSettings(supabase, userId, payload.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte spara inställningarna." }, { status: 500 });
  }
}
