import { z } from "zod";

/**
 * Runtime contracts for the research pipeline.  These intentionally live
 * beside the tenant/configuration model: a source connection is configuration,
 * while evidence, a run and a handoff are execution records.
 */
export const mediaResearchRunStateSchema = z.enum(["queued", "running", "completed", "failed"]);
export const mediaResearchClusterStatusSchema = z.enum([
  "pending",
  "researching",
  "ready",
  "dismissed",
  "published",
]);
export const mediaResearchDossierStatusSchema = z.enum(["draft", "ready", "failed"]);
export const mediaContentHandoffStateSchema = z.enum([
  "queued",
  "drafted",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "failed",
]);

export const mediaEngineCheckInputSchema = z.object({
  tenantId: z.string().uuid(),
  ruleId: z.string().uuid().optional(),
  /** Required so a retry cannot discover/create a second content proposal. */
  idempotencyKey: z.string().uuid(),
});

export const mediaEngineClusterResearchInputSchema = z.object({
  tenantId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});

export const mediaEngineClusterActionSchema = z.object({
  tenantId: z.string().uuid(),
  action: z.enum(["dismiss", "restore"]),
});

export const mediaEngineHandoffActionSchema = z.object({
  tenantId: z.string().uuid(),
  action: z.enum(["reject", "queue_draft"]),
});

export const mediaEngineHandoffDraftInputSchema = z.object({
  tenantId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
});

export const mediaResearchCandidateSchema = z.object({
  externalId: z.string().trim().min(1).max(512).optional(),
  canonicalUrl: z.string().url().max(2_000),
  title: z.string().trim().min(3).max(500),
  summary: z.string().trim().max(8_000).default(""),
  /** The model's conservative topic key; server normalises it again. */
  clusterKey: z.string().trim().min(3).max(280),
  sourceName: z.string().trim().min(2).max(240),
  sourceType: z.enum(["primary", "secondary", "rss", "api", "web_search"]).default("web_search"),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  eventDate: z.string().datetime({ offset: true }).nullable(),
  supportsClaim: z.string().trim().min(8).max(2_000),
});

export const mediaResearchEvidenceSchema = z.object({
  sourceName: z.string().trim().min(2).max(240),
  sourceUrl: z.string().url().max(2_000),
  sourceDomain: z.string().trim().min(1).max(255),
  sourceType: z.enum(["primary", "secondary", "rss", "api", "web_search"]),
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  eventDate: z.string().datetime({ offset: true }).nullable(),
  claim: z.string().trim().min(8).max(2_000),
  /** `supports`, `conflicts` and `context` make disagreement visible. */
  stance: z.enum(["supports", "conflicts", "context"]),
  quote: z.string().trim().max(2_000).nullable(),
  confidence: z.number().int().min(0).max(100),
});

export const mediaResearchReflectionSchema = z.object({
  whatWeKnow: z.array(z.string().trim().min(8).max(800)).max(8),
  whatWeDontKnow: z.array(z.string().trim().min(8).max(800)).max(8),
  whyItMatters: z.string().trim().min(12).max(1_500),
  suggestedAngle: z.string().trim().min(8).max(900),
  reflection: z.string().trim().min(20).max(5_000),
  uncertainties: z.array(z.string().trim().min(8).max(800)).max(8),
  conflicts: z.array(z.string().trim().min(8).max(800)).max(8),
  imageBrief: z.string().trim().max(1_500),
});

export type MediaResearchCandidate = z.infer<typeof mediaResearchCandidateSchema>;
export type MediaResearchEvidence = z.infer<typeof mediaResearchEvidenceSchema>;
export type MediaResearchReflection = z.infer<typeof mediaResearchReflectionSchema>;
export type MediaEngineCheckInput = z.infer<typeof mediaEngineCheckInputSchema>;

/**
 * This makes the "multiple mentions" trigger factual. Raw article count is
 * never used as a substitute for independent reporting: syndicated URLs from
 * the same publisher count once.
 */
/**
 * Keeps a complete host for rule allow/deny lists. This must stay separate
 * from independent-publisher grouping: `ec.europa.eu` is a meaningful source
 * constraint, while its registrable publisher domain is `europa.eu`.
 */
