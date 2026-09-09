import type { ProfileSettings } from "@/lib/domain/types";
import { isValidIanaTimezone } from "@/lib/utils/date";

/**
 * A scheduler may wake up a few minutes after the requested time. Once the local
 * clock has passed the preference, the daily publication guard decides whether a
 * run is still needed for that local date.
 */
export function isBriefDue(
  settings: Pick<ProfileSettings, "dailyBriefTime" | "timezone">,
  now = new Date(),
): boolean {
  if (!isValidIanaTimezone(settings.timezone)) return false;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: settings.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const currentMinutes = Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
  const [scheduledHour, scheduledMinute] = settings.dailyBriefTime.split(":").map(Number);
  return Number.isFinite(currentMinutes) && currentMinutes >= scheduledHour * 60 + scheduledMinute;
}

export type BriefSchedule = {
  cadence: "daily" | "weekly";
  localTime: string;
  timezone: string;
  weekday: number | null;
};

/** Evaluate a stored brief definition without assuming a global server timezone. */
export function isBriefDefinitionDue(schedule: BriefSchedule, now = new Date()): boolean {
  if (!isValidIanaTimezone(schedule.timezone)) return false;
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const currentMinutes = Number(parts.get("hour")) * 60 + Number(parts.get("minute"));
  const [scheduledHour, scheduledMinute] = schedule.localTime.split(":").map(Number);
  if (!Number.isFinite(currentMinutes) || currentMinutes < scheduledHour * 60 + scheduledMinute) return false;
  if (schedule.cadence !== "weekly") return true;
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (!year || !month || !day || schedule.weekday === null) return false;
  const localWeekday = new Date(`${year}-${month}-${day}T00:00:00Z`).getUTCDay();
  return localWeekday === schedule.weekday;
}
