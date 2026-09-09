import type { AdAutomationWorkflow } from "@/lib/domain/ad-automation";
import { localDateInTimezone, localDateTimeInTimezone } from "@/lib/utils/date";

export type AdAutomationOccurrence = {
  runAt: string;
  localDate: string;
  localTime: string;
};

/**
 * Pure, deterministic schedule projection used by the dedicated ad worker.
 * It has no persistence, AI, or provider side effect. Only `trigger:schedule`
 * can produce an occurrence.
 */
export function upcomingAdAutomationOccurrences(
  workflow: AdAutomationWorkflow,
  options: { now?: Date; horizonDays?: number } = {},
): AdAutomationOccurrence[] {
  if (workflow.trigger.kind !== "schedule" || workflow.schedule.mode === "manual") return [];
  const now = options.now ?? new Date();
  const horizonDays = Math.max(1, Math.min(options.horizonDays ?? 14, 31));
  const schedule = workflow.schedule;
  const startDate = maxDate(localDateInTimezone(schedule.timezone, now), schedule.startsOn);
  const horizonEnd = addCalendarDays(localDateInTimezone(schedule.timezone, new Date(now.getTime() + horizonDays * 86_400_000)), 1);
  const endDate = minDate(horizonEnd, schedule.endsOn);
  if (startDate > endDate) return [];

  const weeklyDays = schedule.mode === "weekly_count"
    ? resolveWeeklyDays(schedule.weeklyCount ?? 1, schedule.weekdays)
    : [];
  const cron = schedule.mode === "cron" && schedule.cronExpression
    ? parseSimpleCron(schedule.cronExpression)
    : null;
  if (schedule.mode === "cron" && !cron) return [];

  const occurrences: AdAutomationOccurrence[] = [];
  for (let date = startDate; date <= endDate; date = addCalendarDays(date, 1)) {
    const weekday = weekdayForDate(date);
    const times = schedule.mode === "weekly_count"
      ? weeklyTimesForDate(schedule.localTimes, weeklyDays, weekday)
      : cron && cron.weekdays.includes(weekday) ? [cron.time] : [];
    for (const time of times) {
      const instant = zonedDateTimeToUtc(date, time, schedule.timezone);
      if (instant && instant.getTime() > now.getTime()) {
        occurrences.push({ runAt: instant.toISOString(), localDate: date, localTime: time });
      }
    }
  }
  return occurrences.sort((left, right) => left.runAt.localeCompare(right.runAt));
}

function resolveWeeklyDays(count: number, explicitDays: number[]): number[] {
  if (explicitDays.length) return [...new Set(explicitDays)].sort((left, right) => left - right);
  const preferred: Record<number, number[]> = {
    1: [2],
    2: [1, 4],
    3: [1, 3, 5],
    4: [1, 2, 4, 5],
    5: [1, 2, 3, 4, 5],
    6: [0, 1, 2, 3, 4, 5],
    7: [0, 1, 2, 3, 4, 5, 6],
  };
  return preferred[Math.max(1, Math.min(count, 7))] ?? [2];
}

function weeklyTimesForDate(localTimes: string[], weekdays: number[], weekday: number): string[] {
  const index = weekdays.indexOf(weekday);
  if (index < 0) return [];
  const time = localTimes.length === 1 ? localTimes[0] : localTimes[index];
  return time ? [time] : [];
}

function parseSimpleCron(expression: string): { time: string; weekdays: number[] } | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") return null;
  const minute = Number(fields[0]);
  const hour = Number(fields[1]);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59 || !Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  const weekdays = fields[4] === "*"
    ? [0, 1, 2, 3, 4, 5, 6]
    : fields[4].split(",").map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  if (!weekdays.length || new Set(weekdays).size !== weekdays.length) return null;
  return { time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, weekdays };
}

function zonedDateTimeToUtc(localDate: string, localTime: string, timezone: string): Date | null {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const desiredEpoch = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = new Date(desiredEpoch);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localDateTimeInTimezone(candidate, timezone);
    if (!actual) return null;
    const [actualYear, actualMonth, actualDay] = actual.date.split("-").map(Number);
    const [actualHour, actualMinute] = actual.time.split(":").map(Number);
    const delta = desiredEpoch - Date.UTC(actualYear, actualMonth - 1, actualDay, actualHour, actualMinute);
    if (delta === 0) break;
    candidate = new Date(candidate.getTime() + delta);
  }
  const verified = localDateTimeInTimezone(candidate, timezone);
  return verified?.date === localDate && verified.time === localTime ? candidate : null;
}

function weekdayForDate(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function addCalendarDays(date: string, days: number): string {
  const instance = new Date(`${date}T00:00:00Z`);
  instance.setUTCDate(instance.getUTCDate() + days);
  return instance.toISOString().slice(0, 10);
}

function maxDate(left: string, right: string | null): string {
  return right && right > left ? right : left;
}

function minDate(left: string, right: string | null): string {
  return right && right < left ? right : left;
}
