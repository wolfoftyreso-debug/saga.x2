import "server-only";
import type { ApiAccessScope } from "@/lib/domain/api-access";
import { authenticateExternalApiRequest } from "@/lib/services/api-access";

const API_SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Content-Security-Policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  Vary: "Authorization, X-API-Key, Origin",
};

type ApiPrincipal = {
  userId: string;
  keyId: string;
  scopes: ApiAccessScope[];
};

/**
 * API-key authorization lives behind this tiny adapter so endpoints never need
 * to know token storage or hashing details. A missing/revoked/wrong-scope key
 * always has the same response path.
 */
export async function authenticateOutgoingFeedRequest(
  request: Request,
  requiredScope: ApiAccessScope,
  allowQueryToken = false,
): Promise<ApiPrincipal | null> {
  try {
    return await authenticateExternalApiRequest(request, { requiredScope, allowQueryToken });
  } catch {
    // A missing database configuration must fail closed just like a revoked key.
    // It must never accidentally turn into a public feed response.
    return null;
  }
}

export function outgoingFeedHeaders(request: Request, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({ ...API_SECURITY_HEADERS, ...extra });
  for (const [key, value] of Object.entries(configuredCorsHeaders(request))) headers.set(key, value);
  return headers;
}

export function outgoingFeedOptionsHeaders(request: Request): Headers {
  const headers = outgoingFeedHeaders(request, { Allow: "GET, OPTIONS" });
  const cors = configuredCorsHeaders(request);
  if (Object.keys(cors).length) {
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization, X-API-Key, Last-Event-ID, Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }
  return headers;
}

export function outgoingFeedOrigin(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

function configuredCorsHeaders(request: Request): Record<string, string> {
  const allowedOrigin = process.env.PDB_API_ALLOWED_ORIGIN?.trim();
  const requestOrigin = request.headers.get("origin")?.trim();
  if (!allowedOrigin || !requestOrigin || requestOrigin !== allowedOrigin) return {};
  return { "Access-Control-Allow-Origin": allowedOrigin };
}
