import "server-only";

import { NextResponse } from "next/server";
import { getCurrentActor, type AppActor } from "@/lib/neon/auth-repository";
import { getNeonDatabaseConfigurationState, missingNeonConfiguration } from "@/lib/neon/config";

export type NeonActorResolution =
  | { actor: AppActor; response?: never }
  | { actor?: never; response: NextResponse };

/**
 * Resolves identity only from the signed, HttpOnly app session. Route code
 * must never accept a workspace or user id from a request body/query string.
 */
export async function requireNeonActor(message = "Logga in för att öppna Studio."): Promise<NeonActorResolution> {
  try {
    const actor = await getCurrentActor();
    if (actor) return { actor };
    return {
      response: NextResponse.json(
        { error: message, code: "authentication_required" },
        { status: 401, headers: { "cache-control": "no-store" } },
      ),
    };
  } catch {
    return {
      response: NextResponse.json(
        {
          error: "Studio kan inte nå den Vercel-anslutna databasen just nu.",
          code: "configuration_required",
          missing: missingNeonConfiguration(),
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      ),
    };
  }
}

/**
 * Vercel/Neon routes use this before resolving a session. It prevents a
 * missing or malformed DATABASE_URL from ever becoming an invitation to use a
 * retired data store.
 */
export function neonConfigurationResponse(
  message = "Studio behöver en Vercel-ansluten Neon-databas.",
): NextResponse | null {
  const state = getNeonDatabaseConfigurationState();
  if (state === "configured") return null;
  return NextResponse.json(
    state === "invalid"
      ? { error: "Studio har en ogiltig Neon-anslutning i Vercel.", code: "database_configuration_invalid" }
      : { error: message, code: "configuration_required", missing: missingNeonConfiguration() },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export function neonWriteErrorResponse(error: unknown, fallback: string): NextResponse {
  const message = error instanceof Error ? error.message : fallback;
  const status = error instanceof Error && error.name === "StudioContentAccessError"
    ? 403
    : error instanceof Error && error.name === "StudioContentConflictError"
      ? 409
      : error instanceof Error && (error.name === "StudioContentValidationError" || error.name === "SagaCreativeSafetyError")
        ? 422
        : 500;
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}
