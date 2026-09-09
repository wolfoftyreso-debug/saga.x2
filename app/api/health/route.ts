import { NextResponse } from "next/server";
import { getNeonDatabaseConfigurationState, missingNeonConfiguration } from "@/lib/neon/config";
import { readNeonDatabaseHealth } from "@/lib/neon/studio-repository";

export const dynamic = "force-dynamic";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

/**
 * A public, secret-free deployment probe. It deliberately reports setup state
 * rather than pretending the Studio can persist when Neon is not ready.
 */
export async function GET() {
  const configuration = getNeonDatabaseConfigurationState();
  if (configuration === "missing") {
    return NextResponse.json(
      { ok: false, code: "configuration_required", missing: missingNeonConfiguration() },
      { status: 503, headers: noStoreHeaders },
    );
  }
  if (configuration === "invalid") {
    return NextResponse.json(
      { ok: false, code: "database_configuration_invalid" },
      { status: 503, headers: noStoreHeaders },
    );
  }

  try {
    const health = await readNeonDatabaseHealth();
    if (health.status === "database_not_configured") {
      return NextResponse.json(
        { ok: false, code: "configuration_required", missing: missingNeonConfiguration() },
        { status: 503, headers: noStoreHeaders },
      );
    }

    return NextResponse.json(
      { ok: true, database: "ready", checkedAt: health.checkedAt },
      { headers: noStoreHeaders },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: "database_unavailable" },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
