import { NextRequest, NextResponse } from "next/server";
import { contentDraftCreateSchema, contentDraftStatusSchema } from "@/lib/domain/content-studio";
import { neonConfigurationResponse, neonWriteErrorResponse, requireNeonActor } from "@/lib/neon/http";
import { createStudioDraft, listStudioDrafts } from "@/lib/neon/studio-content-repository";
import { resolveSagaBrandActor, SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Actor-scoped drafts for the calendar tray and editor; no legacy data store path exists. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireVercelNeonActor("Logga in för att läsa innehåll.", request);
  if (resolved.response) return resolved.response;
  const rawStatuses = request.nextUrl.searchParams.get("status");
  const statuses = rawStatuses?.split(",").filter(Boolean) ?? [];
  if (statuses.some((status) => !contentDraftStatusSchema.safeParse(status).success)) {
    return NextResponse.json({ error: "Ogiltig utkaststatus." }, { status: 400, headers: noStoreHeaders });
  }
  const rawLimit = Number(request.nextUrl.searchParams.get("limit") ?? "100");
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 250) {
    return NextResponse.json({ error: "limit måste vara ett heltal mellan 1 och 250." }, { status: 400, headers: noStoreHeaders });
  }
  try {
    const drafts = await listStudioDrafts(resolved.actor, {
      limit: rawLimit,
      statuses: statuses.length ? statuses as never : undefined,
    });
    return NextResponse.json({ drafts }, { headers: noStoreHeaders });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte läsa innehållet.");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireVercelNeonActor("Logga in för att skapa ett utkast.", request, true);
  if (resolved.response) return resolved.response;
  const body = await readJson(request);
  if (body === null) return NextResponse.json({ error: "Skicka giltig JSON." }, { status: 400, headers: noStoreHeaders });
  if (hasWorkspaceField(body)) return invalidDraftResponse();
  const payload = contentDraftCreateSchema.safeParse(body);
  if (!payload.success) return invalidDraftResponse();
  try {
    const draft = await createStudioDraft(resolved.actor, payload.data);
    return NextResponse.json({ draft }, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    return neonWriteErrorResponse(error, "Kunde inte skapa utkastet.");
  }
}

const noStoreHeaders = { "cache-control": "no-store" };

async function requireVercelNeonActor(message: string, request: Request, creating = false) {
  const configuration = neonConfigurationResponse("Studio behöver Neon i Vercel för att hantera utkast.");
  if (configuration) return { response: configuration };
  const resolved = await requireNeonActor(message);
  if (resolved.response) return resolved;
  const selected = new URL(request.url).searchParams.get("brandProfileId");
  if (!creating && selected === null) return resolved;
  try {
    return { actor: await resolveSagaBrandActor(resolved.actor, selected) };
  } catch (error) {
    return { response: NextResponse.json(
      error instanceof SagaBrandScopeError ? { error: error.message, code: error.code } : { error: "Varumärket kunde inte verifieras.", code: "brand_unavailable" },
      { status: error instanceof SagaBrandScopeError ? error.status : 503, headers: noStoreHeaders },
    ) };
  }
}

function hasWorkspaceField(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasWorkspaceField(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || hasWorkspaceField(nested, depth + 1)
  ));
}

function invalidDraftResponse(): NextResponse {
  return NextResponse.json({ error: "Utkastet innehåller ett ogiltigt värde." }, { status: 422, headers: noStoreHeaders });
}

async function readJson(request: NextRequest): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
