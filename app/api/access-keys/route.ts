import { NextRequest, NextResponse } from "next/server";
import { apiAccessKeyCreateSchema, apiAccessKeyIdSchema } from "@/lib/domain/api-access";
import { createApiAccessKey, listApiAccessKeys, revokeApiAccessKey } from "@/lib/services/api-access";
import { createAdminClient } from "@/lib/supabase/admin";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att hantera API-nycklar." }, { status: 401 });
  try {
    return NextResponse.json({ keys: await listApiAccessKeys(createAdminClient(), userId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte läsa API-nycklarna." }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att skapa en API-nyckel." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  }
  const payload = apiAccessKeyCreateSchema.safeParse(body);
  if (!payload.success) return NextResponse.json({ error: "API-nyckeln innehåller ett ogiltigt värde." }, { status: 400 });

  try {
    // plaintextKey is intentionally returned once, only in this creation response.
    return NextResponse.json(await createApiAccessKey(createAdminClient(), userId, payload.data), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte skapa API-nyckeln." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const userId = await getAuthenticatedUserId();
  if (!userId) return NextResponse.json({ error: "Logga in för att återkalla en API-nyckel." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400 });
  }
  const keyId = apiAccessKeyIdSchema.safeParse(body && typeof body === "object" ? (body as { id?: unknown }).id : undefined);
  if (!keyId.success) return NextResponse.json({ error: "Ogiltigt nyckel-id." }, { status: 400 });

  try {
    const revoked = await revokeApiAccessKey(createAdminClient(), userId, keyId.data);
    if (!revoked) return NextResponse.json({ error: "API-nyckeln hittades inte." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Kunde inte återkalla API-nyckeln." }, { status: 500 });
  }
}
