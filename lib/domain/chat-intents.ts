import { z } from "zod";
import { EVENT_STATUSES, type EventStatus } from "@/lib/domain/types";
import { SOURCE_CATALOG, SOURCE_PRIORITIES, SOURCE_ROLES, type SourcePriority, type SourceRole } from "@/lib/domain/source-catalog";

const briefKinds = ["main", "company", "economy", "technology", "regulation", "creator", "local", "custom"] as const;
const cadences = ["daily", "weekly"] as const;
const sourceFrequencies = ["all_relevant", "daily", "weekly", "material"] as const;
const verificationRequirements = ["none", "verify_material", "primary_only", "two_independent"] as const;
const weightColumns = [
  "economy_weight",
  "technology_weight",
  "regulation_weight",
  "geopolitics_weight",
  "sweden_eu_weight",
  "usa_weight",
  "gulf_weight",
] as const;

/**
 * A deliberately narrow, validated contract between language understanding and
 * database mutations. The model may suggest one of these shapes, but it never
 * supplies a user id or a database id and it cannot make a mutation itself.
 */
export const chatIntentSchema = z.object({
  kind: z.enum([
    "none",
    "clarify",
    "source_add",
    "source_update",
    "event_watch_create",
    "topic_watch_create",
    "brief_create",
    "brief_state",
    "brief_delete",
    "weight_adjust",
  ]),
  operation: z.enum(["none", "create", "block", "restore", "update", "pause", "resume", "delete", "increase", "decrease"]),
  sourceQuery: z.string().trim().max(160).nullable(),
  sourceUrl: z.string().trim().max(2_000).nullable(),
  sourceName: z.string().trim().max(160).nullable(),
  sourceRoles: z.array(z.enum(SOURCE_ROLES)).max(SOURCE_ROLES.length),
  sourcePriority: z.enum(SOURCE_PRIORITIES).nullable(),
  sourceTopicFilter: z.string().trim().max(500).nullable(),
  sourceVerificationRequirement: z.enum(verificationRequirements).nullable(),
  sourceFrequency: z.enum(sourceFrequencies).nullable(),
  watchTitle: z.string().trim().max(220).nullable(),
  triggerStatuses: z.array(z.enum(EVENT_STATUSES)).max(EVENT_STATUSES.length),
  briefName: z.string().trim().max(80).nullable(),
  briefKind: z.enum(briefKinds).nullable(),
  briefCadence: z.enum(cadences).nullable(),
  briefLocalTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  briefWeekday: z.number().int().min(0).max(6).nullable(),
  briefInstructions: z.string().trim().max(2_000).nullable(),
  weightColumn: z.enum(weightColumns).nullable(),
  weightDelta: z.number().int().min(-50).max(50).nullable(),
  clarification: z.string().trim().max(500).nullable(),
});

export type ChatIntent = z.infer<typeof chatIntentSchema>;
export type WeightColumn = (typeof weightColumns)[number];

const emptyIntent = (): ChatIntent => ({
  kind: "none",
  operation: "none",
  sourceQuery: null,
  sourceUrl: null,
  sourceName: null,
  sourceRoles: [],
  sourcePriority: null,
  sourceTopicFilter: null,
  sourceVerificationRequirement: null,
  sourceFrequency: null,
  watchTitle: null,
  triggerStatuses: [],
  briefName: null,
  briefKind: null,
  briefCadence: null,
  briefLocalTime: null,
  briefWeekday: null,
  briefInstructions: null,
  weightColumn: null,
  weightDelta: null,
  clarification: null,
});

function intent(overrides: Partial<ChatIntent>): ChatIntent {
  return chatIntentSchema.parse({ ...emptyIntent(), ...overrides });
}

/**
 * Fast-path parsing covers explicit Swedish phrasing without a model roundtrip.
 * Ambiguous configuration requests intentionally become clarifications rather
 * than an assumed mutation.
 */
