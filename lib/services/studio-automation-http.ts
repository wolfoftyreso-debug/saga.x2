import "server-only";
import { NextResponse } from "next/server";
import { neonWriteErrorResponse } from "@/lib/neon/http";
import { SagaBrandScopeError } from "@/lib/neon/saga-brand-api-eligibility";

export function studioAutomationErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof SagaBrandScopeError) {
    return NextResponse.json({ error: error.message, code: error.code }, {
      status: error.status, headers: { "cache-control": "no-store" },
    });
  }
  return neonWriteErrorResponse(error, fallback);
}
