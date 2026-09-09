import { NextRequest } from "next/server";
import { z } from "zod";
import { runMediaEngineCheck } from "@/lib/services/media-engine-pipeline";
import { mediaEngineErrorResponse, noStore, readJson, resolveMediaEngineRequestContext } from "@/lib/services/media-engine-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const inputSchema = z.object({
  tenantId: z.string().uuid().optional(),
  ruleId: z.string().uuid().optional(),
  idempotencyKey: z.string().uuid(),
});

/** Manual check only discovers/researches. It has no publication path. */
export async function POST(request: NextRequest) {
  const body = await readJson(request);
  const input = inputSchema.safeParse(body);
  if (!input.success) return noStore({ error: input.error.issues[0]?.message ?? "Skicka en giltig idempotensnyckel." }, 400);
  const context = await resolveMediaEngineRequestContext(input.data.tenantId);
  if (!context.ok) return context.response;
  try {
    const results = await runMediaEngineCheck({
      database: context.value.database,
      userId: context.value.userId,
      payload: { ...input.data, tenantId: context.value.tenant.id },
    });
    const statuses = results.map((result) => result.status);
    const status = statuses.every((value) => value === "already_running") ? 202
      : statuses.some((value) => value === "failed") ? 502
        : 200;
    return noStore({
      ok: status < 400,
      status: statuses.length === 1 ? statuses[0] : "batch_completed",
      runs: results.map((result) => result.run),
      clusters: results.flatMap((result) => result.clusters),
      dossiers: results.flatMap((result) => result.dossiers),
      messages: results.map((result) => result.message),
      noPublication: true,
    }, status);
  } catch (error) {
    return mediaEngineErrorResponse(error);
  }
}
