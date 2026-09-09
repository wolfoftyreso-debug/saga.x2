/**
 * Browser-safe contract for the private SAGA persona context. This module is
 * deliberately a narrow adapter: it never receives a workspace or user id,
 * never stores a local fallback, and never opens a supplied website.
 */

export type SagaPersonaIdentityMode = "not_specified" | "neutral" | "self_described";

export type SagaPersonaIdentity = {
  mode: SagaPersonaIdentityMode;
  description?: string;
};

export type SagaPersonaOrganization = {
  name: string;
  role?: string;
};

export type SagaPersonaWebsite = {
  label: string;
  url: string;
};

export const SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION = "saga_persona_sensitive_storage_v1" as const;

export type SagaPersonaSensitiveDataStorageConsent = {
  accepted: true;
  version: typeof SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION;
};

export type SagaPersonaContextInput = {
  selfDescription: string | null;
  heightCm: number | null;
  clothing: string[];
  environments: string[];
  visualCountries: string[];
  interests: string[];
  workSummary: string | null;
  roles: string[];
  organizations: SagaPersonaOrganization[];
  websites: SagaPersonaWebsite[];
  political: SagaPersonaIdentity;
  religion: SagaPersonaIdentity;
  origin: string | null;
  birthCountry: string | null;
  visualContextConsent: boolean;
  /**
   * Deliberately write-only. The server stores a per-revision receipt and
   * never sends it back to the browser/model/publication context.
   */
  sensitiveDataStorageConsent?: SagaPersonaSensitiveDataStorageConsent;
};

export type SagaPersonaContextView = Omit<SagaPersonaContextInput, "sensitiveDataStorageConsent"> & {
  modelUse: {
    visualContextConsent: boolean;
    activeIntegration: boolean;
  };
};

export type PersonaContextApiResult = {
  context: SagaPersonaContextView | null;
};

type UnknownRecord = Record<string, unknown>;

export class SagaPersonaContextHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SagaPersonaContextHttpError";
    this.status = status;
  }
}

export const emptySagaPersonaContextInput = (): SagaPersonaContextInput => ({
  selfDescription: null,
  heightCm: null,
  clothing: [],
  environments: [],
  visualCountries: [],
  interests: [],
  workSummary: null,
  roles: [],
  organizations: [],
  websites: [],
  political: { mode: "not_specified" },
  religion: { mode: "not_specified" },
  origin: null,
  birthCountry: null,
  visualContextConsent: false,
});

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = text(item);
    return normalized ? [normalized] : [];
  });
}

function identityFromPayload(value: unknown): SagaPersonaIdentity {
  if (!isRecord(value)) return { mode: "not_specified" };
  const mode = value.mode;
  if (mode !== "neutral" && mode !== "self_described" && mode !== "not_specified") return { mode: "not_specified" };
  const description = mode === "self_described" ? text(value.description) ?? undefined : undefined;
  return description ? { mode, description } : { mode };
}

function organizationsFromPayload(value: unknown): SagaPersonaOrganization[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const name = text(item.name);
    if (!name) return [];
    const role = text(item.role) ?? undefined;
    return [{ name, ...(role ? { role } : {}) }];
  });
}

function websitesFromPayload(value: unknown): SagaPersonaWebsite[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const label = text(item.label);
    const url = text(item.url);
    if (!label || !url) return [];
    return [{ label, url }];
  });
}

function heightFromPayload(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 80 && value <= 250 ? value : null;
}

function modelUseFromPayload(value: unknown, consent: boolean): SagaPersonaContextView["modelUse"] {
  if (!isRecord(value)) return { visualContextConsent: consent, activeIntegration: false };
  return {
    visualContextConsent: value.visualContextConsent === true,
    activeIntegration: value.activeIntegration === true,
  };
}

/** A safe UI projection. Raw avatar assets, ids and extra response fields are discarded. */
export function sagaPersonaContextFromPayload(payload: unknown): PersonaContextApiResult | null {
  if (!isRecord(payload) || (payload.context !== null && !isRecord(payload.context))) return null;
  if (payload.context === null) return { context: null };

  const context = payload.context;
  const visualContextConsent = context.visualContextConsent === true;
  return {
    context: {
      selfDescription: text(context.selfDescription),
      heightCm: heightFromPayload(context.heightCm),
      clothing: textList(context.clothing),
      environments: textList(context.environments),
      visualCountries: textList(context.visualCountries),
      interests: textList(context.interests),
      workSummary: text(context.workSummary),
      roles: textList(context.roles),
      organizations: organizationsFromPayload(context.organizations),
      websites: websitesFromPayload(context.websites),
      political: identityFromPayload(context.political),
      religion: identityFromPayload(context.religion),
      origin: text(context.origin),
      birthCountry: text(context.birthCountry),
      visualContextConsent,
      modelUse: modelUseFromPayload(context.modelUse, visualContextConsent),
    },
  };
}

export function sagaPersonaContextMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const code = text(payload.code);
  if (code === "configuration_required" || code === "configuration_missing" || code === "database_configuration_invalid") {
    return "Närvaroprofilen kan sparas när Neon-anslutningen är redo i Vercel.";
  }
  return text(payload.error) ?? fallback;
}

function isForbiddenWebsiteHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const looksLikeIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  return !host.includes(".")
    || host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || looksLikeIpv4
    || host.includes(":")
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

/**
 * A stored website is just a text reference. We canonicalize it without
 * fetching it and reject local/private addresses, credentials and deep links.
 */
export function canonicalSagaPersonaWebsite(value: string): string | null {
  const candidate = value.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || (url.port && url.port !== "443")
      || url.pathname !== "/"
      || url.search
      || url.hash
      || isForbiddenWebsiteHost(url.hostname)
    ) return null;
    return `https://${url.hostname.toLowerCase().replace(/\.$/, "")}/`;
  } catch {
    return null;
  }
}

export async function getSagaPersonaContext(apiPath = "/api/saga/persona-context", signal?: AbortSignal): Promise<PersonaContextApiResult> {
  const response = await fetch(apiPath, {
    credentials: "same-origin",
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsed = sagaPersonaContextFromPayload(payload);
  if (!response.ok || !parsed) {
    throw new SagaPersonaContextHttpError(sagaPersonaContextMessage(payload, "Närvaroprofilen kan inte läsas just nu."), response.status);
  }
  return parsed;
}

export async function putSagaPersonaContext(input: SagaPersonaContextInput, apiPath = "/api/saga/persona-context"): Promise<SagaPersonaContextView> {
  const response = await fetch(apiPath, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  const parsed = sagaPersonaContextFromPayload(payload);
  if (!response.ok || !parsed || !parsed.context) {
    throw new SagaPersonaContextHttpError(sagaPersonaContextMessage(payload, "Närvaroprofilen kunde inte sparas."), response.status);
  }
  return parsed.context;
}

/** Deletes the private root row and all immutable revisions; there is no client-side fallback. */
export async function deleteSagaPersonaContext(apiPath = "/api/saga/persona-context"): Promise<boolean> {
  const response = await fetch(apiPath, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || typeof payload.deleted !== "boolean") {
    throw new SagaPersonaContextHttpError(sagaPersonaContextMessage(payload, "Närvaroprofilen kunde inte tas bort."), response.status);
  }
  return payload.deleted;
}
