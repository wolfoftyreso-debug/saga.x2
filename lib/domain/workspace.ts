import { z } from "zod";
import { SOURCE_KINDS, SOURCE_PRIORITIES, SOURCE_ROLES } from "@/lib/domain/source-catalog";
import { EVENT_STATUSES } from "@/lib/domain/types";
import { isValidIanaTimezone } from "@/lib/utils/date";

const textListSchema = z.array(z.string().trim().min(1).max(120)).max(30);

export const profileContextSchema = z.object({
  workSummary: z.string().max(1_500),
  roleTitle: z.string().max(160),
  organizations: textListSchema,
  sectors: textListSchema,
  markets: textListSchema,
  dependencies: textListSchema,
  decisions: textListSchema,
  risks: textListSchema,
  opportunities: textListSchema,
  interests: textListSchema,
  exclusions: textListSchema,
  languages: z.array(z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/)).min(1).max(12),
  onboardingComplete: z.boolean(),
});

export const briefDefinitionInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(2).max(80),
  kind: z.enum(["main", "company", "economy", "technology", "regulation", "creator", "local", "custom"]),
  instructions: z.string().max(2_000),
  cadence: z.enum(["daily", "weekly"]),
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  weekday: z.number().int().min(0).max(6).nullable(),
  timezone: z.string().min(3).max(80).refine(isValidIanaTimezone, "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm."),
  maxItems: z.number().int().min(0).max(5),
  briefDepth: z.enum(["short", "deep"]),
  relevanceThreshold: z.number().int().min(0).max(100),
  alertThreshold: z.number().int().min(0).max(100),
  onlyWhenChanged: z.boolean(),
  active: z.boolean(),
});

export const briefDefinitionDeleteSchema = z.object({
  id: z.string().uuid(),
});

export const watchInputSchema = z.object({
  eventId: z.string().uuid().nullable().optional(),
  kind: z.enum(["event", "topic"]),
  title: z.string().trim().min(2).max(220),
  queryText: z.string().max(500).nullable().optional(),
  rationale: z.string().max(1_000),
  triggerStatuses: z.array(z.enum(EVENT_STATUSES)).min(1).max(EVENT_STATUSES.length),
  onlyMaterialChange: z.boolean(),
});

export const watchMutationSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["pause", "resume", "delete"]),
});

export const sourcePolicyInputSchema = z.object({
  domain: z.string().trim().min(3).max(255),
  sourceName: z.string().trim().min(2).max(160),
  sourceKind: z.enum(SOURCE_KINDS),
  active: z.boolean(),
  blocked: z.boolean(),
  priority: z.enum(SOURCE_PRIORITIES),
  roles: z.array(z.enum(SOURCE_ROLES)).max(SOURCE_ROLES.length),
  topicFilter: z.string().max(500),
  verificationRequirement: z.enum(["none", "verify_material", "primary_only", "two_independent"]),
  frequency: z.enum(["all_relevant", "daily", "weekly", "material"]),
});

export const briefSourcePolicyInputSchema = z.object({
  briefDefinitionId: z.string().uuid(),
  domain: z.string().trim().min(3).max(255),
  active: z.boolean().nullable(),
  blocked: z.boolean().nullable(),
  priority: z.enum(SOURCE_PRIORITIES).nullable(),
  roles: z.array(z.enum(SOURCE_ROLES)).max(SOURCE_ROLES.length).nullable(),
  topicFilter: z.string().max(500).nullable(),
  verificationRequirement: z.enum(["none", "verify_material", "primary_only", "two_independent"]).nullable(),
  frequency: z.enum(["all_relevant", "daily", "weekly", "material"]).nullable(),
});

export const briefSourcePolicyDeleteSchema = z.object({
  briefDefinitionId: z.string().uuid(),
  domain: z.string().trim().min(3).max(255),
});

export const chatInputSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  conversationId: z.string().uuid().nullable().optional(),
  eventId: z.string().uuid().nullable().optional(),
});

export type ProfileContextInput = z.infer<typeof profileContextSchema>;
export type BriefDefinitionInput = z.infer<typeof briefDefinitionInputSchema>;
export type WatchInput = z.infer<typeof watchInputSchema>;
export type SourcePolicyInput = z.infer<typeof sourcePolicyInputSchema>;
