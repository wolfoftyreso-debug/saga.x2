import "server-only";
import { createHash } from "node:crypto";

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 20;
const buckets = new Map<string, Bucket>();

/**
 * Best-effort per-process abuse brake. It stores only a short SHA-256 prefix
 * of a network identifier and the in-memory window; token validation still
 * happens before any database lookup, so this is not relied on for security.
 */
export function allowPublicUnsubscribeRequest(headers: Headers, now = Date.now()): boolean {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const identity = forwarded || headers.get("x-real-ip") || "unknown";
  const key = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 24);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    purgeExpiredBuckets(now);
    return true;
  }
  if (bucket.count >= MAX_REQUESTS_PER_WINDOW) return false;
  bucket.count += 1;
  return true;
}

function purgeExpiredBuckets(now: number): void {
  if (buckets.size < 200) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
