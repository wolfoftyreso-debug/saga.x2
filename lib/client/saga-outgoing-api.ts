/**
 * Browser-safe adapter for SAGA's external content exports.
 *
 * This module intentionally has no workspace identifier, no local fallback
 * and no storage. The server derives the workspace from the signed session;
 * a bearer secret only lives in the creation response and the React state that
 * displays it once.
 */

export const sagaOutgoingContentTypeOptions = [
  { value: "social_post", label: "Sociala inlägg", detail: "Godkända kanalversioner" },
  { value: "newsletter", label: "Nyhetsbrev", detail: "Godkända utskick" },
  { value: "article", label: "Artiklar", detail: "Godkända längre texter" },
] as const;

export type SagaOutgoingContentType = (typeof sagaOutgoingContentTypeOptions)[number]["value"];

export const sagaOutgoingVisibilityOptions = [
  {
    value: "published_only",
    label: "Bara publicerat",
    detail: "Externa system får endast läsa material som redan är publicerat.",
  },
  {
    value: "publication_ready",
    label: "Publicerat + publiceringsklart",
    detail: "Inkluderar även innehåll som är godkänt och klart för publicering.",
  },
] as const;

export type SagaOutgoingVisibility = (typeof sagaOutgoingVisibilityOptions)[number]["value"];

export type SagaOutgoingApiExport = {
  id: string;
  name: string;
  contentTypes: SagaOutgoingContentType[];
  visibility: SagaOutgoingVisibility;
  /** Non-secret routing prefix used only to identify a key in Settings. */
  keyPrefix: string | null;
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revision: number;
  endpoint: string;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SagaOutgoingApiCreateInput = {
  name: string;
  contentTypes: "all" | SagaOutgoingContentType[];
  visibility: SagaOutgoingVisibility;
};

export type SagaOutgoingApiCreated = {
  api: SagaOutgoingApiExport;
  bearerToken: string;
};

type UnknownRecord = Record<string, unknown>;

export const SAGA_OUTGOING_CONTENT_ENDPOINT = "/api/saga/outgoing-content";

export class SagaOutgoingApiHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SagaOutgoingApiHttpError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function isContentType(value: unknown): value is SagaOutgoingContentType {
  return sagaOutgoingContentTypeOptions.some((option) => option.value === value);
}

function isVisibility(value: unknown): value is SagaOutgoingVisibility {
  return sagaOutgoingVisibilityOptions.some((option) => option.value === value);
}

function contentTypes(value: unknown): SagaOutgoingContentType[] {
  if (value === "all") return sagaOutgoingContentTypeOptions.map((option) => option.value);
  if (!Array.isArray(value)) return [];
  return value.filter(isContentType);
}

function isStatus(value: unknown): value is SagaOutgoingApiExport["status"] {
  return value === "active" || value === "revoked" || value === "expired";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * A configuration endpoint must never contain credentials. Treat an
 * unexpected query/hash/credential-bearing value as an invalid response
 * rather than placing it in copyable UI or a browser request.
 */
export function safeSagaOutgoingEndpoint(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate || candidate.length > 2_048) return null;
  try {
    const base = "https://saga.invalid";
    const url = new URL(candidate, base);
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.origin !== base && url.protocol !== "https:") return null;
    return candidate.startsWith("/") ? `${url.pathname}` : url.toString();
  } catch {
    return null;
  }
}

function exportFromPayload(value: unknown, endpoint = SAGA_OUTGOING_CONTENT_ENDPOINT): SagaOutgoingApiExport | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const name = text(value.name);
  const safeEndpoint = safeSagaOutgoingEndpoint(endpoint);
  const parsedContentTypes = contentTypes(value.contentTypes ?? value.content_types);
  const visibility = value.visibility;
  const revision = positiveInteger(value.revision);
  if (!id || !name || !safeEndpoint || parsedContentTypes.length === 0 || !isVisibility(visibility) || !isStatus(value.status) || !revision) return null;
  return {
    id,
    name,
    endpoint: safeEndpoint,
    contentTypes: [...new Set(parsedContentTypes)],
    visibility,
    keyPrefix: text(value.keyPrefix ?? value.key_prefix),
    status: value.status,
    expiresAt: text(value.expiresAt ?? value.expires_at),
    lastUsedAt: text(value.lastUsedAt ?? value.last_used_at),
    revision,
    createdAt: text(value.createdAt ?? value.created_at),
    updatedAt: text(value.updatedAt ?? value.updated_at),
  };
}

