import { AppShell } from "@/components/app-shell";
import { ProductSettingsHub } from "@/components/product-settings-hub";
import { getCurrentActor, type AppActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";

export const dynamic = "force-dynamic";

/**
 * Product settings deliberately stay product-facing. Runtime provisioning is
 * not a user task and is therefore never rendered on this route.
 */
export default async function SettingsPage() {
  let actor: AppActor | null = null;

  if (isNeonDatabaseConfigured()) {
    try {
      actor = await getCurrentActor();
    } catch {
      // The hub has an honest, read-only unavailable state. Do not turn a
      // transient workspace read into a technical checklist or a dead end.
      actor = null;
    }
  }

  return (
    <AppShell>
      <ProductSettingsHub actor={actor} />
    </AppShell>
  );
}
