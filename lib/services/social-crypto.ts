import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ENVELOPE_VERSION = "v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

export class SocialEncryptionConfigurationError extends Error {
  constructor(message = "SOCIAL_TOKEN_ENCRYPTION_KEY saknas eller är ogiltig. Ange en base64-kodad 32-bytes nyckel.") {
    super(message);
    this.name = "SocialEncryptionConfigurationError";
  }
}

/**
 * Reads a base64/base64url-encoded 256-bit AES key. The key must never be
 * prefixed with NEXT_PUBLIC_ or placed in a client-exposed configuration.
 */
export function getSocialTokenEncryptionKey(raw = process.env.SOCIAL_TOKEN_ENCRYPTION_KEY): Buffer {
  if (!raw || raw.trim().length < 40) throw new SocialEncryptionConfigurationError();
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new SocialEncryptionConfigurationError();
  const key = Buffer.from(normalized, "base64");
  if (key.length !== KEY_BYTES) throw new SocialEncryptionConfigurationError();
  return key;
}

/** AES-256-GCM envelope: v1.<iv>.<ciphertext>.<authentication-tag>. */
export function encryptSocialSecret(plaintext: string, key = getSocialTokenEncryptionKey()): string {
  if (!plaintext) throw new Error("En tom OAuth-token kan inte krypteras.");
  if (key.length !== KEY_BYTES) throw new SocialEncryptionConfigurationError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString("base64url"), encrypted.toString("base64url"), tag.toString("base64url")].join(".");
}

export function decryptSocialSecret(envelope: string, key = getSocialTokenEncryptionKey()): string {
  const [version, ivEncoded, encryptedEncoded, tagEncoded, ...extra] = envelope.split(".");
  if (version !== ENVELOPE_VERSION || !ivEncoded || !encryptedEncoded || !tagEncoded || extra.length) {
    throw new Error("Den krypterade OAuth-tokenen har ett ogiltigt format.");
  }
  try {
    const iv = Buffer.from(ivEncoded, "base64url");
    const encrypted = Buffer.from(encryptedEncoded, "base64url");
    const tag = Buffer.from(tagEncoded, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== AUTH_TAG_BYTES || encrypted.length === 0) {
      throw new Error("invalid envelope lengths");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Den krypterade OAuth-tokenen kunde inte läsas. Koppla om kontot.");
  }
}
