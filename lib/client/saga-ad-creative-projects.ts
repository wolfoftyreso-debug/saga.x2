import type {
  SagaAdCreativeProject,
  SagaAdCreativeProjectCreateInput,
  SagaAdCreativeProjectUpdateInput,
} from "@/lib/domain/saga-ad-creative";

export class SagaAdCreativeHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "SagaAdCreativeHttpError";
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  if (payload.code === "configuration_required" || payload.code === "database_configuration_invalid") {
    return "Annonsstudion kan spara när arbetsytans datalager är anslutet.";
  }
  return typeof payload.error === "string" && payload.error.trim() ? payload.error : fallback;
}

function projectFromPayload(value: unknown): SagaAdCreativeProject | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return null;
  if (!Number.isInteger(value.revision) || !Array.isArray(value.variants) || !isRecord(value.masterBrief)) return null;
  return value as unknown as SagaAdCreativeProject;
}

async function json(response: Response): Promise<unknown> {
  try { return await response.json() as unknown; } catch { return null; }
}

/** Creates a private creative project. This never buys, exports or publishes an ad. */
export async function createSagaAdCreativeProject(input: SagaAdCreativeProjectCreateInput): Promise<SagaAdCreativeProject> {
  const response = await fetch("/api/saga/ad-creative-projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await json(response);
  const project = isRecord(payload) ? projectFromPayload(payload.project) : null;
  if (!response.ok || !project) throw new SagaAdCreativeHttpError(messageFromPayload(payload, "Kunde inte skapa det privata annonsprojektet."), response.status);
  return project;
}

export async function listSagaAdCreativeProjects(signal?: AbortSignal): Promise<SagaAdCreativeProject[]> {
  const response = await fetch("/api/saga/ad-creative-projects", { credentials: "same-origin", cache: "no-store", signal });
  const payload = await json(response);
  const projects = isRecord(payload) && Array.isArray(payload.projects)
    ? payload.projects.map(projectFromPayload).filter((project): project is SagaAdCreativeProject => project !== null)
    : null;
  if (!response.ok || projects === null) throw new SagaAdCreativeHttpError(messageFromPayload(payload, "Kunde inte läsa annonsprojekten."), response.status);
  return projects;
}

export async function updateSagaAdCreativeProject(id: string, input: SagaAdCreativeProjectUpdateInput): Promise<SagaAdCreativeProject> {
  const response = await fetch(`/api/saga/ad-creative-projects/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await json(response);
  const project = isRecord(payload) ? projectFromPayload(payload.project) : null;
  if (!response.ok || !project) throw new SagaAdCreativeHttpError(messageFromPayload(payload, "Kunde inte spara ändringen."), response.status);
  return project;
}

export async function deleteSagaAdCreativeProject(id: string, expectedRevision: number): Promise<void> {
  const response = await fetch(`/api/saga/ad-creative-projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision }),
    credentials: "same-origin",
    cache: "no-store",
  });
  const payload = await json(response);
  if (!response.ok) throw new SagaAdCreativeHttpError(messageFromPayload(payload, "Kunde inte radera annonsprojektet."), response.status);
}
