import type { StudioDraftView } from "./content-studio-adapter";

// Related delivery fields are compared together: never combine a local time
// with a concurrently changed timezone or a newsletter with another audience.
const groups = [
  ["title", "Intern titel", ["title"]],
  ["headline", "Rubrik", ["headline"]],
  ["subject", "Ämnesrad", ["subject"]],
  ["body", "Text", ["body"]],
  ["cta", "Avslut / uppmaning", ["cta"]],
  ["excerpt", "Sammanfattning", ["excerpt"]],
  ["hashtags", "Hashtags", ["hashtags"]],
  ["generationPrompt", "Textinstruktion", ["generationPrompt"]],
  ["imagePrompt", "Bildinstruktion", ["imagePrompt"]],
  ["destination", "Format, kanaler och mottagarlista", ["contentType", "channels", "newsletterAudienceId"]],
  ["schedule", "Datum, tid och tidszon", ["scheduledAt", "scheduledLocalDate", "scheduledLocalTime", "timezone"]],
  ["approvalRequired", "Krav på godkännande", ["approvalRequired"]],
  ["templateId", "Mall", ["templateId"]],
] as const satisfies ReadonlyArray<readonly [string, string, ReadonlyArray<keyof StudioDraftView>]>;

export type DraftConflictKey = (typeof groups)[number][0];
export type DraftConflictChoices = Partial<Record<DraftConflictKey, "local" | "server">>;
export type DraftFieldConflict = { key: DraftConflictKey; label: string; local: string; server: string };

function groupValue(draft: StudioDraftView, keys: ReadonlyArray<keyof StudioDraftView>) {
  return keys.map((key) => draft[key]);
}

function readableValue(values: unknown[]) {
  return values.map((value) => {
    if (value === null || value === "") return "—";
    if (typeof value === "boolean") return value ? "Ja" : "Nej";
    return Array.isArray(value) ? value.join(", ") || "—" : String(value);
  }).join("\n");
}

/** Three-way merge. No write or revision advancement happens until the user
 * accepts it; latest server identity, media and security flags always win. */
export function mergeDraftConflict(
  base: StudioDraftView,
  local: StudioDraftView,
  server: StudioDraftView,
  choices: DraftConflictChoices = {},
): { draft: StudioDraftView; conflicts: DraftFieldConflict[]; unresolved: DraftConflictKey[] } {
  if (base.id !== local.id || local.id !== server.id
    || base.revision === null || server.revision === null || server.revision <= base.revision) {
    throw new Error("Den senaste versionen kunde inte verifieras. Dina ändringar är kvar i editorn.");
  }
  const draft = { ...server };
  const conflicts: DraftFieldConflict[] = [];
  const unresolved: DraftConflictKey[] = [];
  for (const [key, label, fields] of groups) {
    const original = JSON.stringify(groupValue(base, fields));
    const mine = groupValue(local, fields);
    const theirs = groupValue(server, fields);
    const localChanged = JSON.stringify(mine) !== original;
    const bothChanged = localChanged && JSON.stringify(theirs) !== original && JSON.stringify(mine) !== JSON.stringify(theirs);
    if (bothChanged) {
      conflicts.push({ key, label, local: readableValue(mine), server: readableValue(theirs) });
      if (!choices[key]) unresolved.push(key);
    }
    if (localChanged && (!bothChanged || choices[key] === "local")) {
      for (const field of fields) Object.assign(draft, { [field]: local[field] });
    }
  }
  return { draft, conflicts, unresolved };
}

export function hasDraftEdits(base: StudioDraftView, draft: StudioDraftView): boolean {
  return groups.some(([, , fields]) => JSON.stringify(groupValue(base, fields)) !== JSON.stringify(groupValue(draft, fields)));
}

export function draftReviewFields(draft: StudioDraftView) {
  return groups.map(([key, label, fields]) => ({ key, label, value: readableValue(groupValue(draft, fields)) }));
}
