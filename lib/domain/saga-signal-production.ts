import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

/**
 * A deliberately narrow, explicit opt-in between Research and Studio.  A
 * qualified signal is not content and must never become a draft just because
 * it exists.  A workspace owner/editor has to save and enable this policy
 * before the Cron worker may create a private review item.
 */
export const SAGA_SIGNAL_PRODUCTION_STATES = [
  "queued",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled",
] as const;

export type SagaSignalProductionState = (typeof SAGA_SIGNAL_PRODUCTION_STATES)[number];

const timezoneSchema = z.string().trim().min(3).max(80).refine(
  isValidIanaTimezone,
  "Ange en giltig IANA-tidszon, till exempel Europe/Stockholm.",
);

/**
 * `enabled` defaults to false and the calendar is off by default.  The
 * resulting draft remains a private, human-review item; no policy in this
 * module can enable external delivery.
 */
export const sagaSignalProductionPolicyInputSchema = z.object({
  enabled: z.boolean().default(false),
  calendarEnabled: z.boolean().default(false),
  /** A future placement is required so a freshly-created review item is not placed in the past. */
  calendarDelayMinutes: z.number().int().min(15).max(43_200).default(1_440),
  timezone: timezoneSchema.default("Europe/Stockholm"),
  /** A small tenant-level throttle; the Cron worker enforces a stricter global cap too. */
  maxDraftsPerTick: z.number().int().min(1).max(5).default(2),
}).strict();

export type SagaSignalProductionPolicyInput = z.input<typeof sagaSignalProductionPolicyInputSchema>;

export const sagaSignalProductionPolicySchema = sagaSignalProductionPolicyInputSchema.extend({
  workspaceId: z.string().uuid(),
  revision: z.number().int().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SagaSignalProductionPolicy = z.infer<typeof sagaSignalProductionPolicySchema>;

export const sagaSignalProductionJobSchema = z.object({
  id: z.string().uuid(),
  signalCandidateId: z.string().uuid(),
  state: z.enum(SAGA_SIGNAL_PRODUCTION_STATES),
  policyRevision: z.number().int().min(1),
  calendarScheduledAt: z.string().min(1).nullable(),
  calendarTimezone: timezoneSchema,
  calendarWithheld: z.boolean(),
  draftId: z.string().uuid().nullable(),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(10),
  failureCode: z.string().nullable(),
  failureDetail: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SagaSignalProductionJob = z.infer<typeof sagaSignalProductionJobSchema>;