export function parseDeterministicChatIntent(message: string, eventId?: string | null): ChatIntent | null {
  const value = message.trim();
  const normalized = value.toLocaleLowerCase("sv-SE");
  const source = findKnownSource(value);
  const sourceUrl = value.match(/https?:\/\/[^\s,]+/i)?.[0] ?? null;

  if (/^\s*(lägg till|följ)\b/i.test(value) && sourceUrl) {
    return intent({
      kind: "source_add",
      operation: "create",
      sourceUrl,
      sourceName: sourceUrl,
      sourceRoles: ["discovery", "analysis"],
    });
  }

  const restoreSource = /(lägg tillbaka|aktivera|slå på|använd igen)/i.test(value);
  const blockSource = /(blockera|stäng av|använd inte|inte längre använda|inte användas|sluta använda)/i.test(value);
  if (source && (restoreSource || blockSource)) {
    return intent({
      kind: "source_update",
      operation: restoreSource ? "restore" : "block",
      sourceQuery: source.domain,
    });
  }

  const roles = rolesInText(normalized);
  if (source && roles.length && /(bara|endast|roll|använd|för)/i.test(value)) {
    return intent({
      kind: "source_update",
      operation: "update",
      sourceQuery: source.domain,
      sourceRoles: roles,
    });
  }

  if (source && /\b(prioritera|prioritet|hög prioritet|låg prioritet)\b/i.test(value)) {
    const priority: SourcePriority = /\b(låg|mindre)\b/i.test(value) ? "low" : /\b(hög|mest)\b/i.test(value) ? "high" : "normal";
    return intent({ kind: "source_update", operation: "update", sourceQuery: source.domain, sourcePriority: priority });
  }

  if (eventId && /\b(följ|bevaka|säg till|notifiera)\b/i.test(value)) {
    return intent({
      kind: "event_watch_create",
      operation: "create",
      watchTitle: "Den här händelsen",
      triggerStatuses: statusTriggers(normalized),
    });
  }

  if (/\b(följ|bevaka|säg till|notifiera)\b/i.test(value)) {
    const watchTitle = extractWatchTitle(value);
    if (!watchTitle || /^(detta|det här|den här|denna)$/i.test(watchTitle)) {
      return intent({
        kind: "clarify",
        operation: "none",
        clarification: "Jag kan skapa bevakningen, men behöver veta vad som ska följas. Skriv till exempel: “Bevaka EU:s AI-regler och säg till när de träder i kraft.”",
      });
    }
    return intent({
      kind: "topic_watch_create",
      operation: "create",
      watchTitle,
      triggerStatuses: statusTriggers(normalized),
    });
  }

  if (/\b(pausa|stoppa|inaktivera|återuppta|aktivera)\b.*\b(?:[a-zåäö]+)?brief(?:en)?\b/i.test(value)) {
    const pause = /\b(pausa|stoppa|inaktivera)\b/i.test(value);
    return intent({
      kind: "brief_state",
      operation: pause ? "pause" : "resume",
      briefName: extractBriefName(value),
    });
  }

  if (/\b(ta bort|radera)\b.*\b(?:[a-zåäö]+)?brief(?:en)?\b/i.test(value)) {
    return intent({ kind: "brief_delete", operation: "delete", briefName: extractBriefName(value) });
  }

  if (/\b(skapa|lägg till|ny)\b.*\b(?:[a-zåäö]+)?brief(?:en)?\b/i.test(value)) {
    const weekly = /\b(?:vecko(?:brief)?|veckovis|weekly)\b/i.test(value);
    const briefName = extractCreateBriefName(value);
    if (!briefName) {
      return intent({
        kind: "clarify",
        operation: "none",
        clarification: "Jag kan skapa en brief, men behöver ett ämne. Skriv till exempel: “Skapa en veckobrief om europeisk AI-reglering.”",
      });
    }
    return intent({
      kind: "brief_create",
      operation: "create",
      briefName,
      briefKind: inferBriefKind(normalized),
      briefCadence: weekly ? "weekly" : "daily",
      briefLocalTime: extractTime(value),
      briefWeekday: weekly ? extractWeekday(normalized) ?? 0 : null,
      briefInstructions: `Fokusera på ${briefName}. ${value}`.slice(0, 2_000),
    });
  }

  const weight = findWeightIntent(normalized);
  if (weight) return intent({ kind: "weight_adjust", operation: weight.delta > 0 ? "increase" : "decrease", weightColumn: weight.column, weightDelta: weight.delta });

  if (looksLikeWorkspaceMutation(normalized)) {
    return intent({
      kind: "clarify",
      operation: "none",
      clarification: "Jag vill inte gissa och ändra en inställning fel. Skriv gärna vad som ska ändras och för vilket ämne, källa, brief eller bevakning. Inget har ändrats.",
    });
  }

  return null;
}

export function looksLikeWorkspaceMutation(message: string): boolean {
  return /\b(brief|bevaka|följ|notifier|källa|blockera|aktivera|pausa|återuppta|prioritera|inställning|regel|mindre|mer|öka|sänk|ta bort|radera|lägg till)\b/i.test(message);
}

export function rolesInText(message: string): SourceRole[] {
  const roles: SourceRole[] = [];
  if (/upptäck|hitta|sök/.test(message)) roles.push("discovery");
  if (/analys|analysera/.test(message)) roles.push("analysis");
  if (/verifier|bekräft/.test(message)) roles.push("verification");
  if (/citer|källa i svar|referens/.test(message)) roles.push("citation");
  if (/direktbevak|direkt bevak|löpande bevak/.test(message)) roles.push("direct_monitoring");
  return [...new Set(roles)];
}

