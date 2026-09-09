import "server-only";
import { socialProviderSchema, type SocialProvider } from "@/lib/domain/social";
import { getSocialTokenEncryptionKey, SocialEncryptionConfigurationError } from "@/lib/services/social-crypto";

export type MetaProviderConfig = {
  provider: "facebook_page" | "instagram_professional";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  graphApiVersion: string;
  graphBaseUrl: string;
  instagramGraphBaseUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
};

export type LinkedInProviderConfig = {
  provider: "linkedin";
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  apiVersion: string;
  scopes: string[];
};

export type SocialOAuthProviderConfig = MetaProviderConfig | LinkedInProviderConfig;

export class SocialProviderConfigurationError extends Error {
  readonly code = "configuration_required" as const;
  constructor(readonly provider: SocialProvider, readonly missing: string[]) {
    super(`Kopplingen för ${provider} är inte konfigurerad: ${missing.join(", ")}.`);
    this.name = "SocialProviderConfigurationError";
  }
}

function environmentValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/** A configured public root makes OAuth callback URLs deterministic and trusted. */
export function getSocialOAuthBaseUrl(raw = process.env.SOCIAL_OAUTH_BASE_URL): string {
  if (!raw) throw new Error("SOCIAL_OAUTH_BASE_URL saknas.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("SOCIAL_OAUTH_BASE_URL måste vara en absolut URL.");
  }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (!(url.protocol === "https:" || localHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error("SOCIAL_OAUTH_BASE_URL måste vara en ren HTTPS-origin (localhost får använda HTTP i utveckling).");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("SOCIAL_OAUTH_BASE_URL får inte innehålla en sökväg.");
  }
  return url.origin;
}

export function callbackUrlForProvider(provider: SocialProvider, baseUrl = getSocialOAuthBaseUrl()): string {
  return `${baseUrl}/api/social/connections/${provider}/callback`;
}

export function getSocialProviderAvailability(providerInput: string): { configured: boolean; missing: string[] } {
  const provider = socialProviderSchema.safeParse(providerInput);
  if (!provider.success) return { configured: false, missing: ["okänd leverantör"] };
  const missing = missingConfigurationForProvider(provider.data);
  return { configured: missing.length === 0, missing };
}

export function getSocialProviderConfig(provider: SocialProvider): SocialOAuthProviderConfig {
  const missing = missingConfigurationForProvider(provider);
  if (missing.length) throw new SocialProviderConfigurationError(provider, missing);

  const baseUrl = getSocialOAuthBaseUrl();
  if (provider === "linkedin") {
    const apiVersion = environmentValue("LINKEDIN_API_VERSION") ?? "202602";
    if (!/^20\d{4}$/.test(apiVersion)) throw new SocialProviderConfigurationError(provider, ["LINKEDIN_API_VERSION (YYYYMM)"]);
    return {
      provider,
      clientId: requireEnvironment("LINKEDIN_CLIENT_ID"),
      clientSecret: requireEnvironment("LINKEDIN_CLIENT_SECRET"),
      redirectUri: callbackUrlForProvider(provider, baseUrl),
      authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
      tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
      apiBaseUrl: "https://api.linkedin.com",
      apiVersion,
      // The Posts API needs the app-scoped person ID from GET /v2/me, which
      // is returned under r_liteprofile. OIDC `sub` is not assumed to be a
      // Posts API person identifier.
      scopes: parseScopes(environmentValue("LINKEDIN_OAUTH_SCOPES"), ["r_liteprofile", "w_member_social"]),
    };
  }

  const graphApiVersion = environmentValue("META_GRAPH_API_VERSION") ?? "v25.0";
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) throw new SocialProviderConfigurationError(provider, ["META_GRAPH_API_VERSION (vNN.N)"]);
  const graphBaseUrl = `https://graph.facebook.com/${graphApiVersion}`;
  const instagramGraphBaseUrl = `${getTrustedMetaGraphHost("META_INSTAGRAM_GRAPH_BASE_URL")}/${graphApiVersion}`;
  return {
    provider,
    clientId: requireEnvironment("META_APP_ID"),
    clientSecret: requireEnvironment("META_APP_SECRET"),
    redirectUri: callbackUrlForProvider(provider, baseUrl),
    graphApiVersion,
    graphBaseUrl,
    instagramGraphBaseUrl,
    authorizationUrl: `https://www.facebook.com/${graphApiVersion}/dialog/oauth`,
    tokenUrl: `${graphBaseUrl}/oauth/access_token`,
    scopes: parseScopes(environmentValue("META_OAUTH_SCOPES"), [
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publish",
    ]),
  };
}

function missingConfigurationForProvider(provider: SocialProvider): string[] {
  const missing: string[] = [];
  try {
    getSocialOAuthBaseUrl();
  } catch {
    missing.push("SOCIAL_OAUTH_BASE_URL");
  }
  try {
    getSocialTokenEncryptionKey();
  } catch (error) {
    missing.push(error instanceof SocialEncryptionConfigurationError ? "SOCIAL_TOKEN_ENCRYPTION_KEY" : "SOCIAL_TOKEN_ENCRYPTION_KEY");
  }
  if (provider === "linkedin") {
    if (!environmentValue("LINKEDIN_CLIENT_ID")) missing.push("LINKEDIN_CLIENT_ID");
    if (!environmentValue("LINKEDIN_CLIENT_SECRET")) missing.push("LINKEDIN_CLIENT_SECRET");
  } else {
    if (!environmentValue("META_APP_ID")) missing.push("META_APP_ID");
    if (!environmentValue("META_APP_SECRET")) missing.push("META_APP_SECRET");
    try {
      getTrustedMetaGraphHost("META_INSTAGRAM_GRAPH_BASE_URL");
    } catch {
      missing.push("META_INSTAGRAM_GRAPH_BASE_URL");
    }
  }
  return missing;
}

function requireEnvironment(name: string): string {
  const value = environmentValue(name);
  if (!value) throw new Error(`${name} saknas.`);
  return value;
}

function parseScopes(value: string | null, fallback: string[]): string[] {
  const scopes = (value ? value.split(/[\s,]+/) : fallback).map((scope) => scope.trim()).filter(Boolean);
  return [...new Set(scopes)];
}

/** Only Meta's documented Graph hosts are allowed as a configuration override. */
function getTrustedMetaGraphHost(name: string): string {
  const value = environmentValue(name) ?? "https://graph.facebook.com";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || !["graph.facebook.com", "graph.instagram.com"].includes(url.hostname)) {
      throw new Error("invalid host");
    }
    return url.origin;
  } catch {
    throw new Error(`${name} måste vara https://graph.facebook.com eller https://graph.instagram.com.`);
  }
}
