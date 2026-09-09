import { SetupRequired } from "@/components/setup-required";
import { getCurrentActor } from "@/lib/neon/auth-repository";
import { isNeonDatabaseConfigured } from "@/lib/neon/config";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The product entry point is Vercel + Neon Studio. Legacy reader routes are not a deployment mode. */
export default async function HomePage() {
  if (!isNeonDatabaseConfigured()) return <SetupRequired />;

  try {
    const actor = await getCurrentActor();
    if (!actor) redirect("/login");
  } catch {
    return <SetupRequired />;
  }

  redirect("/studio");
}
