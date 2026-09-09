import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { composeSocialText, providerForChannel, readySocialPostSchema } from "@/lib/domain/social";
import {
  decryptSocialSecret,
  encryptSocialSecret,
  getSocialTokenEncryptionKey,
  SocialEncryptionConfigurationError,
} from "@/lib/services/social-crypto";
import { getSocialProviderAvailability, SocialProviderConfigurationError } from "@/lib/services/social-config";
import { createSocialOAuthStart, readSocialOAuthTransaction } from "@/lib/services/social-connections";
import { publicHttpsMediaUrl } from "@/lib/services/social-publishing";

const ENV_KEYS = [
  "SOCIAL_TOKEN_ENCRYPTION_KEY",
  "SOCIAL_OAUTH_BASE_URL",
  "META_APP_ID",
  "META_APP_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
] as const;
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setConfiguredEnvironment() {
  process.env.SOCIAL_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SOCIAL_OAUTH_BASE_URL = "https://brief.example";
  process.env.META_APP_ID = "meta-app";
  process.env.META_APP_SECRET = "meta-secret";
  process.env.LINKEDIN_CLIENT_ID = "linkedin-app";
  process.env.LINKEDIN_CLIENT_SECRET = "linkedin-secret";
}

describe("sociala kopplingar", () => {
  it("krypterar OAuth-token med AES-GCM och vägrar en felaktig nyckel", () => {
    const key = randomBytes(32);
    const encrypted = encryptSocialSecret("token-som-aldrig-får-lämna-servern", key);
    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(encrypted).not.toContain("token-som-aldrig-får-lämna-servern");
    expect(decryptSocialSecret(encrypted, key)).toBe("token-som-aldrig-får-lämna-servern");
    expect(() => decryptSocialSecret(encrypted, randomBytes(32))).toThrow("kunde inte läsas");
    expect(() => getSocialTokenEncryptionKey("inte-en-256-bitars-nyckel")).toThrow(SocialEncryptionConfigurationError);
  });

  it("bygger en tidsbegränsad OAuth-transaktion som är bunden till användare, arbetsyta och provider", () => {
    setConfiguredEnvironment();
    const start = createSocialOAuthStart({
      provider: "linkedin",
      userId: "user-42",
      workspaceId: "workspace-42",
      returnTo: "/studio?tab=connections",
    });
    const authorizationUrl = new URL(start.authorizationUrl);
    const state = authorizationUrl.searchParams.get("state");
    expect(authorizationUrl.origin).toBe("https://www.linkedin.com");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe("https://brief.example/api/social/connections/linkedin/callback");
    expect(start.cookie.value).not.toContain("user-42");
    expect(readSocialOAuthTransaction({ provider: "linkedin", cookieValue: start.cookie.value, returnedState: state })).toMatchObject({
      userId: "user-42",
      workspaceId: "workspace-42",
      returnTo: "/studio?tab=connections",
    });
    expect(readSocialOAuthTransaction({ provider: "linkedin", cookieValue: start.cookie.value, returnedState: "wrong" })).toBeNull();
    expect(readSocialOAuthTransaction({ provider: "facebook_page", cookieValue: start.cookie.value, returnedState: state })).toBeNull();
  });

  it("visar konfigurationskrav utan att låtsas att en koppling går att starta", () => {
    delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    delete process.env.SOCIAL_OAUTH_BASE_URL;
    delete process.env.META_APP_ID;
    delete process.env.META_APP_SECRET;
    const unavailable = getSocialProviderAvailability("facebook_page");
    expect(unavailable.configured).toBe(false);
    expect(unavailable.missing).toEqual(expect.arrayContaining(["SOCIAL_TOKEN_ENCRYPTION_KEY", "SOCIAL_OAUTH_BASE_URL", "META_APP_ID", "META_APP_SECRET"]));

    setConfiguredEnvironment();
    expect(getSocialProviderAvailability("instagram_professional")).toEqual({ configured: true, missing: [] });
  });

  it("vägrar att starta OAuth utan komplett Vercel-providerkonfiguration", () => {
    delete process.env.SOCIAL_TOKEN_ENCRYPTION_KEY;
    delete process.env.SOCIAL_OAUTH_BASE_URL;
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;

    expect(() => createSocialOAuthStart({
      provider: "linkedin",
      userId: "user-42",
      workspaceId: "workspace-42",
      returnTo: "/studio/channels",
    })).toThrow(SocialProviderConfigurationError);
  });

  it("tillåter bara offentliga HTTPS-bilder och mappar studio-kanalen till rätt provider", () => {
    expect(publicHttpsMediaUrl("https://cdn.example.com/images/post.jpg")).toBe("https://cdn.example.com/images/post.jpg");
    expect(() => publicHttpsMediaUrl("http://cdn.example.com/image.jpg")).toThrow("offentlig HTTPS-adress");
    expect(() => publicHttpsMediaUrl("https://127.0.0.1/image.jpg")).toThrow("offentlig HTTPS-adress");
    expect(() => publicHttpsMediaUrl("https://admin:secret@cdn.example.com/image.jpg")).toThrow("offentlig HTTPS-adress");
    expect(providerForChannel("instagram")).toBe("instagram_professional");
  });

  it("skapar en kort, plattformsneutral text från rubrik, brödtext och CTA", () => {
    const post = readySocialPostSchema.parse({ headline: "Det här gäller", body: "Rakt på sak.", cta: "Läs mer." });
    expect(composeSocialText(post)).toBe("Det här gäller\n\nRakt på sak.\n\nLäs mer.");
  });
});
