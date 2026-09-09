import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  newsletterUnsubscribeTargetSchema,
  newsletterUnsubscribeTokenSchema,
  type NewsletterUnsubscribeTarget,
  type NewsletterUnsubscribeTokenPayload,
} from "@/lib/domain/newsletter-unsubscribe";

const VERSION = "v1";
const AAD = Buffer.from("personal-daily-brief/newsletter-unsubscribe/v1", "utf8");
const DEFAULT_EXPIRY_SECONDS = 365 * 24 * 60 * 60;

export class NewsletterUnsubscribeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewsletterUnsubscribeConfigurationError";
  }
}

export type NewsletterUnsubscribeAvailability = {
  configured: boolean;
  missing: string[];
};

type UnsubscribeConfig = {
  baseUrl: URL;
  key: Buffer;
};

/**
 * The public URL is explicit: email recipients cannot reach localhost or a
 * guessed deployment. The AES key makes the token opaque and tamper-proof.
 */
export function getNewsletterUnsubscribeAvailability(): NewsletterUnsubscribeAvailability {
  const missing: string[] = [];
  if (!process.env.NEWSLETTER_PUBLIC_BASE_URL?.trim()) missing.push("NEWSLETTER_PUBLIC_BASE_URL");
  if (!process.env.NEWSLETTER_UNSUBSCRIBE_SECRET?.trim()) missing.push("NEWSLETTER_UNSUBSCRIBE_SECRET");
  if (missing.length) return { configured: false, missing };
  try {
    getUnsubscribeConfig();
    return { configured: true, missing: [] };
  } catch {
    return { configured: false, missing: ["NEWSLETTER_PUBLIC_BASE_URL eller NEWSLETTER_UNSUBSCRIBE_SECRET är ogiltig"] };
  }
}

export function createNewsletterUnsubscribeUrl(input: NewsletterUnsubscribeTarget): string {
  const target = newsletterUnsubscribeTargetSchema.parse(input);
  const config = getUnsubscribeConfig();
  const expiresAt = Math.floor(Date.now() / 1_000) + (target.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS);
  const token = encryptToken({ c: target.contactId, a: target.audienceId, e: expiresAt }, config.key);
  const url = new URL("/api/newsletter/unsubscribe", config.baseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Returns null for expired, malformed, modified and wrong-key tokens. */
export function readNewsletterUnsubscribeToken(rawToken: string): NewsletterUnsubscribeTokenPayload | null {
  const token = newsletterUnsubscribeTokenSchema.safeParse(rawToken);
  if (!token.success) return null;
  let config: UnsubscribeConfig;
  try {
    config = getUnsubscribeConfig();
  } catch {
    return null;
  }
  try {
    const value = decryptToken(token.data, config.key);
    const target = newsletterUnsubscribeTargetSchema.safeParse({
      contactId: value.c,
      audienceId: value.a,
      expiresInSeconds: 3_600,
    });
    const expiresAt = typeof value.e === "number" && Number.isSafeInteger(value.e) ? value.e : 0;
    if (!target.success || expiresAt <= Math.floor(Date.now() / 1_000)) return null;
    return {
      contactId: target.data.contactId,
      audienceId: target.data.audienceId,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  } catch {
    return null;
  }
}

function getUnsubscribeConfig(): UnsubscribeConfig {
  const rawBaseUrl = process.env.NEWSLETTER_PUBLIC_BASE_URL?.trim();
  const rawSecret = process.env.NEWSLETTER_UNSUBSCRIBE_SECRET?.trim();
  if (!rawBaseUrl || !rawSecret) {
    throw new NewsletterUnsubscribeConfigurationError("Avprenumering kräver NEWSLETTER_PUBLIC_BASE_URL och NEWSLETTER_UNSUBSCRIBE_SECRET.");
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(rawBaseUrl);
  } catch {
    throw new NewsletterUnsubscribeConfigurationError("NEWSLETTER_PUBLIC_BASE_URL måste vara en giltig HTTPS-adress.");
  }
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.hash) {
    throw new NewsletterUnsubscribeConfigurationError("NEWSLETTER_PUBLIC_BASE_URL måste vara en offentlig HTTPS-adress utan inloggning eller hash.");
  }
  const key = decodeKey(rawSecret);
  return { baseUrl, key };
}

function decodeKey(value: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(value, "base64");
  } catch {
    throw new NewsletterUnsubscribeConfigurationError("NEWSLETTER_UNSUBSCRIBE_SECRET måste vara en base64-kodad 256-bitarsnyckel.");
  }
  if (key.byteLength !== 32) {
    throw new NewsletterUnsubscribeConfigurationError("NEWSLETTER_UNSUBSCRIBE_SECRET måste vara en base64-kodad 256-bitarsnyckel.");
  }
  return key;
}

function encryptToken(payload: { c: string; a: string; e: number }, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, base64url(nonce), base64url(ciphertext), base64url(tag)].join(".");
}

function decryptToken(token: string, key: Buffer): { c?: unknown; a?: unknown; e?: unknown } {
  const [version, encodedNonce, encodedCiphertext, encodedTag] = token.split(".");
  if (version !== VERSION || !encodedNonce || !encodedCiphertext || !encodedTag) throw new Error("invalid token");
  const decipher = createDecipheriv("aes-256-gcm", key, fromBase64url(encodedNonce));
  decipher.setAAD(AAD);
  decipher.setAuthTag(fromBase64url(encodedTag));
  const plaintext = Buffer.concat([decipher.update(fromBase64url(encodedCiphertext)), decipher.final()]).toString("utf8");
  const value: unknown = JSON.parse(plaintext);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid payload");
  return value as { c?: unknown; a?: unknown; e?: unknown };
}

function base64url(value: Buffer): string {
  return value.toString("base64url");
}

function fromBase64url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