export function normalizeSourceHostname(value: string): string | null {
  const input = value.trim();
  if (!input) return null;
  try {
    const url = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/^www\./, "").replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/**
 * A deliberately small public-suffix heuristic for source independence. It
 * groups ordinary subdomains under one publisher (`uk.publisher.com` and
 * `publisher.com`) without treating common country compound suffixes such as
 * `co.uk` or `com.au` as publishers. A production PSL can replace this list
 * later without changing the data contract.
 */
const COMMON_MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "nhs.uk", "org.uk", "plc.uk", "sch.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "id.au", "net.au", "org.au",
  "ac.nz", "co.nz", "geek.nz", "govt.nz", "kiwi.nz", "net.nz", "org.nz",
  "ac.jp", "co.jp", "ed.jp", "go.jp", "gr.jp", "lg.jp", "ne.jp", "or.jp",
  "com.br", "edu.br", "gov.br", "net.br", "org.br",
  "com.cn", "edu.cn", "gov.cn", "net.cn", "org.cn",
  "com.hk", "edu.hk", "gov.hk", "net.hk", "org.hk",
  "com.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "ac.il", "co.il", "gov.il", "net.il", "org.il",
  "com.kr", "co.kr", "go.kr", "ne.kr", "or.kr",
  "com.mx", "com.my", "com.ph", "com.pk", "com.pl", "com.sg", "com.tr", "com.tw", "com.ua", "com.ar", "co.za", "net.za", "org.za",
]);

// Shared-hosting domains have their own registrants below the suffix. The
// small list keeps two unrelated hosted publishers from being treated as one;
// unlisted suffixes deliberately collapse conservatively (less noisy) until a
// full PSL dependency is justified.
const COMMON_PRIVATE_SUFFIXES = new Set([
  "appspot.com", "azurewebsites.net", "blogspot.com", "cloudfront.net", "firebaseapp.com", "github.io", "gitlab.io",
  "herokuapp.com", "netlify.app", "notion.site", "pages.dev", "substack.com", "vercel.app", "web.app", "wordpress.com",
]);

function isIpLiteral(host: string): boolean {
  if (host.includes(":")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function normalizeIndependentDomain(value: string): string | null {
  const host = normalizeSourceHostname(value);
  if (!host || isIpLiteral(host)) return host;
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return host;
  const publicSuffix = labels.slice(-2).join(".");
  if ((COMMON_MULTI_LABEL_PUBLIC_SUFFIXES.has(publicSuffix) || COMMON_PRIVATE_SUFFIXES.has(publicSuffix)) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

export function countIndependentDomains(evidence: Array<Pick<MediaResearchEvidence, "sourceDomain"> | { canonicalUrl: string }>): number {
  const domains = new Set<string>();
  for (const entry of evidence) {
    const candidate = "sourceDomain" in entry ? entry.sourceDomain : entry.canonicalUrl;
    const domain = normalizeIndependentDomain(candidate);
    if (domain) domains.add(domain);
  }
  return domains.size;
}

export function canonicalResearchKey(value: string): string {
  const normalized = value
    .toLocaleLowerCase("sv-SE")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 280);
  // A stable FNV-style identifier is enough here; it is a grouping hint, not
  // a security boundary or database primary key. Keeping it browser-safe also
  // lets the UI show the same key without pulling Node's crypto module.
  let hash = 2166136261;
  for (let index = 0; index < (normalized || "untitled").length; index += 1) {
    hash ^= (normalized || "untitled").charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `topic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function clusterMeetsThreshold(input: {
  mentionCount: number;
  evidence: Array<Pick<MediaResearchEvidence, "sourceDomain"> | { canonicalUrl: string }>;
  minMentions: number;
  minUniqueDomains: number;
}): boolean {
  return input.mentionCount >= Math.max(1, input.minMentions)
    && countIndependentDomains(input.evidence) >= Math.max(1, input.minUniqueDomains);
}

/** The public copy must make the safety boundary unambiguous. */
export function neverPublishHandoffMessage(): string {
  return "Researchmotorn har bara skapat ett privat utkastunderlag. Inget är publicerat eller schemalagt förrän en redaktör väljer det i Studio.";
}
