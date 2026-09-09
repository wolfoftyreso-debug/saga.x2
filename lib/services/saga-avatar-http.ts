import { NextResponse } from "next/server";
import {
  SagaAvatarAccessError,
  SagaAvatarConflictError,
  SagaAvatarNotFoundError,
  SagaAvatarValidationError,
} from "@/lib/neon/saga-avatar-repository";
import { SagaAvatarDirectUploadError } from "@/lib/services/saga-avatar-direct-upload";
import { VercelBlobMediaError } from "@/lib/vercel/blob-media";

export const sagaAvatarNoStoreHeaders = { "cache-control": "no-store" };

export function sagaAvatarErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SagaAvatarAccessError) {
    return NextResponse.json({ error: error.message }, { status: 403, headers: sagaAvatarNoStoreHeaders });
  }
  if (error instanceof SagaAvatarNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404, headers: sagaAvatarNoStoreHeaders });
  }
  if (error instanceof SagaAvatarValidationError) {
    return NextResponse.json({ error: error.message }, { status: 422, headers: sagaAvatarNoStoreHeaders });
  }
  if (error instanceof SagaAvatarConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409, headers: sagaAvatarNoStoreHeaders });
  }
  if (error instanceof SagaAvatarDirectUploadError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: sagaAvatarNoStoreHeaders });
  }
  if (error instanceof VercelBlobMediaError) {
    return NextResponse.json({ error: error.message }, { status: error.status, headers: sagaAvatarNoStoreHeaders });
  }
  return NextResponse.json({ error: fallback }, { status: 500, headers: sagaAvatarNoStoreHeaders });
}

/** Prevents callers from smuggling a workspace scope into any nested payload. */
export function containsWorkspaceId(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => containsWorkspaceId(entry, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    key === "workspaceId" || key === "workspace_id" || containsWorkspaceId(nested, depth + 1)
  ));
}

export async function readSagaAvatarJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
