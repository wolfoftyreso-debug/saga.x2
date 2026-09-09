import { z } from "zod";

/**
 * A private, self-described persona record. This is deliberately separate
 * from both editorial context and avatar photo references: no field is
 * inferred, and nothing in this record is public or model-enabled by default.
 */

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => boundedText(max).nullable().optional();
const listItem = boundedText(120);

export const SAGA_PERSONA_STANCE_MODES = ["not_specified", "neutral", "self_described"] as const;
export type SagaPersonaStanceMode = (typeof SAGA_PERSONA_STANCE_MODES)[number];
export const SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION = "saga_persona_sensitive_storage_v1" as const;

export const sagaPersonaStanceSchema = z.object({
  mode: z.enum(SAGA_PERSONA_STANCE_MODES).default("not_specified"),
  description: optionalText(800),
}).strict().superRefine((value, context) => {
  if (value.mode === "self_described" && !value.description) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["description"],
      message: "En egen beskrivning kräver en kort, frivillig beskrivning.",
    });
  }
  if (value.mode !== "self_described" && value.description) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["description"],
      message: "Beskrivning får bara sparas när du uttryckligen har valt egen beskrivning.",
    });
  }
});
export type SagaPersonaStance = z.infer<typeof sagaPersonaStanceSchema>;

/**
 * A receipt is deliberately per sensitive save, never an implied workspace
 * setting. The server records its own timestamp and binds it to a revision.
 */
export const sagaPersonaSensitiveStorageConsentSchema = z.object({
  accepted: z.literal(true),
  version: z.literal(SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION),
}).strict();
export type SagaPersonaSensitiveStorageConsent = z.infer<typeof sagaPersonaSensitiveStorageConsentSchema>;

export const sagaPersonaOrganizationSchema = z.object({
  name: boundedText(160),
  role: optionalText(160),
}).strict();
export type SagaPersonaOrganization = z.infer<typeof sagaPersonaOrganizationSchema>;

/**
 * Homepages are display-only. We intentionally accept only a canonical HTTPS
 * origin so this field cannot become a fetch target, credential carrier, or a
 * hidden query-string store.
 */
export const sagaPersonaWebsiteSchema = z.object({
  label: boundedText(120),
  url: z.string().trim().min(1).max(2_048),
}).strict().transform((value, context) => {
  const normalized = normalizeSagaPersonaHomepage(value.url);
  if (!normalized) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "Ange en publik HTTPS-hemsida utan inloggning, IP-adress, sökväg eller spårningsparametrar.",
    });
    return z.NEVER;
  }
  return { ...value, url: normalized };
});
export type SagaPersonaWebsite = z.infer<typeof sagaPersonaWebsiteSchema>;

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLocaleLowerCase("sv-SE"))).size === values.length;
}

function uniqueOrganizations(values: readonly SagaPersonaOrganization[]): boolean {
  return new Set(values.map((value) => value.name.toLocaleLowerCase("sv-SE"))).size === values.length;
}

function uniqueWebsites(values: readonly SagaPersonaWebsite[]): boolean {
  return new Set(values.map((value) => value.url)).size === values.length;
}

const listSchema = (max: number) => z.array(listItem).max(max).superRefine((value, context) => {
  if (!uniqueStrings(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Samma värde får bara anges en gång." });
  }
});

/**
 * PUT is a full replacement of one private persona record. Every field is
 * optional at the boundary because all self-description is voluntary; the
 * normalizer below turns omissions into an explicit empty/private value.
 */
export const sagaPersonaContextInputSchema = z.object({
  selfDescription: optionalText(2_000),
  heightCm: z.number().int().min(80).max(250).nullable().optional(),
  clothing: listSchema(12).optional(),
  environments: listSchema(12).optional(),
  visualCountries: listSchema(12).optional(),
  interests: listSchema(20).optional(),
  workSummary: optionalText(2_000),
  roles: listSchema(12).optional(),
  organizations: z.array(sagaPersonaOrganizationSchema).max(12).optional().superRefine((value, context) => {
    if (value && !uniqueOrganizations(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "En verksamhet får bara anges en gång." });
    }
  }),
  websites: z.array(sagaPersonaWebsiteSchema).max(12).optional().superRefine((value, context) => {
    if (value && !uniqueWebsites(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "En hemsida får bara anges en gång." });
    }
  }),
  political: sagaPersonaStanceSchema.optional(),
  religion: sagaPersonaStanceSchema.optional(),
  origin: optionalText(800),
  birthCountry: optionalText(120),
  /**
   * This is a future-facing, narrowly scoped consent. It is false by default
   * and has no current model integration or publication effect.
   */
  visualContextConsent: z.boolean().optional(),
  /** Required only when voluntarily saving political, religious, origin or birth-country context. */
  sensitiveDataStorageConsent: sagaPersonaSensitiveStorageConsentSchema.optional(),
  /** Optional optimistic-concurrency guard for a future multi-tab UI. */
  expectedRevision: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict().superRefine((value, context) => {
  const hasSensitiveData = hasSagaPersonaSensitiveData(value);
  if (hasSensitiveData && !value.sensitiveDataStorageConsent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sensitiveDataStorageConsent"],
      message: "Bekräfta privat lagring innan känsliga identitetsuppgifter sparas.",
    });
  }
  if (!hasSensitiveData && value.sensitiveDataStorageConsent) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sensitiveDataStorageConsent"],
      message: "Bekräftelse får bara skickas tillsammans med känsliga identitetsuppgifter.",
    });
  }
});
export type SagaPersonaContextInput = z.infer<typeof sagaPersonaContextInputSchema>;

