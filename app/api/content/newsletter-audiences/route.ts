import { NextRequest, NextResponse } from "next/server";
import { newsletterAudienceInputSchema } from "@/lib/domain/content-studio";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { requireNeonActor } from "@/lib/neon/http";
import { newsletterNeonErrorResponse } from "@/lib/neon/newsletter-http";
import { createStudioNewsletterAudience, listStudioNewsletterAudiences } from "@/lib/neon/newsletter-repository";
import { createNewsletterAudience, listNewsletterAudiences } from "@/lib/services/content-studio";
import { contentStudioServiceConfigurationResponse } from "@/lib/services/content-studio-http";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att läsa nyhetsbrevets mottagarlistor.");
    if (resolved.response) return resolved.response;
    try {
      return NextResponse.json(
        { audiences: await listStudioNewsletterAudiences(resolved.actor) },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte läsa nyhetsbrevets mottagarlistor.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att läsa nyhetsbrevsmålgrupper." }, { status: 401 });
  try {
    return NextResponse.json({ audiences: await listNewsletterAudiences(createAdminClient(), userId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa nyhetsbrevsmålgrupperna." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (isNeonDatabaseConfigured()) {
    const resolved = await requireNeonActor("Logga in för att skapa en mottagarlista.");
    if (resolved.response) return resolved.response;
    const body = await readJson(request);
    if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
    const payload = newsletterAudienceInputSchema.safeParse(body);
    if (!payload.success) return NextResponse.json({ error: "Mottagarlistan innehåller ett ogiltigt värde." }, { status: 400 });
    try {
      const audience = await createStudioNewsletterAudience(resolved.actor, payload.data);
      return NextResponse.json({ audience }, { status: 201, headers: { "cache-control": "no-store" } });
    } catch (error) {
      return newsletterNeonErrorResponse(error, "Kunde inte skapa mottagarlistan.");
    }
  }
  const configuration = contentStudioServiceConfigurationResponse();
  if (configuration) return configuration;
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en nyhetsbrevsmålgrupp." }, { status: 401 });
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  const payload = newsletterAudienceInputSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "Nyhetsbrevsmålgruppen innehåller ett ogiltigt värde." }, { status: 400 });
  try {
    const audience = await createNewsletterAudience(createAdminClient(), userId, payload.data);
    return NextResponse.json({ audience }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte skapa nyhetsbrevsmålgruppen." }, { status: 500 });
  }
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
