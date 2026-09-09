import { assertSupabaseAllowed, isVercelOnlyMode } from "@/lib/runtime/vercel-only";

export class MissingSupabaseConfigurationError extends Error {
  constructor() {
    super("Supabase är inte konfigurerat. Kontrollera .env.local.");
    this.name = "MissingSupabaseConfigurationError";
  }
}

/**
 * Returns variable names only, never their values. Route handlers can use this
 * to explain a recoverable setup problem without turning a missing `.env.local`
 * into an opaque 500 response.
 */
export function missingSupabasePublicConfiguration(): string[] {
  if (isVercelOnlyMode()) return ["Vercel/Neon"];
  const missing: string[] = [];
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim())) {
    missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }
  return missing;
}

/** Includes the public authentication settings plus the server-only data key. */
export function missingSupabaseServiceConfiguration(): string[] {
  if (isVercelOnlyMode()) return ["Vercel/Neon"];
  const missing = missingSupabasePublicConfiguration();
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) missing.push("SUPABASE_SERVICE_ROLE_KEY");
  return missing;
}

export function getSupabasePublicConfig(): { url: string; key: string } {
  assertSupabaseAllowed();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new MissingSupabaseConfigurationError();
  return { url, key };
}

export function getSupabaseServiceConfig(): { url: string; key: string } {
  assertSupabaseAllowed();
  const { url } = getSupabasePublicConfig();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new MissingSupabaseConfigurationError();
  return { url, key };
}

export function isSupabasePublicConfigured(): boolean {
  if (isVercelOnlyMode()) return false;
  return missingSupabasePublicConfiguration().length === 0;
}

export function isSupabaseServiceConfigured(): boolean {
  if (isVercelOnlyMode()) return false;
  return missingSupabaseServiceConfiguration().length === 0;
}
