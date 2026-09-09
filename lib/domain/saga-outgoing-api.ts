import { z } from "zod";
import {
  CONTENT_CHANNELS,
  CONTENT_TYPES,
  contentTypeSchema,
  type ContentChannel,
  type ContentType,
} from "@/lib/domain/content-studio";

/**
 * A Vercel/Neon-owned, read-only export surface for approved Studio content.
 * This is intentionally separate from the retired Brief/RSS API key model.
 */
export const SAGA_OUTGOING_API_CONTENT_TYPES = CONTENT_TYPES;
export const SAGA_OUTGOING_API_VISIBILITIES = ["published_only", "publication_ready"] as const;
export const SAGA_OUTGOING_API_PUBLICATION_READY_STATUSES = ["approved", "scheduled", "published"] as const;

export type SagaOutgoingApiVisibility = (typeof SAGA_OUTGOING_API_VISIBILITIES)[number];
export type SagaOutgoingApiPublicationReadyStatus = (typeof SAGA_OUTGOING_API_PUBLICATION_READY_STATUSES)[number];
export type SagaOutgoingApiContentTypes = "all" | ContentType[];

export const sagaOutgoingApiVisibilitySchema = z.enum(SAGA_OUTGOING_API_VISIBILITIES);
export const sagaOutgoingApiPublicationReadyStatusSchema = z.enum(SAGA_OUTGOING_API_PUBLICATION_READY_STATUSES);
export const sagaOutgoingApiIdSchema = z.string().uuid("Ogiltigt API-utgåve-id.");

const contentTypesInputSchema = z.union([
  z.literal("all"),
  z.array(contentTypeSchema).min(1, "Välj minst en innehållstyp.").max(CONTENT_TYPES.length),
]).superRefine((value, context) => {
  if (Array.isArray(value) && new Set(value).size !== value.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "En innehållstyp får bara väljas en gång." });
  }
});

const nullableFutureIsoDateSchema = z.string().datetime({ offset: true }).nullable().optional();

const outgoingApiInputBaseSchema = z.object({
  name: z.string().trim().min(2, "Ange ett namn för API-utgåvan.").max(120, "Namnet får vara högst 120 tecken."),
  contentTypes: contentTypesInputSchema,
  /** Conservative default: only an already published Studio post can leave SAGA. */
  visibility: sagaOutgoingApiVisibilitySchema.default("published_only"),
  /** Optional hard expiry; omitted means the owner must revoke it explicitly. */
  expiresAt: nullableFutureIsoDateSchema,
}).strict();

export const sagaOutgoingApiCreateSchema = outgoingApiInputBaseSchema;
export const sagaOutgoingApiUpdateSchema = outgoingApiInputBaseSchema.partial().extend({
  /** Required to avoid silently widening an export in a second settings tab. */
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
}).strict().refine((value) => Object.keys(value).some((key) => key !== "expectedRevision"), {
  message: "Välj minst ett fält att ändra.",
});

export type SagaOutgoingApiCreateInput = z.infer<typeof sagaOutgoingApiCreateSchema>;
export type SagaOutgoingApiUpdateInput = z.infer<typeof sagaOutgoingApiUpdateSchema>;

export type NormalizedSagaOutgoingApiScope = {
  scope: "all" | "selected";
  contentTypes: ContentType[];
};

export type SagaOutgoingApiExportView = {
  id: string;
  name: string;
  /** `all` is explicit so a UI never has to infer it from a full array. */
  contentTypes: SagaOutgoingApiContentTypes;
  visibility: SagaOutgoingApiVisibility;
  /** A non-secret routing prefix. It is never enough to authenticate. */
  keyPrefix: string;
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Returned only from create/rotate, never list/read/update/revoke. */
export type SagaOutgoingApiSecretResult = {
  export: SagaOutgoingApiExportView;
  secret: string;
};

/** The intentionally narrow external representation. No metadata, prompts or media belong here. */
export type SagaOutgoingContentItem = {
  id: string;
  contentType: ContentType;
  status: SagaOutgoingApiPublicationReadyStatus;
  title: string;
  body: string;
  excerpt: string | null;
  channels: ContentChannel[];
  scheduledAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type SagaOutgoingContentCursor = {
  updatedAt: string;
  id: string;
};

export type SagaOutgoingContentPage = {
  version: "v1";
  generatedAt: string;
  items: SagaOutgoingContentItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

const cursorSchema = z.object({
  updatedAt: z.string().datetime({ offset: true }),
  id: sagaOutgoingApiIdSchema,
});

const contentTypes = new Set<string>(CONTENT_TYPES);
const channels = new Set<string>(CONTENT_CHANNELS);

export function normalizeSagaOutgoingApiContentTypes(value: SagaOutgoingApiContentTypes): NormalizedSagaOutgoingApiScope {
  if (value === "all") return { scope: "all", contentTypes: [...CONTENT_TYPES] };
  const normalized = [...new Set(value)].filter((contentType): contentType is ContentType => contentTypes.has(contentType))
    .sort((left, right) => CONTENT_TYPES.indexOf(left) - CONTENT_TYPES.indexOf(right));
  if (!normalized.length) throw new Error("En API-utgåva måste ha minst en innehållstyp.");
  return { scope: "selected", contentTypes: normalized };
}

export function exposeSagaOutgoingApiContentTypes(scope: string, values: readonly string[]): SagaOutgoingApiContentTypes {
  const normalized = [...new Set(values)]
    .filter((contentType): contentType is ContentType => contentTypes.has(contentType))
    .sort((left, right) => CONTENT_TYPES.indexOf(left) - CONTENT_TYPES.indexOf(right));
  if (scope === "all" && normalized.length === CONTENT_TYPES.length) return "all";
  if (!normalized.length) throw new Error("API-utgåvans innehållstyp kunde inte läsas säkert.");
  return normalized;
}

export function encodeSagaOutgoingContentCursor(cursor: SagaOutgoingContentCursor): string {
  const parsed = cursorSchema.parse({
    id: cursor.id,
    updatedAt: new Date(cursor.updatedAt).toISOString(),
  });
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeSagaOutgoingContentCursor(value: string | null | undefined): SagaOutgoingContentCursor | null {
  if (!value || value.length > 512) return null;
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (!parsed.success || Number.isNaN(new Date(parsed.data.updatedAt).getTime())) return null;
    return { id: parsed.data.id.toLowerCase(), updatedAt: new Date(parsed.data.updatedAt).toISOString() };
  } catch {
    return null;
  }
}

/**
 * A body can be 60k Unicode code units. Ten items keep the worst-case JSON
 * response well under Vercel's function response limits; consumers paginate.
 */
export function parseSagaOutgoingContentLimit(value: string | null | undefined, fallback = 10): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  if (!/^(?:[1-9]|10)$/.test(value)) return null;
  return Number(value);
}

/** A stored SQL row is treated as untrusted at this boundary. */
export function normalizeSagaOutgoingContentChannels(value: unknown): ContentChannel[] | null {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseJsonArray(value)
      : null;
  if (!raw) return null;
  const result = raw.filter((channel): channel is ContentChannel => typeof channel === "string" && channels.has(channel));
  return result.length === raw.length ? result : null;
}

function parseJsonArray(value: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
