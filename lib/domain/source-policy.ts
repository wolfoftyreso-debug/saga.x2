import type { Source } from "@/lib/domain/types";

export const PRIMARY_SOURCE_DOMAINS = [
  "regeringen.se", "riksbank.se", "scb.se", "fi.se", "msb.se", "digg.se",
  "europa.eu", "ec.europa.eu", "eur-lex.europa.eu", "consilium.europa.eu", "ecb.europa.eu",
  "esma.europa.eu", "edpb.europa.eu", "enisa.europa.eu", "echa.europa.eu",
  "whitehouse.gov", "congress.gov", "federalreserve.gov", "treasury.gov", "sec.gov",
  "commerce.gov", "bis.gov", "ofac.treasury.gov", "ustr.gov", "cisa.gov", "nist.gov",
  "centralbank.ae", "uaelegislation.gov.ae", "moec.gov.ae", "u.ae", "gcc-sg.org",
  "imf.org", "oecd.org", "wto.org", "bis.org", "worldbank.org",
  "openai.com", "platform.openai.com", "anthropic.com", "aws.amazon.com", "azure.microsoft.com",
  "cloud.google.com", "microsoft.com", "nvidia.com", "amd.com", "intel.com", "oracle.com",
  "stripe.com", "adyen.com", "visa.com", "mastercard.com", "paypal.com",
] as const;

export const SECONDARY_SOURCE_DOMAINS = [
  "reuters.com",
  "apnews.com",
  "ft.com",
  "bloomberg.com",
  "wsj.com",
  "nytimes.com",
  "theinformation.com",
  "techcrunch.com",
  "cnn.com",
  "svd.se",
  "di.se",
  "dn.se",
] as const;

export const SOURCE_ALLOWLIST = [...PRIMARY_SOURCE_DOMAINS, ...SECONDARY_SOURCE_DOMAINS];

export function hasSufficientVerification(sources: Source[]): boolean {
  if (sources.some((source) => classifySourceUrl(source.url) === "primary")) return true;
  const independentSecondaryPublishers = new Set(sources.filter((source) => classifySourceUrl(source.url) === "secondary").map((source) => publisherKey(source.url)));
  return independentSecondaryPublishers.size >= 2;
}

/** Source type is determined by the publisher domain, never solely by a model label. */
export function normalizePublicationSources(sources: Source[]): Source[] | null {
  const normalized = sources.flatMap((source) => {
    const sourceType = classifySourceUrl(source.url);
    return sourceType ? [{ ...source, sourceType }] : [];
  });
  return normalized.length === sources.length ? normalized : null;
}

export function classifySourceUrl(value: string): Source["sourceType"] | null {
  const hostname = hostnameOf(value);
  if (!hostname) return null;
  if (matchesDomain(hostname, PRIMARY_SOURCE_DOMAINS)) return "primary";
  if (matchesDomain(hostname, SECONDARY_SOURCE_DOMAINS)) return "secondary";
  return null;
}

export function sourceDomain(value: string): string | null {
  return hostnameOf(value);
}

export function validateSourceDates(source: Source): boolean {
  if (!source.eventDate || !source.publishedAt) return true;
  return source.eventDate <= source.publishedAt;
}

function hostnameOf(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function matchesDomain(hostname: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function publisherKey(value: string): string {
  return hostnameOf(value) ?? "";
}