export function statusTriggers(message: string): EventStatus[] {
  const triggers: EventStatus[] = [];
  if (/antas|antagen|ratificer/.test(message)) triggers.push("adopted");
  if (/träder i kraft|börjar gälla|gäller/.test(message)) triggers.push("effective");
  if (/underteckn|signer/.test(message)) triggers.push("signed");
  if (/implementer/.test(message)) triggers.push("implemented");
  if (/ändra|status/.test(message)) triggers.push("changed");
  if (/upphäv|återkall|faller/.test(message)) triggers.push("reversed");
  return triggers.length ? [...new Set(triggers)] : ["changed", "reversed"];
}

export function findKnownSource(message: string) {
  const normalized = message.toLocaleLowerCase("sv-SE");
  return SOURCE_CATALOG.find((entry) => normalized.includes(entry.domain) || normalized.includes(entry.name.toLocaleLowerCase("sv-SE"))) ?? null;
}

function extractWatchTitle(message: string): string | null {
  const title = message
    .replace(/^\s*(följ|bevaka|säg till(?: mig)?|notifiera mig?)\s*/i, "")
    .replace(/\s+(och\s+)?(säg till|notifiera).*/i, "")
    .replace(/[.?!]$/, "")
    .trim()
    .slice(0, 220);
  return title.length >= 2 ? title : null;
}

function extractBriefName(message: string): string | null {
  const withoutAction = message
    .replace(/^.*?\b(?:pausa|stoppa|inaktivera|återuppta|aktivera|ta bort|radera)\b/i, "")
    .replace(/\b(?:[a-zåäö]+)?brief(?:en)?\b/i, "")
    .replace(/^\s*(?:min|huvud|den|briefen|om)\s*/i, "")
    .replace(/[.?!]$/, "")
    .trim()
    .slice(0, 80);
  return withoutAction.length >= 2 ? withoutAction : null;
}

function extractCreateBriefName(message: string): string | null {
  const about = message.match(/\b(?:[a-zåäö]+)?brief(?:en)?\b\s*(?:om|för)?\s*(.+)$/i)?.[1]
    ?? message.match(/\b(?:om|för)\s+(.+)$/i)?.[1]
    ?? null;
  const value = about
    ?.replace(/\s+(?:på|varje)\s+(?:måndag|tisdag|onsdag|torsdag|fredag|lördag|söndag)(?:\s+(?:kl\.?|klockan)\s*\d{1,2}(?::|\.)\d{2})?\.?$/i, "")
    .replace(/\s+(?:kl\.?|klockan)\s*\d{1,2}(?::|\.)\d{2}\.?$/i, "")
    .replace(/[.?!]$/, "")
    .trim()
    .slice(0, 80) ?? "";
  return value.length >= 2 ? value : null;
}

function extractTime(message: string): string | null {
  const match = message.match(/\b(?:kl\.?|klockan)\s*([01]?\d|2[0-3])(?::|\.)([0-5]\d)\b/i);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

function extractWeekday(message: string): number | null {
  const names: Array<[RegExp, number]> = [
    [/måndag/, 0], [/tisdag/, 1], [/onsdag/, 2], [/torsdag/, 3], [/fredag/, 4], [/lördag/, 5], [/söndag/, 6],
  ];
  return names.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}

function inferBriefKind(message: string): ChatIntent["briefKind"] {
  if (/bolag|företag|kund|leverantör/.test(message)) return "company";
  if (/ekonomi|ränt|kredit|marknad/.test(message)) return "economy";
  if (/teknik|ai|modell|moln|chip|compute/.test(message)) return "technology";
  if (/regel|juridik|lag|myndighet/.test(message)) return "regulation";
  if (/creator|podd|youtube|nyhetsbrev/.test(message)) return "creator";
  if (/lokal|stockholm|göteborg|malmö/.test(message)) return "local";
  return "custom";
}

function findWeightIntent(message: string): { column: WeightColumn; delta: number } | null {
  const direction = /\b(mindre|färre|sänk|dra ned|sluta visa)\b/.test(message) ? -15 : /\b(mer|öka|prioritera)\b/.test(message) ? 15 : 0;
  if (!direction) return null;
  const candidates: Array<{ pattern: RegExp; column: WeightColumn }> = [
    { pattern: /ekonomi|ränt|kredit|marknad/, column: "economy_weight" },
    { pattern: /teknik|ai|modell|moln|chip|compute/, column: "technology_weight" },
    { pattern: /regel|juridik|lag|myndighet/, column: "regulation_weight" },
    { pattern: /geopolitik|handel|säkerhet|sanktion/, column: "geopolitics_weight" },
    { pattern: /sverige|europa|\beu\b/, column: "sweden_eu_weight" },
    { pattern: /usa|amerikansk/, column: "usa_weight" },
    { pattern: /gulf|uae|dubai/, column: "gulf_weight" },
  ];
  const hit = candidates.find((candidate) => candidate.pattern.test(message));
  return hit ? { ...hit, delta: direction } : null;
}