export function sagaOutgoingApisFromPayload(payload: unknown): SagaOutgoingApiExport[] | null {
  if (!isRecord(payload)) return null;
  const values = payload.exports ?? payload.outgoingApis ?? payload.items;
  if (!Array.isArray(values)) return null;
  return values.map((item) => exportFromPayload(item)).filter((item): item is SagaOutgoingApiExport => Boolean(item));
}

export function sagaOutgoingApiCreatedFromPayload(payload: unknown): SagaOutgoingApiCreated | null {
  if (!isRecord(payload)) return null;
  const endpoint = safeSagaOutgoingEndpoint(payload.endpoint) ?? SAGA_OUTGOING_CONTENT_ENDPOINT;
  const api = exportFromPayload(payload.api ?? payload.export ?? payload.item, endpoint);
  const bearerToken = text(payload.bearerToken ?? payload.bearer_token ?? payload.secret ?? payload.token);
  if (!api || !bearerToken || bearerToken.length > 1_024) return null;
  return { api, bearerToken };
}

export function sagaOutgoingApiMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const code = text(payload.code);
  if (code === "configuration_required" || code === "configuration_missing" || code === "database_configuration_invalid") {
    return "API-exporter kan användas när arbetsytans säkra datalager är redo i Vercel.";
  }
  if (code === "forbidden" || code === "owner_required") {
    return "Bara arbetsytans ägare kan skapa och återkalla API-exporter.";
  }
  return text(payload.error) ?? fallback;
}

export async function getSagaOutgoingApis(
  apiPath = "/api/saga/outgoing-apis",
  signal?: AbortSignal,
): Promise<SagaOutgoingApiExport[]> {
  const response = await fetch(apiPath, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  const exports = sagaOutgoingApisFromPayload(payload);
  if (!response.ok || !exports) {
    throw new SagaOutgoingApiHttpError(sagaOutgoingApiMessage(payload, "API-exporterna kan inte läsas just nu."), response.status);
  }
  return exports;
}

export async function createSagaOutgoingApi(
  input: SagaOutgoingApiCreateInput,
  apiPath = "/api/saga/outgoing-apis",
): Promise<SagaOutgoingApiCreated> {
  const response = await fetch(apiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  const created = sagaOutgoingApiCreatedFromPayload(payload);
  if (!response.ok || !created) {
    throw new SagaOutgoingApiHttpError(sagaOutgoingApiMessage(payload, "API-exporten kunde inte skapas."), response.status);
  }
  return created;
}

export async function revokeSagaOutgoingApi(
  id: string,
  apiPath = "/api/saga/outgoing-apis",
): Promise<void> {
  const response = await fetch(`${apiPath}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SagaOutgoingApiHttpError(sagaOutgoingApiMessage(payload, "API-exporten kunde inte återkallas."), response.status);
  }
}

/** Rotating invalidates the prior bearer secret and returns the replacement exactly once. */
export async function rotateSagaOutgoingApi(
  id: string,
  apiPath = "/api/saga/outgoing-apis",
): Promise<SagaOutgoingApiCreated> {
  const response = await fetch(`${apiPath}/${encodeURIComponent(id)}/rotate`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  const created = sagaOutgoingApiCreatedFromPayload(payload);
  if (!response.ok || !created) {
    throw new SagaOutgoingApiHttpError(sagaOutgoingApiMessage(payload, "Nyckeln kunde inte roteras."), response.status);
  }
  return created;
}
