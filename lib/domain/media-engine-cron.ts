/**
 * Pure, bounded cron support shared by rule configuration and the worker.
 * We intentionally implement only ordinary five-field cron syntax so the UI
 * never implies support for nonstandard L/W/# expressions.
 */
export class MediaEngineCronError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaEngineCronError";
  }
}

export type MediaEngineSchedule = {
  active: boolean;
  scheduleMode: "threshold" | "cron";
  cadence: "continuous" | "hourly" | "daily" | "weekly" | "cron";
  cronExpression: string | null;
};

type CronField = { values: Set<number>; wildcard: boolean };
type CronMatcher = { minute: CronField; hour: CronField; dayOfMonth: CronField; month: CronField; dayOfWeek: CronField };

export function nextMediaEngineRunAt(schedule: MediaEngineSchedule, from: Date, timezone = "Europe/Stockholm"): string | null {
  if (!schedule.active) return null;
  if (schedule.scheduleMode === "cron" || schedule.cadence === "cron") {
    if (!schedule.cronExpression) {
      throw new MediaEngineCronError("Cron-regeln saknar ett giltigt femfältsuttryck. Ange exempelvis `0 9 * * 1-5`.");
    }
    return nextCronOccurrence(schedule.cronExpression, from, timezone);
  }
  const cadenceHours: Record<Exclude<MediaEngineSchedule["cadence"], "cron">, number> = {
    continuous: 1,
    hourly: 1,
    daily: 24,
    weekly: 24 * 7,
  };
  return new Date(from.getTime() + cadenceHours[schedule.cadence] * 60 * 60 * 1_000).toISOString();
}

/**
 * Supports `minute hour day month weekday`, plus `*`, numbers, comma lists,
 * ranges and slash steps. All output is UTC ISO while matching in the tenant
 * time zone, including CET/CEST.
 */
export function nextCronOccurrence(expression: string, from: Date, timezone = "Europe/Stockholm"): string {
  const matcher = parseFiveFieldCron(expression);
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    });
  } catch {
    throw new MediaEngineCronError(`Tidszonen '${timezone}' stöds inte för cron-regeln.`);
  }
  const maxIterations = 366 * 24 * 60 + 2;
  for (let index = 0; index < maxIterations; index += 1) {
    const candidate = new Date(start.getTime() + index * 60_000);
    if (matchesCron(matcher, zonedCronParts(formatter, candidate))) return candidate.toISOString();
  }
  throw new MediaEngineCronError("Cron-uttrycket gav ingen körning under nästa år. Kontrollera dag, månad och veckodag.");
}

export function isSupportedFiveFieldCron(expression: string): boolean {
  try {
    parseFiveFieldCron(expression);
    return true;
  } catch {
    return false;
  }
}

function parseFiveFieldCron(expression: string): CronMatcher {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new MediaEngineCronError("Cron måste ha fem fält: minut timme dag månad veckodag. Exempel: `0 9 * * 1-5`.");
  }
  return {
    minute: parseCronField(fields[0], 0, 59),
    hour: parseCronField(fields[1], 0, 23),
    dayOfMonth: parseCronField(fields[2], 1, 31),
    month: parseCronField(fields[3], 1, 12),
    dayOfWeek: parseCronField(fields[4], 0, 7, true),
  };
}

function parseCronField(raw: string, minimum: number, maximum: number, weekday = false): CronField {
  const value = raw.trim();
  if (!value) throw new MediaEngineCronError("Cron innehåller ett tomt fält.");
  const values = new Set<number>();
  for (const segment of value.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(segment);
    if (!match) throw new MediaEngineCronError(`Cron-fältet '${segment}' använder en syntax som inte stöds. Använd *, siffror, listor, intervall eller steg.`);
    const step = match[2] ? Number(match[2]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) throw new MediaEngineCronError("Cron-steg måste ligga inom fältets intervall.");
    const [start, end] = match[1] === "*"
      ? [minimum, maximum]
      : match[1].includes("-")
        ? match[1].split("-").map(Number) as [number, number]
        : [Number(match[1]), Number(match[1])];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) {
      throw new MediaEngineCronError("Cron-värdet ligger utanför giltigt intervall.");
    }
    for (let item = start; item <= end; item += step) values.add(weekday && item === 7 ? 0 : item);
  }
  return { values, wildcard: value === "*" };
}

function zonedCronParts(formatter: Intl.DateTimeFormat, date: Date): { minute: number; hour: number; dayOfMonth: number; month: number; dayOfWeek: number } {
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[parts.get("weekday") ?? ""];
  return {
    minute: Number(parts.get("minute")),
    hour: Number(parts.get("hour")),
    dayOfMonth: Number(parts.get("day")),
    month: Number(parts.get("month")),
    dayOfWeek: Number.isInteger(weekday) ? weekday : -1,
  };
}

function matchesCron(matcher: CronMatcher, parts: ReturnType<typeof zonedCronParts>): boolean {
  if (!matcher.minute.values.has(parts.minute) || !matcher.hour.values.has(parts.hour) || !matcher.month.values.has(parts.month)) return false;
  const dayOfMonthMatches = matcher.dayOfMonth.values.has(parts.dayOfMonth);
  const dayOfWeekMatches = matcher.dayOfWeek.values.has(parts.dayOfWeek);
  const dayMatches = matcher.dayOfMonth.wildcard && matcher.dayOfWeek.wildcard
    ? true
    : matcher.dayOfMonth.wildcard
      ? dayOfWeekMatches
      : matcher.dayOfWeek.wildcard
        ? dayOfMonthMatches
        : dayOfMonthMatches || dayOfWeekMatches;
  return dayMatches;
}
