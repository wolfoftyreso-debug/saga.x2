import { AppShell } from "@/components/app-shell";
import { ContentEngineWorkspace } from "@/components/content-engine-workspace";

export const dynamic = "force-dynamic";

type ContentEnginePageProps = {
  // In Next 16, route search params are request-time data and therefore a
  // Promise. Keep the value opaque: the client must still confirm the active
  // Series Reference from the actor-scoped endpoint before it can use it.
  searchParams: Promise<{ seriesId?: string | string[] | undefined }>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function ContentEnginePage({ searchParams }: ContentEnginePageProps) {
  const query = await searchParams;
  const candidate = typeof query.seriesId === "string" ? query.seriesId.trim() : "";
  // Do not forward arbitrary query text into the client request body. The
  // protected API resolves only a server-side UUID from this route handoff.
  const seriesId = UUID_PATTERN.test(candidate) ? candidate : null;

  return <AppShell><ContentEngineWorkspace seriesId={seriesId} /></AppShell>;
}
