import "server-only";

import { timingSafeEqual } from "node:crypto";

export type VercelCronAuthorization =
  | { ok: true }
  | { ok: false; code: "configuration_required"; missing: ["CRON_SECRET"] }
  | { ok: false; code: "unauthorized" };

/**
 * Verifies Vercel Cron's standard `Authorization: Bearer <CRON_SECRET>`
 * header. The value is compared in constant time and is never returned,
 * logged, or included in an error message.
 */
export function authorizeVercelCron(request: Request): VercelCronAuthorization {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return { ok: false, code: "configuration_required", missing: ["CRON_SECRET"] };
  }

  const authorization = request.headers.get("authorization");
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return { ok: false, code: "unauthorized" };

  const supplied = Buffer.from(authorization.slice(prefix.length), "utf8");
  const expected = Buffer.from(secret, "utf8");
  if (supplied.byteLength !== expected.byteLength) return { ok: false, code: "unauthorized" };

  return timingSafeEqual(supplied, expected)
    ? { ok: true }
    : { ok: false, code: "unauthorized" };
}
