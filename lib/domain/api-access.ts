import { z } from "zod";

/**
 * External keys are deliberately read-only. A separate scope is required for
 * each representation so a leaked RSS link cannot silently open an SSE feed.
 */
export const API_ACCESS_SCOPE_VALUES = ["briefs:read", "feed:json", "feed:rss", "feed:sse"] as const;
export const apiAccessScopeSchema = z.enum(API_ACCESS_SCOPE_VALUES);
export type ApiAccessScope = z.infer<typeof apiAccessScopeSchema>;

export const DEFAULT_API_ACCESS_SCOPES: ApiAccessScope[] = ["briefs:read", "feed:json", "feed:rss"];

export const apiAccessKeyCreateSchema = z.object({
  name: z.string().trim().min(1, "Ange ett namn för nyckeln.").max(80, "Namnet får vara högst 80 tecken."),
  scopes: z.array(apiAccessScopeSchema)
    .min(1, "Välj minst en behörighet.")
    .max(API_ACCESS_SCOPE_VALUES.length)
    .superRefine((scopes, context) => {
      if (new Set(scopes).size !== scopes.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: "En behörighet får bara väljas en gång." });
      }
    })
    .default(DEFAULT_API_ACCESS_SCOPES),
});

export const apiAccessKeyIdSchema = z.string().uuid("Ogiltigt nyckel-id.");
export type ApiAccessKeyCreateInput = z.input<typeof apiAccessKeyCreateSchema>;

/** Safe to return to a signed-in owner. It intentionally has no secret hash. */
export type ApiAccessKeyView = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiAccessScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** The plaintext key exists only in the successful creation response. */
export type CreatedApiAccessKey = {
  key: ApiAccessKeyView;
  plaintextKey: string;
};

export type ApiAccessPrincipal = {
  userId: string;
  keyId: string;
  scopes: ApiAccessScope[];
};

export type ExternalApiAuthenticationOptions = {
  requiredScope: ApiAccessScope;
  /** Query tokens are for RSS/SSE subscriptions only; keep them off for JSON APIs. */
  allowQueryToken?: boolean;
};

export function hasApiAccessScope(scopes: readonly ApiAccessScope[], requiredScope: ApiAccessScope): boolean {
  return scopes.includes(requiredScope);
}
