import { NextRequest } from "next/server";
import { mediaTenantCreateSchema } from "@/lib/domain/media-engine";
import { createMediaTenant, listMediaTenants } from "@/lib/services/media-engine";
import { mediaEngineConfigErrorResponse, noStore, readJson, resolveMediaEngineConfigRequestContext } from "@/lib/services/media-engine-config-http";

export const dynamic = "force-dynamic";

/** Lists memberships and deterministically provisions a real default tenant for an existing profile. */
export async function GET() {
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  try {
    const tenants = await listMediaTenants(context.value.database, context.value.userId);
    return noStore({ tenants, tenant: tenants.find((tenant) => tenant.isDefault) ?? tenants[0] ?? null });
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  const context = await resolveMediaEngineConfigRequestContext();
  if (!context.ok) return context.response;
  const body = await readJson(request);
  if (body === null) return noStore({ error: "Skicka giltig JSON." }, 400);
  const parsed = mediaTenantCreateSchema.safeParse(body);
  if (!parsed.success) return noStore({ error: parsed.error.issues[0]?.message ?? "Arbetsytan innehåller ett ogiltigt värde." }, 400);
  try {
    const tenant = await createMediaTenant(context.value.database, context.value.userId, parsed.data);
    return noStore({ tenant }, 201);
  } catch (error) {
    return mediaEngineConfigErrorResponse(error);
  }
}
