import { classifySourceUrl, hasSufficientVerification, SOURCE_ALLOWLIST, sourceDomain } from "@/lib/domain/source-policy";
import type { Source } from "@/lib/domain/types";

export const SOURCE_ROLES = ["discovery", "analysis", "verification", "citation", "direct_monitoring"] as const;
export const SOURCE_PRIORITIES = ["high", "normal", "low"] as const;
export const SOURCE_KINDS = ["primary", "editorial", "company", "creator", "podcast", "custom"] as const;

export type SourceRole = (typeof SOURCE_ROLES)[number];
export type SourcePriority = (typeof SOURCE_PRIORITIES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type SourceFrequency = "all_relevant" | "daily" | "weekly" | "material";
export type SourceVerificationRequirement = "none" | "verify_material" | "primary_only" | "two_independent";

export type SourcePolicyRecord = {
  domain: string;
  sourceName: string;
  sourceKind: SourceKind;
  active: boolean;
  blocked: boolean;
  priority: SourcePriority;
  roles: SourceRole[];
  topicFilter: string;
  verificationRequirement: SourceVerificationRequirement;
  frequency: SourceFrequency;
};

export type SourceCatalogEntry = {
  domain: string;
  name: string;
  kind: SourceKind;
  defaultRoles: SourceRole[];
};

export type SourcePolicyRunPurpose = "brief" | "watch";
export type SourcePolicySelection = {
  roles?: SourceRole | SourceRole[];
  purpose?: SourcePolicyRunPurpose;
  cadence?: "daily" | "weekly";
  now?: Date;
  timezone?: string;
  subject?: string;
};

export type SourceEvidenceEvaluation = {
  verificationSources: Source[];
  citationSources: Source[];
  verificationSatisfied: boolean;
  citationSatisfied: boolean;
  reasons: string[];
};

const primaryDomains = new Set([
  "regeringen.se", "riksbank.se", "scb.se", "fi.se", "msb.se", "digg.se",
  "europa.eu", "ec.europa.eu", "eur-lex.europa.eu", "consilium.europa.eu", "ecb.europa.eu",
  "esma.europa.eu", "edpb.europa.eu", "enisa.europa.eu", "echa.europa.eu",
  "whitehouse.gov", "congress.gov", "federalreserve.gov", "treasury.gov", "sec.gov",
  "commerce.gov", "bis.gov", "ofac.treasury.gov", "ustr.gov", "cisa.gov", "nist.gov",
  "centralbank.ae", "uaelegislation.gov.ae", "moec.gov.ae", "u.ae", "gcc-sg.org",
  "imf.org", "oecd.org", "wto.org", "bis.org", "worldbank.org",
]);

const companyDomains = new Set([
  "openai.com", "platform.openai.com", "anthropic.com", "aws.amazon.com", "azure.microsoft.com",
  "cloud.google.com", "microsoft.com", "nvidia.com", "amd.com", "intel.com", "oracle.com",
  "stripe.com", "adyen.com", "visa.com", "mastercard.com", "paypal.com",
]);

const displayNames: Record<string, string> = {
  "reuters.com": "Reuters",
  "apnews.com": "Associated Press",
  "ft.com": "Financial Times",
  "bloomberg.com": "Bloomberg",
  "wsj.com": "Wall Street Journal",
  "cnn.com": "CNN",
  "regeringen.se": "Regeringen",
  "riksbank.se": "Riksbanken",
  "ec.europa.eu": "Europeiska kommissionen",
  "federalreserve.gov": "Federal Reserve",
  "openai.com": "OpenAI",
  "platform.openai.com": "OpenAI Platform",
  "aws.amazon.com": "AWS",
  "cloud.google.com": "Google Cloud",
  "azure.microsoft.com": "Microsoft Azure",
  "nvidia.com": "NVIDIA",
  "stripe.com": "Stripe",
};

const ignoredTopicTerms = new Set([
  "och", "eller", "med", "för", "från", "till", "som", "den", "det", "att", "på", "av", "inom", "kring", "alla", "bara", "samt",
]);

export const SOURCE_CATALOG: SourceCatalogEntry[] = SOURCE_ALLOWLIST.map((domain) => ({
  domain,
  name: displayNames[domain] ?? domain,
  kind: primaryDomains.has(domain) ? "primary" : companyDomains.has(domain) ? "company" : "editorial",
  defaultRoles: primaryDomains.has(domain)
    ? ["discovery", "verification", "citation"]
    : companyDomains.has(domain)
      ? ["discovery", "verification", "citation"]
      : ["discovery", "verification", "citation"],
}));

export function normalizeSourceDomain(value: string): string | null {
  const candidate = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate) ? candidate : null;
}

/** A catalog source has an effective policy even if the user has not saved a row for it yet. */
export function defaultSourcePolicy(entry: SourceCatalogEntry): SourcePolicyRecord {
  return {
    domain: entry.domain,
    sourceName: entry.name,
    sourceKind: entry.kind,
    active: true,
    blocked: false,
    priority: "normal",
    roles: entry.defaultRoles,
    topicFilter: "",
    verificationRequirement: "verify_material",
    frequency: "material",
  };
}

