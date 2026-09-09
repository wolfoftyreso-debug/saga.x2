import { NextRequest, NextResponse } from "next/server";
import { sagaOutgoingApiIdSchema } from "@/lib/domain/saga-outgoing-api";
import { rotateSagaOutgoingApiSecret } from "@/lib/neon/saga-outgoing-api-repository";
import {
  requireSagaOutgoingApiOwner,
  sagaOutgoingApiErrorResponse,
  sagaOutgoingApiResponse,
} from "@/lib/services/saga-outgoing-api-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ apiId: string }> };

/** Rotation is the only way to receive a new plaintext bearer secret. */
export async function POST(_request: NextRequest, context: Context): Promise<NextResponse> {
  const resolved = await requireSagaOutgoingApiOwner("Logga in som arbetsytans ägare för att rotera en API-hemlighet.");
  if (resolved.response) return resolved.response;
  const id = sagaOutgoingApiIdSchema.safeParse((await context.params).apiId);
  if (!id.success) {
    return sagaOutgoingApiResponse({ error: "Ogiltigt API-utgåve-id.", code: "invalid_outgoing_api_id" }, 400);
  }
  try {
    const rotated = await rotateSagaOutgoingApiSecret(resolved.actor, id.data);
    return sagaOutgoingApiResponse({
      export: rotated.export,
      secret: rotated.secret,
      endpoint: "/api/saga/outgoing-content",
    });
  } catch (error) {
    return sagaOutgoingApiErrorResponse(error, "Kunde inte rotera API-hemligheten.");
  }
}
