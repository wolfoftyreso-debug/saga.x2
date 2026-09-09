import { z } from "zod";
import { isValidIanaTimezone } from "@/lib/utils/date";

/**
 * These controls are intentionally separate from the relevance profile. The
 * relevance sliders decide whether an event earns a place; flow controls
 * decide which independently sourced reference layers are produced at all and
 * when an already-qualified direct alert may be delivered.
 */
const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Ange tid som HH:MM.");

export const flowControlsSchema = z.object({
  modules: z.object({
    /** A three-lens, sourced state assessment. */
    worldPulse: z.boolean(),
    /** A recap assembled only from already persisted brief items. */
    weeklyRecap: z.boolean(),
    /** Official AI roadmap, concrete opportunity and dated-context radar. */
    strategicRadar: z.boolean(),
    /** Server-side market/index/FX snapshot. */
    marketSnapshot: z.boolean(),
    /** Named-company quotes within the market snapshot; never a synthetic SpaceX quote. */
    companyFocus: z.boolean(),
  }),
  alerts: z.object({
    /** Direct alerts are delivered to the in-app conversation, never as investment advice. */
    enabled: z.boolean(),
    quietHours: z.object({
      enabled: z.boolean(),
      start: timeOfDaySchema,
      end: timeOfDaySchema,
      /** A true systemic override may pass quiet hours only when this is enabled. */
      allowSystemicDuringQuietHours: z.boolean(),
    }).superRefine((quietHours, context) => {
      if (quietHours.enabled && quietHours.start === quietHours.end) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["end"],
          message: "Tystnadens start och slut kan inte vara samma tid.",
        });
      }
    }),
  }),
});

export type FlowControls = z.infer<typeof flowControlsSchema>;

/**
 * Existing behaviour remains the default. A user must deliberately switch a
 * layer off; an absent row after deployment therefore never changes a brief.
 */
export const DEFAULT_FLOW_CONTROLS: FlowControls = {
  modules: {
    worldPulse: true,
    weeklyRecap: true,
    strategicRadar: true,
    marketSnapshot: true,
    companyFocus: true,
  },
  alerts: {
    enabled: true,
    quietHours: {
      enabled: false,
      start: "22:00",
      end: "07:00",
      allowSystemicDuringQuietHours: true,
    },
  },
};

/** A serialisable UI/API view with the last durable write, when available. */
export type FlowControlsView = FlowControls & {
  updatedAt: string | null;
};

/** The runner consumes this resolved shape so a secondary brief cannot accidentally inherit primary-only reference layers. */
export type ResolvedPrimaryBriefModules = FlowControls["modules"];

export function defaultFlowControlsView(): FlowControlsView {
  return { ...DEFAULT_FLOW_CONTROLS, updatedAt: null };
}

export function resolvePrimaryBriefModules(
  isPrimary: boolean,
  controls: Pick<FlowControls, "modules">,
): ResolvedPrimaryBriefModules {
  if (!isPrimary) {
    return {
      worldPulse: false,
      weeklyRecap: false,
      strategicRadar: false,
      marketSnapshot: false,
      companyFocus: false,
    };
  }
  return {
    worldPulse: controls.modules.worldPulse,
    weeklyRecap: controls.modules.weeklyRecap,
    strategicRadar: controls.modules.strategicRadar,
    marketSnapshot: controls.modules.marketSnapshot,
    // A company panel depends on the same server-side market snapshot; it
    // cannot turn a disabled market module back on by itself.
    companyFocus: controls.modules.marketSnapshot && controls.modules.companyFocus,
  };
}

/**
 * Determines whether the local time falls inside a half-open quiet interval.
 * An interval can cross midnight (for example 22:00–07:00). Invalid timezone
 * input fails open rather than silently withholding a real alert; the profile
 * schema prevents invalid zones from being persisted in the first place.
 */
export function isWithinQuietHours(
  controls: Pick<FlowControls, "alerts">,
  timezone: string,
  now = new Date(),
): boolean {
  const quietHours = controls.alerts.quietHours;
  if (!quietHours.enabled || !isValidIanaTimezone(timezone)) return false;
  const currentMinutes = localMinutes(now, timezone);
  if (currentMinutes === null) return false;
  const start = minutesFromTime(quietHours.start);
  const end = minutesFromTime(quietHours.end);
  if (start === end) return false;
  return start < end
    ? currentMinutes >= start && currentMinutes < end
    : currentMinutes >= start || currentMinutes < end;
}

/**
 * This is the delivery gate, not the relevance gate. A high-score event can
 * still be stored and appear in its brief while its interruption is delayed.
 */
export function canDeliverDirectAlertNow(input: {
  controls: Pick<FlowControls, "alerts">;
  timezone: string;
  systemicOverride: boolean;
  now?: Date;
}): boolean {
  if (!input.controls.alerts.enabled) return false;
  if (!isWithinQuietHours(input.controls, input.timezone, input.now)) return true;
  return input.systemicOverride && input.controls.alerts.quietHours.allowSystemicDuringQuietHours;
}

function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function localMinutes(now: Date, timezone: string): number | null {
  try {
    const parts = new Map(new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now).map((part) => [part.type, part.value]));
    const hour = Number(parts.get("hour"));
    const minute = Number(parts.get("minute"));
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  } catch {
    return null;
  }
}
