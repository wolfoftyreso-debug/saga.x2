import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServiceConfig } from "@/lib/supabase/config";

/** Server-only client for cron/publication work. Never import this into a Client Component. */
export function createAdminClient() {
  const { url, key } = getSupabaseServiceConfig();
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
