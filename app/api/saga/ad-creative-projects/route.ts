import { NextRequest, NextResponse } from "next/server";
import { sagaAdCreativeProjectCreateSchema } from "@/lib/domain/saga-ad-creative";
import {
  createSagaAdCreativeProject,
  listSagaAdCreativeProjects,
} from "@/lib/neon/saga-ad-creative-project-repository";
import {
  containsSagaAdCreativeForbiddenSelector,
  readSagaAdCreativeProjectJson,
  requireSagaAdCreativeProjectActor,
  sagaAdCreativeProjectErrorResponse,
  sagaAdCreativeProjectResponse,
} from "@/lib/services/saga-ad-creative-project-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Lists only the signed actor's private workspace projects. */
export async function GET(): Promise<NextResponse> {
  const resolved = await requireSagaAdCreativeProjectActor("Logga in för att öppna Annonsstudio.");
  if (resolved.response) return resolved.response;
  try {
    return sagaAdCreativeProjectResponse({ projects: await listSagaAdCreativeProjects(resolved.actor) });
  } catch (error) {
    return sagaAdCreativeProjectErrorResponse(error, "Kunde inte läsa annonsprojekten.");
  }
}

/** Creates one private material project. It does not invoke AI or deliver an ad. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const resolved = await requireSagaAdCreativeProjectActor("Logga in för att skapa ett privat annonsprojekt.");
  if (resolved.response) return resolved.response;
  const body = await readSagaAdCreativeProjectJson(request);
  if (body === null || containsSagaAdCreativeForbiddenSelector(body)) return invalidRequest();
  const payload = sagaAdCreativeProjectCreateSchema.safeParse(body);
  if (!payload.success) return invalidRequest();
  try {
    const created = await createSagaAdCreativeProject(resolved.actor, payload.data);
    return sagaAdCreativeProjectResponse({ project: created.project, reused: created.reused }, created.reused ? 200 : 201);
  } catch (error) {
    return sagaAdCreativeProjectErrorResponse(error, "Kunde inte skapa annonsprojektet.");
  }
}

function invalidRequest(): NextResponse {
  return sagaAdCreativeProjectResponse({
    error: "Skicka ett giltigt privat masterbrief och formatvarianter. Arbetsyta, konton, budget, publicering och media väljs aldrig i den här begäran.",
    code: "invalid_ad_creative_request",
  }, 422);
}