/**
 * Apply a definition-scoped override without losing defaults from the global
 * policy. Null/undefined override fields deliberately mean "inherit".
 */
export function mergeSourcePolicies(
  basePolicies: SourcePolicyRecord[],
  overrides: Array<Partial<SourcePolicyRecord> & Pick<SourcePolicyRecord, "domain">>,
): SourcePolicyRecord[] {
  const baseByDomain = new Map<string, SourcePolicyRecord>();
  for (const entry of SOURCE_CATALOG) baseByDomain.set(entry.domain, defaultSourcePolicy(entry));
  for (const policy of basePolicies) baseByDomain.set(policy.domain.toLowerCase(), { ...policy, domain: policy.domain.toLowerCase() });

  for (const override of overrides) {
    const domain = override.domain.toLowerCase();
    const inherited = baseByDomain.get(domain) ?? {
      domain,
      sourceName: domain,
      sourceKind: "custom" as const,
      active: true,
      blocked: false,
      priority: "normal" as const,
      roles: ["discovery", "verification", "citation"] as SourceRole[],
      topicFilter: "",
      verificationRequirement: "verify_material" as const,
      frequency: "material" as const,
    };
    baseByDomain.set(domain, {
      ...inherited,
      ...definedOverrideFields(override),
      domain,
    });
  }

  return [...baseByDomain.values()].sort(comparePolicyPriority);
}

/**
 * Produces the actual web-search allowlist for one run. Policy roles are not
 * cosmetic: discovery and watch discovery can use different source sets, and
 * priority controls the order supplied to search and the model guidance.
 */
export function allowedDomainsForPolicy(policies: SourcePolicyRecord[], selection: SourcePolicySelection = {}): string[] {
  const roles = selectedRoles(selection.roles, ["discovery"]);
  const effective = effectivePolicyList(policies);
  return effective
    .filter((policy) => policyAllows(policy, roles, selection))
    .sort(comparePolicyPriority)
    .map((policy) => policy.domain)
    .slice(0, 100);
}

export function sourceAllowedByPolicy(
  url: string,
  policies: SourcePolicyRecord[],
  role: SourceRole | SourceRole[] = "citation",
  subject?: string,
  runSelection: Omit<SourcePolicySelection, "roles" | "subject"> = {},
): boolean {
  const domain = sourceDomain(url);
  if (!domain) return false;
  const policy = resolveSourcePolicy(domain, policies);
  const roles = selectedRoles(role, ["citation"]);
  return Boolean(policy && policyAllows(policy, roles, { ...runSelection, roles, subject }));
}

export function filterSourcesByPolicy(
  sources: Source[],
  policies: SourcePolicyRecord[],
  role: SourceRole | SourceRole[] = "citation",
  subject?: string,
  runSelection: Omit<SourcePolicySelection, "roles" | "subject"> = {},
): Source[] {
  return sources.filter((source) => sourceAllowedByPolicy(source.url, policies, role, subject, runSelection));
}

/**
 * Evidence and citations deliberately have separate roles. A verification-only
 * source can prove an event without appearing in the user-facing chain, while
 * a citation-only source can be shown but never satisfy the publication gate.
 */
export function evaluateSourceEvidence(
  sources: Source[],
  policies: SourcePolicyRecord[],
  subject: string,
  runSelection: Omit<SourcePolicySelection, "roles" | "subject"> = {},
): SourceEvidenceEvaluation {
  const verificationSources = filterSourcesByPolicy(sources, policies, "verification", subject, runSelection)
    .filter((source) => resolveSourcePolicy(sourceDomain(source.url) ?? "", policies)?.verificationRequirement !== "none");
  // Stored event sources must both be valid evidence and permitted citations.
  // This is intentionally conservative until source provenance gets a separate
  // evidence table; a citation-only URL cannot smuggle itself into verification.
  const citationSources = filterSourcesByPolicy(verificationSources, policies, "citation", subject, runSelection);
  const evidencePolicies = verificationSources
    .map((source) => resolveSourcePolicy(sourceDomain(source.url) ?? "", policies))
    .filter((policy): policy is SourcePolicyRecord => Boolean(policy));
  const reasons: string[] = [];
  const baseSatisfied = hasSufficientVerification(verificationSources);
  if (!baseSatisfied) reasons.push("Saknar primärkälla eller två oberoende sekundärkällor som får användas för verifiering.");

  const primaryCount = verificationSources.filter((source) => classifySourceUrl(source.url) === "primary").length;
  const independentPublisherCount = new Set(verificationSources.map((source) => publisherDomain(source.url)).filter(Boolean)).size;
  const requiresPrimary = evidencePolicies.some((policy) => policy.verificationRequirement === "primary_only");
  const requiresIndependent = evidencePolicies.some((policy) => policy.verificationRequirement === "two_independent");
  const onlyLowPriority = evidencePolicies.length > 0 && evidencePolicies.every((policy) => policy.priority === "low");

  if (requiresPrimary && primaryCount === 0) reasons.push("Minst en vald källa kräver primärkälla för verifiering.");
  if (requiresIndependent && independentPublisherCount < 2) reasons.push("Minst en vald källa kräver två oberoende publicister.");
  if (onlyLowPriority && independentPublisherCount < 2) reasons.push("Ensam lågprioriterad källa får inte ensam verifiera en publicerad händelse.");
  if (!citationSources.length) reasons.push("Ingen källa är tillåten för citering i denna brief.");

  return {
    verificationSources,
    citationSources,
    verificationSatisfied: baseSatisfied && (!requiresPrimary || primaryCount > 0) && (!requiresIndependent || independentPublisherCount >= 2) && (!onlyLowPriority || independentPublisherCount >= 2),
    citationSatisfied: citationSources.length > 0,
    reasons,
  };
}