export type SagaPersonaContextValue = {
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
  political: SagaPersonaStance;
  religion: SagaPersonaStance;
  origin: string | null;
  birthCountry: string | null;
  visualContextConsent: boolean;
};

/** Exact persisted value shape. Unlike the voluntary request shape, no field may be omitted. */
export const sagaPersonaContextValueSchema = z.object({
  selfDescription: boundedText(2_000).nullable(),
  heightCm: z.number().int().min(80).max(250).nullable(),
  clothing: listSchema(12),
  environments: listSchema(12),
  visualCountries: listSchema(12),
  interests: listSchema(20),
  workSummary: boundedText(2_000).nullable(),
  roles: listSchema(12),
  organizations: z.array(sagaPersonaOrganizationSchema).max(12).superRefine((value, context) => {
    if (!uniqueOrganizations(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "En verksamhet får bara anges en gång." });
    }
  }),
  websites: z.array(sagaPersonaWebsiteSchema).max(12).superRefine((value, context) => {
    if (!uniqueWebsites(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "En hemsida får bara anges en gång." });
    }
  }),
  political: sagaPersonaStanceSchema,
  religion: sagaPersonaStanceSchema,
  origin: boundedText(800).nullable(),
  birthCountry: boundedText(120).nullable(),
  visualContextConsent: z.boolean(),
}).strict();

export type SagaPersonaContextView = SagaPersonaContextValue & {
  revision: number;
  createdAt: string;
  updatedAt: string;
  modelUse: {
    /** Consent exists, but no worker is wired to consume this yet. */
    visualContextConsent: boolean;
    activeIntegration: false;
  };
};

/**
 * The only context a future private visual worker may ask for. Deliberately
 * excludes height, biography, work, links, politics, religion, origin and
 * country of birth even when the owner has stored them.
 */
export type SagaPersonaPrivateVisualContext = {
  source: "self_described";
  clothing: string[];
  environments: string[];
  visualCountries: string[];
};

export const sagaPersonaPrivateVisualContextSchema = z.object({
  source: z.literal("self_described"),
  clothing: listSchema(12),
  environments: listSchema(12),
  visualCountries: listSchema(12),
}).strict();

export const SAGA_PERSONA_CONTEXT_API_CONTRACT = {
  read: { method: "GET", path: "/api/saga/persona-context", response: "{ context: SagaPersonaContextView | null }" },
  replace: { method: "PUT", path: "/api/saga/persona-context", body: "SagaPersonaContextInput", response: "{ context: SagaPersonaContextView }" },
  remove: { method: "DELETE", path: "/api/saga/persona-context", response: "{ deleted: boolean }" },
} as const;

export function emptySagaPersonaContextValue(): SagaPersonaContextValue {
  return {
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
    political: { mode: "not_specified", description: null },
    religion: { mode: "not_specified", description: null },
    origin: null,
    birthCountry: null,
    visualContextConsent: false,
  };
}

/** Converts the voluntary API shape into one explicit, bounded private value. */
export function normalizeSagaPersonaContext(input: SagaPersonaContextInput): SagaPersonaContextValue {
  const parsed = sagaPersonaContextInputSchema.parse(input);
  const empty = emptySagaPersonaContextValue();
  return {
    selfDescription: parsed.selfDescription ?? empty.selfDescription,
    heightCm: parsed.heightCm ?? empty.heightCm,
    clothing: parsed.clothing ?? empty.clothing,
    environments: parsed.environments ?? empty.environments,
    visualCountries: parsed.visualCountries ?? empty.visualCountries,
    interests: parsed.interests ?? empty.interests,
    workSummary: parsed.workSummary ?? empty.workSummary,
    roles: parsed.roles ?? empty.roles,
    organizations: parsed.organizations ?? empty.organizations,
    websites: parsed.websites ?? empty.websites,
    political: normalizeStance(parsed.political ?? empty.political),
    religion: normalizeStance(parsed.religion ?? empty.religion),
    origin: parsed.origin ?? empty.origin,
    birthCountry: parsed.birthCountry ?? empty.birthCountry,
    visualContextConsent: parsed.visualContextConsent ?? false,
  };
}

/**
 * Neutral is still a voluntarily stated political/religious position, so it
 * receives the same storage acknowledgement as a free-text description.
 */
export function hasSagaPersonaSensitiveData(input: Pick<SagaPersonaContextInput, "political" | "religion" | "origin" | "birthCountry">): boolean {
  return input.political?.mode !== undefined && input.political.mode !== "not_specified"
    || input.religion?.mode !== undefined && input.religion.mode !== "not_specified"
    || input.origin !== undefined && input.origin !== null
    || input.birthCountry !== undefined && input.birthCountry !== null;
}

function normalizeStance(value: SagaPersonaStance): SagaPersonaStance {
  return value.mode === "self_described"
    ? { mode: "self_described", description: value.description ?? null }
    : { mode: value.mode, description: null };
}

/**
 * Canonical, display-only public homepage validation. The app deliberately
 * never fetches these URLs; validation alone must not become SSRF.
 */
export function normalizeSagaPersonaHomepage(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.port && parsed.port !== "443") return null;
  if (parsed.pathname !== "/") return null;
  const hostname = parsed.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  if (!isPublicHostname(hostname)) return null;
  return `https://${hostname}/`;
}

function isPublicHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  if (hostname === "metadata.google.internal" || hostname.endsWith(".localdomain")) return false;
  if (hostname.includes(":")) return false; // all literal IPv6 values, including loopback
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) return false;
  return true;
}