/** Concise, deterministic context that makes priority/topic/frequency visible to model stages. */
export function sourcePolicyPromptContext(policies: SourcePolicyRecord[], selection: SourcePolicySelection = {}): string {
  const roles = selectedRoles(selection.roles, ["discovery"]);
  const rows = effectivePolicyList(policies)
    .filter((policy) => policyAllows(policy, roles, selection))
    .sort(comparePolicyPriority)
    .slice(0, 100)
    .map((policy) => ({
      domain: policy.domain,
      priority: policy.priority,
      roles: policy.roles,
      topicFilter: policy.topicFilter || null,
      frequency: policy.frequency,
      verificationRequirement: policy.verificationRequirement,
    }));
  return JSON.stringify(rows);
}

export function sourceMatchesTopicFilter(policy: SourcePolicyRecord, subject?: string): boolean {
  if (!policy.topicFilter.trim() || !subject) return true;
  const terms = tokenizeTopic(policy.topicFilter);
  if (!terms.length) return true;
  const haystack = subject.toLocaleLowerCase("sv-SE");
  return terms.some((term) => haystack.includes(term));
}

export function isSourceFrequencyDue(
  policy: SourcePolicyRecord,
  selection: Pick<SourcePolicySelection, "purpose" | "cadence" | "now" | "timezone"> = {},
): boolean {
  // Rendering a historic source chain is not a new source run. Frequency only
  // controls acquisition when a caller explicitly supplies a run purpose.
  if (!selection.purpose) return true;
  const purpose = selection.purpose ?? "brief";
  if (policy.frequency === "all_relevant" || policy.frequency === "material") return true;
  if (policy.frequency === "daily") return purpose === "brief";
  if (purpose !== "brief") return false;
  if (selection.cadence === "weekly") return true;
  const now = selection.now ?? new Date();
  const weekday = localWeekday(now, selection.timezone ?? "Europe/Stockholm");
  return weekday === 1;
}

export function resolveSourcePolicy(domain: string, policies: SourcePolicyRecord[]): SourcePolicyRecord | null {
  const normalized = normalizeSourceDomain(domain) ?? domain.replace(/^www\./, "").toLowerCase();
  const matchingExplicit = policies
    .filter((policy) => normalized === policy.domain || normalized.endsWith(`.${policy.domain}`))
    .sort((left, right) => right.domain.length - left.domain.length)[0];
  if (matchingExplicit) return matchingExplicit;
  const catalog = SOURCE_CATALOG
    .filter((entry) => normalized === entry.domain || normalized.endsWith(`.${entry.domain}`))
    .sort((left, right) => right.domain.length - left.domain.length)[0];
  return catalog ? defaultSourcePolicy(catalog) : null;
}

function effectivePolicyList(policies: SourcePolicyRecord[]): SourcePolicyRecord[] {
  return mergeSourcePolicies(policies, []);
}

function policyAllows(policy: SourcePolicyRecord, roles: SourceRole[], selection: SourcePolicySelection): boolean {
  if (!policy.active || policy.blocked) return false;
  if (!policy.roles.some((role) => roles.includes(role))) return false;
  if (!isSourceFrequencyDue(policy, selection)) return false;
  return sourceMatchesTopicFilter(policy, selection.subject);
}

function selectedRoles(value: SourcePolicySelection["roles"], fallback: SourceRole[]): SourceRole[] {
  if (!value) return fallback;
  return Array.isArray(value) ? value : [value];
}

function definedOverrideFields(override: Partial<SourcePolicyRecord>): Partial<SourcePolicyRecord> {
  return Object.fromEntries(Object.entries(override).filter(([, value]) => value !== null && value !== undefined)) as Partial<SourcePolicyRecord>;
}

function comparePolicyPriority(left: SourcePolicyRecord, right: SourcePolicyRecord): number {
  const rank: Record<SourcePriority, number> = { high: 0, normal: 1, low: 2 };
  return rank[left.priority] - rank[right.priority] || left.sourceName.localeCompare(right.sourceName, "sv");
}

function publisherDomain(url: string): string | null {
  return sourceDomain(url);
}

function tokenizeTopic(value: string): string[] {
  return value
    .toLocaleLowerCase("sv-SE")
    .match(/[\p{L}\p{N}]{3,}/gu)
    ?.filter((term) => !ignoredTopicTerms.has(term)) ?? [];
}

function localWeekday(now: Date, timezone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short" }).format(now);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[weekday] ?? 0;
}
