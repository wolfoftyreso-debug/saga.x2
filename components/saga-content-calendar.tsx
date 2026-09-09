"use client";
/* eslint-disable @next/next/no-img-element */

import type { CSSProperties, DragEvent, FormEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./saga-content-calendar.module.css";

type CalendarMode = "day" | "week" | "month";
type CalendarChannel = "instagram" | "facebook_page" | "linkedin" | "newsletter";

export type SagaCalendarEntry = {
  id: string;
  kind: "draft" | "automation_job" | "plan_slot";
  title: string;
  status: string;
  channels: readonly CalendarChannel[];
  startsAt: string;
  /** Placement in the timezone currently used by the calendar view. */
  localDate: string;
  localTime: string;
  /**
   * The draft's own editorial schedule. A calendar can be displayed in a
   * different workspace timezone, so moves must keep these fields together
   * with their timezone rather than treating the visible placement as the
   * source of truth.
   */
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  scheduleTimezone: string;
  /** Present only for a read-only quarterly plan slot, never a draft schedule. */
  plannedLocalDate?: string;
  plannedLocalTime?: string;
  editable: boolean;
  thumbnail: { assetUrl: string; altText: string } | null;
  excerpt: string;
  revision: number | null;
  draftId: string | null;
  automationRuleId: string | null;
  /** A bounded, browser-only planning card. It never has a persisted draft. */
  localOnly?: boolean;
};

export type SagaCalendarData = {
  timezone: string;
  entries: SagaCalendarEntry[];
};

type UnscheduledDraft = {
  id: string;
  title: string;
  status: string;
  channels: readonly CalendarChannel[];
  thumbnail: SagaCalendarEntry["thumbnail"];
  updatedAt: string;
};

type SchedulePatch = {
  scheduledAt: string;
  scheduledLocalDate: string;
  scheduledLocalTime: string;
  timezone: string;
  expectedRevision?: number;
};

type TimeBounds = { startHour: number; endHour: number };
type TimedPlacement = { entry: SagaCalendarEntry; lane: number; laneCount: number; top: number; height: number };
type LocalScheduleOverride = Pick<SagaCalendarEntry, "startsAt" | "localDate" | "localTime">
  & Partial<Pick<SagaCalendarEntry, "scheduledLocalDate" | "scheduledLocalTime" | "scheduleTimezone">>;
type ScheduleFeedbackKind = "pending" | "success" | "error" | "conflict";
type ScheduleFeedback = { entryId: string; kind: ScheduleFeedbackKind; message: string };

const CHANNEL_LABELS: Record<CalendarChannel, string> = {
  instagram: "Instagram",
  facebook_page: "Facebook",
  linkedin: "LinkedIn",
  newsletter: "Nyhetsbrev",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Utkast",
  in_review: "Väntar på granskning",
  approved: "Godkänd",
  // A time in SAGA is editorial planning only. It is not a provider action.
  scheduled: "Planerad i SAGA",
  publishing: "Extern leverans pågår",
  // `published` is a durable terminal state. The calendar deliberately calls
  // it a confirmed delivery rather than promising that a post is visible in a
  // particular external surface from this view.
  published: "Extern leverans bekräftad",
  failed: "Extern leverans misslyckades",
  cancelled: "Avbruten",
  planned_activity: "Planerad aktivitet",
};

const KNOWN_CHANNELS = new Set<CalendarChannel>(["instagram", "facebook_page", "linkedin", "newsletter"]);
const MINUTE_HEIGHT = 1.14;
const MINUTES_PER_CARD = 52;
const PRIVATE_DRAFT_ASSET_PATH = /^\/api\/content\/drafts\/[^/?#]+\/media\/[^/?#]+\/asset$/;
const TEST_PLAN_TIMEZONE = "Europe/Stockholm";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableText(value: unknown): string | null {
  const result = text(value).trim();
  return result ? result : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function thumbnailFrom(value: unknown): SagaCalendarEntry["thumbnail"] {
  if (!isRecord(value)) return null;
  // Calendar media must stay behind the authenticated same-origin media
  // route. Reject raw Blob URLs, external images and query-signed URLs even
  // if an upstream response is malformed.
  const candidate = nullableText(value.assetUrl ?? value.asset_url);
  const assetUrl = candidate && PRIVATE_DRAFT_ASSET_PATH.test(candidate) ? candidate : null;
  if (!assetUrl) return null;
  return { assetUrl, altText: text(value.altText ?? value.alt_text, "Bild till utkastet") };
}

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`));
}

function validTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function supportedTimezone(value: string, fallback: string): string {
  try {
    Intl.DateTimeFormat("sv-SE", { timeZone: value }).format();
    return value;
  } catch {
    return fallback;
  }
}

function localParts(value: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Maps the calendar endpoint without inventing content. Older safe calendar
 * responses stay readable while the richer calendar payload rolls out.
 */
export function parseCalendarPayload(payload: unknown, fallbackTimezone = "UTC"): SagaCalendarData {
  const top = isRecord(payload) && isRecord(payload.calendar) ? payload.calendar : payload;
  if (!isRecord(top)) return { timezone: fallbackTimezone, entries: [] };
  const timezone = supportedTimezone(text(top.timezone, fallbackTimezone), fallbackTimezone);
  const values = Array.isArray(top.entries) ? top.entries : [];
  const entries = values.flatMap((value, index): SagaCalendarEntry[] => {
    if (!isRecord(value)) return [];
    const startsAt = text(value.startsAt ?? value.startAt ?? value.scheduledAt ?? value.scheduled_at);
    const start = new Date(startsAt);
    if (!startsAt || Number.isNaN(start.getTime())) return [];
    const kind = value.kind === "automation_job" || value.kind === "plan_slot" ? value.kind : "draft";
    const isPlanSlot = kind === "plan_slot";
    const inferred = localParts(start, timezone);
    const scheduleTimezone = supportedTimezone(text(value.timezone, timezone), timezone);
    const scheduledInferred = localParts(start, scheduleTimezone);
    const localDate = validDate(text(value.localDate ?? value.scheduledLocalDate ?? value.scheduled_local_date))
      ? text(value.localDate ?? value.scheduledLocalDate ?? value.scheduled_local_date)
      : inferred.date;
    const localTime = validTime(text(value.localTime ?? value.scheduledLocalTime ?? value.scheduled_local_time))
      ? text(value.localTime ?? value.scheduledLocalTime ?? value.scheduled_local_time)
      : inferred.time;
    const plannedLocalDate = validDate(text(value.plannedLocalDate ?? value.planned_local_date))
      ? text(value.plannedLocalDate ?? value.planned_local_date)
      : null;
    const plannedLocalTime = validTime(text(value.plannedLocalTime ?? value.planned_local_time))
      ? text(value.plannedLocalTime ?? value.planned_local_time)
      : null;
    const scheduledLocalDate = validDate(text(value.scheduledLocalDate ?? value.scheduled_local_date))
      ? text(value.scheduledLocalDate ?? value.scheduled_local_date)
      : plannedLocalDate ?? scheduledInferred.date;
    const scheduledLocalTime = validTime(text(value.scheduledLocalTime ?? value.scheduled_local_time))
      ? text(value.scheduledLocalTime ?? value.scheduled_local_time)
      : plannedLocalTime ?? scheduledInferred.time;
    const draftId = nullableText(value.draftId ?? value.draft_id);
    const rawChannels = value.channels ?? value.channelKinds ?? value.channel_kinds;
    const channels = Array.isArray(rawChannels)
      ? rawChannels.filter((channel): channel is CalendarChannel => typeof channel === "string" && KNOWN_CHANNELS.has(channel as CalendarChannel))
      : [];
    return [{
      id: text(value.id, `calendar-${index}`),
      kind,
      title: text(value.title, "Namnlöst utkast"),
      status: isPlanSlot ? "planned_activity" : text(value.status, "scheduled"),
      channels,
      startsAt,
      localDate,
      localTime,
      scheduledLocalDate,
      scheduledLocalTime,
      scheduleTimezone,
      plannedLocalDate: plannedLocalDate ?? undefined,
      plannedLocalTime: plannedLocalTime ?? undefined,
      // A plan slot may link to a real private draft, but is never a calendar
      // schedule and must never reach the draft PATCH move endpoint.
      editable: isPlanSlot ? false : typeof value.editable === "boolean" ? value.editable : Boolean(draftId),
      thumbnail: thumbnailFrom(value.thumbnail),
      excerpt: text(value.excerpt),
      revision: positiveInteger(value.revision),
      draftId,
      automationRuleId: nullableText(value.automationRuleId ?? value.automation_rule_id),
    }];
  }).sort((first, second) => first.localDate.localeCompare(second.localDate) || first.localTime.localeCompare(second.localTime));
  return { timezone, entries };
}

/** Reads actual saved, unscheduled drafts for the calendar's planning tray. */
export function parseUnscheduledDrafts(payload: unknown): UnscheduledDraft[] {
  const top = isRecord(payload) ? payload : {};
  const values = Array.isArray(top.drafts) ? top.drafts : Array.isArray(top.items) ? top.items : [];
  return values.flatMap((value): UnscheduledDraft[] => {
    if (!isRecord(value)) return [];
    if (nullableText(value.scheduledAt ?? value.scheduled_at)) return [];
    const id = nullableText(value.id);
    if (!id) return [];
    const rawChannels = value.channels ?? value.channelKinds ?? value.channel_kinds;
    const channels = Array.isArray(rawChannels)
      ? rawChannels.filter((channel): channel is CalendarChannel => typeof channel === "string" && KNOWN_CHANNELS.has(channel as CalendarChannel))
      : [];
    const rawMedia = Array.isArray(value.media) ? value.media : [];
    const firstReadyMedia = rawMedia.find((media) => isRecord(media) && text(media.processingStatus ?? media.status, "ready") !== "failed");
    return [{
      id,
      title: text(value.title ?? value.headline, "Namnlöst utkast"),
      status: text(value.status, "draft"),
      channels,
      thumbnail: firstReadyMedia && isRecord(firstReadyMedia)
        ? thumbnailFrom({ assetUrl: firstReadyMedia.assetUrl ?? firstReadyMedia.url ?? firstReadyMedia.publicUrl, altText: firstReadyMedia.altText ?? firstReadyMedia.alt })
        : null,
      updatedAt: text(value.updatedAt ?? value.updated_at),
    }];
  });
}

function toUtcDate(value: string): Date {
  return new Date(`${value}T12:00:00Z`);
}

export function addCalendarDays(value: string, days: number): string {
  const date = toUtcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Returns Monday through Sunday for the date's local planning week. */
export function calendarWeek(value: string): string[] {
  const day = toUtcDate(value).getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const start = addCalendarDays(value, mondayOffset);
  return Array.from({ length: 7 }, (_, index) => addCalendarDays(start, index));
}

function monthGrid(value: string): string[] {
  const date = toUtcDate(value);
  const first = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const week = calendarWeek(first);
  return Array.from({ length: 42 }, (_, index) => addCalendarDays(week[0], index));
}

function rangeFor(mode: CalendarMode, anchor: string): { from: string; to: string } {
  if (mode === "day") return { from: anchor, to: anchor };
  const values = mode === "month" ? monthGrid(anchor) : calendarWeek(anchor);
  return { from: values[0], to: values.at(-1)! };
}

function moveAnchor(anchor: string, mode: CalendarMode, direction: -1 | 1): string {
  if (mode === "day") return addCalendarDays(anchor, direction);
  if (mode === "week") return addCalendarDays(anchor, direction * 7);
  const date = toUtcDate(anchor);
  date.setUTCMonth(date.getUTCMonth() + direction);
  return date.toISOString().slice(0, 10);
}

function startOfCurrentMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function timeToMinutes(value: string): number {
  if (!validTime(value)) return 0;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToTime(value: number): string {
  const safe = Math.max(0, Math.min(23 * 60 + 59, value));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function localHourRange(entries: SagaCalendarEntry[]): TimeBounds {
  if (!entries.length) return { startHour: 7, endHour: 20 };
  const minutes = entries.map((entry) => timeToMinutes(entry.localTime));
  const earliest = Math.min(...minutes);
  const latest = Math.max(...minutes);
  return {
    startHour: Math.max(0, Math.min(7, Math.floor(earliest / 60) - 1)),
    endHour: Math.min(24, Math.max(20, Math.ceil((latest + MINUTES_PER_CARD) / 60) + 1)),
  };
}

/** Position one event in a minute-accurate planning grid. */
export function eventPosition(entry: Pick<SagaCalendarEntry, "localTime">, startHour: number, minuteHeight = MINUTE_HEIGHT) {
  const minutes = timeToMinutes(entry.localTime);
  return {
    top: Math.max(0, (minutes - startHour * 60) * minuteHeight),
    height: Math.max(52, MINUTES_PER_CARD * minuteHeight),
  };
}

export function calendarPlacements(entries: SagaCalendarEntry[], startHour: number): TimedPlacement[] {
  const byDate = new Map<string, SagaCalendarEntry[]>();
  for (const entry of entries) byDate.set(entry.localDate, [...(byDate.get(entry.localDate) ?? []), entry]);
  const results: TimedPlacement[] = [];
  for (const dayEntries of byDate.values()) {
    const ordered = [...dayEntries].sort((first, second) => timeToMinutes(first.localTime) - timeToMinutes(second.localTime));
    let group: SagaCalendarEntry[] = [];
    let groupEnd = -1;
    const flushGroup = () => {
      if (!group.length) return;
      const laneEnds: number[] = [];
      const assigned = group.map((entry) => {
        const start = timeToMinutes(entry.localTime);
        let lane = laneEnds.findIndex((end) => end <= start);
        if (lane === -1) lane = laneEnds.length;
        laneEnds[lane] = start + MINUTES_PER_CARD;
        return { entry, lane };
      });
      const laneCount = Math.max(1, laneEnds.length);
      for (const assignment of assigned) results.push({ ...assignment, laneCount, ...eventPosition(assignment.entry, startHour) });
      group = [];
      groupEnd = -1;
    };
    for (const entry of ordered) {
      const start = timeToMinutes(entry.localTime);
      if (group.length && start >= groupEnd) flushGroup();
      group.push(entry);
      groupEnd = Math.max(groupEnd, start + MINUTES_PER_CARD);
    }
    flushGroup();
  }
  return results;
}

function zonedPartsAsUtc(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
}

/**
 * Converts a user-entered wall-clock time into an ISO instant in an IANA
 * timezone. The verification deliberately rejects nonexistent DST times.
 */
export function localDateTimeToUtcIso(localDate: string, localTime: string, timezone: string): string {
  if (!validDate(localDate) || !validTime(localTime)) throw new Error("Välj ett giltigt datum och klockslag.");
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  for (let index = 0; index < 4; index += 1) {
    const offset = zonedPartsAsUtc(new Date(guess), timezone) - guess;
    const adjusted = wanted - offset;
    if (adjusted === guess) break;
    guess = adjusted;
  }
  const result = new Date(guess);
  const verified = localParts(result, timezone);
  if (verified.date !== localDate || verified.time !== localTime) {
    throw new Error("Det klockslaget finns inte i vald tidszon. Välj en annan tid.");
  }
  return result.toISOString();
}

/** The PATCH contract is deliberately complete: no browser-side status change. */
export function schedulePatchFor(localDate: string, localTime: string, timezone: string, expectedRevision?: number): SchedulePatch {
  return {
    scheduledAt: localDateTimeToUtcIso(localDate, localTime, timezone),
    scheduledLocalDate: localDate,
    scheduledLocalTime: localTime,
    timezone,
    ...(typeof expectedRevision === "number" ? { expectedRevision } : {}),
  };
}

/**
 * A drag position belongs to the timezone used to draw the calendar. Convert
 * it to the draft's own editorial schedule before issuing the protected
 * schedule PATCH, so changing a calendar view cannot silently change an
 * instant by a timezone offset.
 */
export function scheduleFieldsForCalendarPlacement(
  localDate: string,
  localTime: string,
  calendarTimezone: string,
  scheduleTimezone: string,
): Pick<SagaCalendarEntry, "scheduledLocalDate" | "scheduledLocalTime"> {
  const placement = localDateTimeToUtcIso(localDate, localTime, calendarTimezone);
  const scheduled = localParts(new Date(placement), scheduleTimezone);
  return { scheduledLocalDate: scheduled.date, scheduledLocalTime: scheduled.time };
}

function dateLabel(value: string, options: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" }) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", ...options }).format(toUtcDate(value));
}

function weekHeaderLabel(days: string[]) {
  const first = dateLabel(days[0], { day: "numeric", month: "short" });
  const last = dateLabel(days.at(-1)!, { day: "numeric", month: "short", year: "numeric" });
  return `${first}–${last}`;
}

function modeLabel(mode: CalendarMode) {
  return mode === "day" ? "Dag" : mode === "week" ? "Vecka" : "Månad";
}

export function calendarStatusLabel(status: string) {
  // Never turn an unknown persisted state into a reassuring planning state.
  // The inspector can still be opened, but the user must see that its status
  // needs attention rather than infer that it is safely planned.
  return STATUS_LABELS[status] ?? "Okänt statusläge";
}

function nonEditableScheduleMessage(entry: SagaCalendarEntry) {
  if (entry.kind === "plan_slot") return "Det här är en planerad aktivitet i 13-veckorsplanen, inte ett utkast med tid i kalendern. Öppna det privata utkastet för granskning; en senare, separat kalenderåtgärd krävs för att ge det en tid i SAGA.";
  if (entry.kind === "automation_job") return "Den här punkten kommer från en automation. Öppna automationen för att ändra dess grundschema.";
  if (entry.status === "publishing") return "Extern leverans pågår och tiden kan inte ändras just nu.";
  if (entry.status === "published") return "Den här externa leveransen är avslutad och är låst i kalendern. Öppna utkastet om du vill skapa en ny version.";
  if (entry.status === "failed") return "Den externa leveransen behöver ses över i utkastet innan en ny tid sätts.";
  if (entry.status === "cancelled") return "Det här utkastet är avbrutet. Öppna det om du vill återuppta och planera det igen.";
  return "Den här kalenderpunkten kan inte flyttas från kalendern.";
}

function channelLabel(channel: CalendarChannel) {
  return CHANNEL_LABELS[channel];
}

function calendarCardDomId(entryId: string) {
  return `calendar-entry-${entryId}`;
}

/** Keeps infrastructure and provider details out of the editor-facing plan. */
export function calendarErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const code = text(payload.code).toLowerCase();
  const message = text(payload.error).trim();
  // Infrastructure details belong in the deployment console, not in a
  // publisher's planning surface. Keep the state actionable without exposing
  // a storage/provider implementation to the editor.
  if (/configuration|\b(neon|supabase|postgres(?:ql)?|database|vercel|blob|storage)\b/i.test(`${code} ${message}`)) {
    return "Arbetsytan behöver vara redo innan sparat innehåll kan visas.";
  }
  return message || fallback;
}

function responseMessage(payload: unknown, fallback: string): string {
  return calendarErrorMessage(payload, fallback);
}

async function jsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function todayInTimezone(timezone: string): string {
  return localParts(new Date(), timezone).date;
}

/**
 * Only a missing workspace configuration gets a browser-only test plan. An
 * authentication failure, access denial or a genuine data failure must stay
 * visible instead of being masked with example content.
 */
export function isCalendarConfigurationRequired(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const code = text(payload.code).trim().toLowerCase();
  return code === "configuration_required" || code === "configuration_missing" || code === "database_configuration_invalid";
}

/**
 * A compact, explicitly non-persistent plan for trying the calendar before a
 * workspace is connected. These cards never contain draft IDs, media URLs or
 * server data, and every mutation stays in React state in this tab only.
 */
export function createCalendarTestPlan(now = new Date(), timezone = TEST_PLAN_TIMEZONE): SagaCalendarData {
  const monday = calendarWeek(localParts(now, timezone).date)[0];
  const entry = (id: string, dayOffset: number, localTime: string, title: string, channels: CalendarChannel[], excerpt: string): SagaCalendarEntry => {
    const localDate = addCalendarDays(monday, dayOffset);
    return {
      id: `test-plan:${id}`,
      kind: "draft",
      title,
      status: "scheduled",
      channels,
      startsAt: localDateTimeToUtcIso(localDate, localTime, timezone),
      localDate,
      localTime,
      scheduledLocalDate: localDate,
      scheduledLocalTime: localTime,
      scheduleTimezone: timezone,
      editable: true,
      thumbnail: null,
      excerpt,
      revision: null,
      draftId: null,
      automationRuleId: null,
      localOnly: true,
    };
  };

  return {
    timezone,
    entries: [
      entry("time-back", 0, "09:30", "System som ger människor tid tillbaka", ["linkedin"], "En testpost om varför välbyggda system ska frigöra tid för livet, inte skapa mer administration."),
      entry("room-for-life", 1, "12:15", "Teknik ska skapa mer plats för livet", ["instagram"], "En lugnare, visuell testpost med natur, arbete och återhämtning som riktning."),
      entry("good-systems", 2, "08:00", "Ett bra system känns i vardagen", ["newsletter"], "Ett nyhetsbrevsutkast om lösningar som bär vardagen utan att kräva ständig handpåläggning."),
      entry("human-control", 3, "16:30", "Från signal till berättelse — med mänsklig kontroll", ["facebook_page"], "En testpost om automation som är styrbar, lugn och tydlig hela vägen till en genomgången plan."),
      entry("build-once", 5, "10:00", "Bygg det en gång. Låt systemet bära resten.", ["linkedin", "instagram"], "En kanalvariant för att prova hur samma tanke kan få olika plats i planen."),
    ],
  };
}

export function applyCalendarTestPlanOverrides(
  calendar: SagaCalendarData,
  overrides: Readonly<Record<string, LocalScheduleOverride>>,
): SagaCalendarData {
  return {
    ...calendar,
    entries: calendar.entries.map((entry) => {
      const override = entry.localOnly ? overrides[entry.id] : undefined;
      return override ? {
        ...entry,
        ...override,
        scheduledLocalDate: override.scheduledLocalDate ?? override.localDate,
        scheduledLocalTime: override.scheduledLocalTime ?? override.localTime,
        scheduleTimezone: override.scheduleTimezone ?? entry.scheduleTimezone,
      } : entry;
    }).sort((first, second) => first.localDate.localeCompare(second.localDate) || first.localTime.localeCompare(second.localTime)),
  };
}

/**
 * Calendar space changes when the shell rail opens, closes or overlays. Watch
 * the actual container rather than using the browser viewport as a proxy.
 */
function useCompactCalendarLayout() {
  const calendarRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [inspectorDrawer, setInspectorDrawer] = useState(false);

  useEffect(() => {
    const target = calendarRef.current;
    if (!target) return;
    const update = (width: number) => {
      setCompact(width < 720);
      // At this width the weekly canvas and a useful inspector cannot sit
      // side-by-side. A selected card therefore opens an immediate drawer
      // instead of placing its controls below the entire day grid.
      setInspectorDrawer(width < 1180);
    };
    update(target.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return { calendarRef, compact, inspectorDrawer };
}

export function SagaContentCalendar() {
  // The first request intentionally omits timezone. The server resolves the
  // active tenant's workspace timezone and returns it with the calendar.
  const fallbackTimezone = "UTC";
  const [mode, setMode] = useState<CalendarMode>("week");
  const [anchor, setAnchor] = useState(() => todayInTimezone(fallbackTimezone));
  const [calendar, setCalendar] = useState<SagaCalendarData | null>(null);
  const [unscheduledDrafts, setUnscheduledDrafts] = useState<UnscheduledDraft[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "test_plan" | "error">("loading");
  const [draftState, setDraftState] = useState<"loading" | "ready" | "test_plan" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const scheduleSavePending = useRef(false);
  const [scheduleFeedback, setScheduleFeedback] = useState<ScheduleFeedback | null>(null);
  const [scheduleDate, setScheduleDate] = useState("");
  const [scheduleTime, setScheduleTime] = useState("");
  const testPlanOverrides = useRef<Record<string, LocalScheduleOverride>>({});
  const requestVersion = useRef(0);
  const workspaceTimezoneResolved = useRef(false);
  const wasCompact = useRef(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const { calendarRef, compact, inspectorDrawer } = useCompactCalendarLayout();

  useEffect(() => {
    if (compact && !wasCompact.current) setMode((current) => current === "week" ? "day" : current);
    wasCompact.current = compact;
  }, [compact]);

  const range = useMemo(() => rangeFor(mode, anchor), [anchor, mode]);

  const loadCalendar = useCallback(async (requestedRange: { from: string; to: string }) => {
    const version = ++requestVersion.current;
    let draftsResolved = false;
    setState("loading");
    setDraftState("loading");
    setError(null);
    setDraftError(null);
    try {
      const query = new URLSearchParams({ from: requestedRange.from, to: requestedRange.to });
      const [response, draftsResponse] = await Promise.all([
        fetch(`/api/content/calendar?${query.toString()}`, { cache: "no-store" }),
        fetch("/api/content/drafts?limit=250&include=media", { cache: "no-store" }),
      ]);
      const [payload, draftsPayload] = await Promise.all([jsonResponse(response), jsonResponse(draftsResponse)]);
      if (version !== requestVersion.current) return;
      if (!response.ok && isCalendarConfigurationRequired(payload)) {
        const testPlan = applyCalendarTestPlanOverrides(createCalendarTestPlan(new Date(), TEST_PLAN_TIMEZONE), testPlanOverrides.current);
        setCalendar(testPlan);
        setUnscheduledDrafts([]);
        setDraftState("test_plan");
        setDraftError(null);
        if (!workspaceTimezoneResolved.current) {
          workspaceTimezoneResolved.current = true;
          setAnchor(todayInTimezone(testPlan.timezone));
        }
        setState("test_plan");
        return;
      }
      if (draftsResponse.ok) {
        setUnscheduledDrafts(parseUnscheduledDrafts(draftsPayload));
        setDraftState("ready");
      } else {
        setUnscheduledDrafts([]);
        setDraftError(responseMessage(draftsPayload, "De oplanerade utkasten kunde inte laddas."));
        setDraftState("error");
      }
      draftsResolved = true;
      if (!response.ok) throw new Error(responseMessage(payload, "Kalendern kunde inte laddas just nu."));
      const nextCalendar = parseCalendarPayload(payload, fallbackTimezone);
      setCalendar(nextCalendar);
      if (!workspaceTimezoneResolved.current) {
        workspaceTimezoneResolved.current = true;
        setAnchor(todayInTimezone(nextCalendar.timezone));
      }
      setState("ready");
    } catch (reason) {
      if (version !== requestVersion.current) return;
      setCalendar(null);
      setError(reason instanceof Error ? reason.message : "Kalendern kunde inte laddas just nu.");
      setState("error");
      if (!draftsResolved) {
        setDraftError("De oplanerade utkasten kunde inte laddas.");
        setDraftState("error");
      }
    }
  }, []);

  useEffect(() => {
    const request = window.setTimeout(() => { void loadCalendar(range); }, 0);
    return () => window.clearTimeout(request);
  }, [loadCalendar, range]);

  const entries = useMemo(() => calendar?.entries ?? [], [calendar]);
  const activeTimezone = calendar?.timezone || fallbackTimezone;
  const selected = useMemo(() => entries.find((entry) => entry.id === selectedId) ?? null, [entries, selectedId]);
  const currentDayEntries = useMemo(() => entries.filter((entry) => entry.localDate === anchor), [anchor, entries]);
  const days = useMemo(() => mode === "month" ? monthGrid(anchor) : calendarWeek(anchor), [anchor, mode]);
  const surfaceEntries = useMemo(() => entries.filter((entry) => entry.localDate >= range.from && entry.localDate <= range.to), [entries, range.from, range.to]);
  const bounds = useMemo(() => localHourRange(entries.filter((entry) => days.includes(entry.localDate))), [days, entries]);
  const placements = useMemo(() => calendarPlacements(entries.filter((entry) => days.includes(entry.localDate)), bounds.startHour), [bounds.startHour, days, entries]);

  const closeInspector = useCallback(() => {
    const closingId = selectedId;
    setSelectedId(null);
    setScheduleDate("");
    setScheduleTime("");
    setScheduleFeedback(null);
    if (closingId) {
      window.requestAnimationFrame(() => document.getElementById(calendarCardDomId(closingId))?.focus());
    }
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const focusInspector = window.requestAnimationFrame(() => inspectorRef.current?.focus({ preventScroll: inspectorDrawer }));
    return () => window.cancelAnimationFrame(focusInspector);
  }, [inspectorDrawer, selectedId]);

  useEffect(() => {
    if (!selectedId || !inspectorDrawer) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeInspector();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = inspectorRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((candidate) => !candidate.hidden && candidate.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeInspector, inspectorDrawer, selectedId]);

  const updateSchedule = useCallback(async (entry: SagaCalendarEntry, nextDate: string, nextTime: string) => {
    // Serialize moves, including drag/drop and submits before React rerenders.
    // Otherwise an earlier request's finally could unlock a later save.
    if (scheduleSavePending.current) return;
    if (!entry.editable || (!entry.draftId && !entry.localOnly)) {
      const message = nonEditableScheduleMessage(entry);
      setScheduleFeedback({ entryId: entry.id, kind: "error", message });
      setError(message);
      return;
    }
    if (!entry.localOnly && entry.revision === null) {
      const message = "Kalenderposten behöver uppdateras innan den flyttas. Kalendern laddas om.";
      setScheduleFeedback({ entryId: entry.id, kind: "error", message });
      setError(message);
      void loadCalendar(range);
      return;
    }
    let patch: SchedulePatch;
    try {
      patch = schedulePatchFor(nextDate, nextTime, entry.scheduleTimezone, entry.revision ?? undefined);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Tiden kunde inte tolkas.";
      setScheduleFeedback({ entryId: entry.id, kind: "error", message });
      setError(message);
      return;
    }
    if (entry.localOnly) {
      const nextSchedule: LocalScheduleOverride = {
        startsAt: patch.scheduledAt,
        localDate: patch.scheduledLocalDate,
        localTime: patch.scheduledLocalTime,
        scheduledLocalDate: patch.scheduledLocalDate,
        scheduledLocalTime: patch.scheduledLocalTime,
        scheduleTimezone: patch.timezone,
      };
      testPlanOverrides.current = { ...testPlanOverrides.current, [entry.id]: nextSchedule };
      setCalendar((current) => current ? applyCalendarTestPlanOverrides(current, { [entry.id]: nextSchedule }) : current);
      setScheduleDate(nextDate);
      setScheduleTime(nextTime);
      setScheduleFeedback({ entryId: entry.id, kind: "success", message: "Testplanen är ändrad i den här fliken. Den är inte sparad eller externt levererad." });
      setError(null);
      return;
    }
    const draftId = entry.draftId;
    if (!draftId) return;
    scheduleSavePending.current = true;
    setMovingId(entry.id);
    // Reflect a drag/drop immediately. Never write inspector fields after await:
    // the user may select another post or make newer unsaved edits meanwhile.
    setScheduleDate(nextDate);
    setScheduleTime(nextTime);
    setScheduleFeedback({ entryId: entry.id, kind: "pending", message: "Sparar den nya tiden i kalendern…" });
    setError(null);
    try {
      const response = await fetch(`/api/content/drafts/${encodeURIComponent(draftId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      const payload = await jsonResponse(response);
      if (!response.ok) {
        if (response.status === 409) {
          const message = "Inlägget har ändrats på annat håll. Kalendern laddades om — kontrollera tid innan du sparar igen.";
          setScheduleFeedback({ entryId: entry.id, kind: "conflict", message });
          setError(null);
          await loadCalendar(range);
          return;
        }
        throw new Error(responseMessage(payload, "Tiden kunde inte sparas."));
      }
      const responseDraft = isRecord(payload) && isRecord(payload.draft) ? payload.draft : null;
      const updatedRevision = responseDraft ? positiveInteger(responseDraft.revision) : null;
      const placement = localParts(new Date(patch.scheduledAt), activeTimezone);
      setCalendar((current) => current ? {
        ...current,
        entries: current.entries.map((candidate) => candidate.id === entry.id
          ? {
            ...candidate,
            startsAt: patch.scheduledAt,
            localDate: placement.date,
            localTime: placement.time,
            scheduledLocalDate: patch.scheduledLocalDate,
            scheduledLocalTime: patch.scheduledLocalTime,
            scheduleTimezone: patch.timezone,
            revision: updatedRevision ?? candidate.revision,
          }
          : candidate).sort((first, second) => first.localDate.localeCompare(second.localDate) || first.localTime.localeCompare(second.localTime)),
      } : current);
      setScheduleFeedback({ entryId: entry.id, kind: "success", message: `Tiden ${nextDate} kl. ${nextTime} är sparad i SAGA-kalendern. Ingen extern leverans har startats.` });
      setState("ready");
      void loadCalendar(range);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Tiden kunde inte sparas.";
      setScheduleFeedback({ entryId: entry.id, kind: "error", message });
      setError(message);
    } finally {
      scheduleSavePending.current = false;
      setMovingId(null);
    }
  }, [activeTimezone, loadCalendar, range]);

  function selectEntry(entry: SagaCalendarEntry) {
    setSelectedId(entry.id);
    setScheduleDate(entry.scheduledLocalDate);
    setScheduleTime(entry.scheduledLocalTime);
    setScheduleFeedback(null);
    setError(null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>, date: string) {
    event.preventDefault();
    const entryId = event.dataTransfer.getData("application/x-saga-calendar") || draggedId;
    setDraggedId(null);
    const entry = entries.find((candidate) => candidate.id === entryId);
    if (!entry || !entry.editable) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const absoluteMinute = bounds.startHour * 60 + (event.clientY - rect.top) / MINUTE_HEIGHT;
    const rounded = Math.max(0, Math.min(23 * 60 + 30, Math.round(absoluteMinute / 30) * 30));
    const time = minutesToTime(rounded);
    try {
      const target = scheduleFieldsForCalendarPlacement(date, time, activeTimezone, entry.scheduleTimezone);
      selectEntry(entry);
      void updateSchedule(entry, target.scheduledLocalDate, target.scheduledLocalTime);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Tiden kunde inte tolkas.";
      setScheduleFeedback({ entryId: entry.id, kind: "error", message });
      setError(message);
    }
  }

  function submitSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected) void updateSchedule(selected, scheduleDate, scheduleTime);
  }

  const isToday = anchor === todayInTimezone(activeTimezone);
  const heading = mode === "week"
    ? weekHeaderLabel(days)
    : mode === "month"
      ? dateLabel(startOfCurrentMonth(anchor), { month: "long", year: "numeric" })
      : dateLabel(anchor, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const isTestPlan = state === "test_plan";

  function resetTestPlan() {
    testPlanOverrides.current = {};
    setCalendar(createCalendarTestPlan(new Date(), TEST_PLAN_TIMEZONE));
    setSelectedId(null);
    setScheduleDate("");
    setScheduleTime("");
    setScheduleFeedback(null);
    setError(null);
  }

  return <section className={styles.calendar} ref={calendarRef} aria-labelledby="calendar-heading">
    <header className={styles.header}>
      <div className={styles.intro}>
        <p className={styles.kicker}>SAGA · INNEHÅLLSPLAN</p>
        <h1 id="calendar-heading">Kalender</h1>
        <p>{isTestPlan
          ? "Prova kalendern med tidsatta testposter. Flyttar uppdateras bara i den här fliken tills arbetsytan är ansluten."
          : "Flytta planerade utkast med exakt tid, håll koll på status och öppna rätt arbetsyta utan att lämna planen."}</p>
      </div>
      <div className={styles.headerActions}>
        <span className={`${styles.planStatus} ${isTestPlan ? styles.planStatusTest : ""}`}><i aria-hidden="true" />{isTestPlan ? "Testplan · sparas inte" : "Revisionsskyddad plan"}</span>
        {isTestPlan
          ? <button className={`${styles.primaryAction} ${styles.testPlanReset}`} type="button" onClick={resetTestPlan}>Återställ plan</button>
          : <Link className={styles.primaryAction} href="/studio/content/new?edit=1">+ Nytt utkast</Link>}
        <button className={styles.refresh} type="button" onClick={() => void loadCalendar(range)} disabled={state === "loading"}>
          {state === "loading" ? "Hämtar…" : isTestPlan ? "Försök igen" : "Uppdatera"}
        </button>
      </div>
    </header>

    <section className={styles.toolbar} aria-label="Kalenderkontroller">
      <div className={styles.modePicker} role="group" aria-label="Kalendervy">
        {(["day", "week", "month"] as CalendarMode[]).map((candidate) => <button key={candidate} type="button" aria-pressed={mode === candidate} className={mode === candidate ? styles.modeActive : undefined} onClick={() => setMode(candidate)}>{modeLabel(candidate)}</button>)}
      </div>
      <div className={styles.periodControls}>
        <button type="button" aria-label={`Föregående ${modeLabel(mode).toLowerCase()}`} onClick={() => setAnchor((current) => moveAnchor(current, mode, -1))}>‹</button>
        <strong>{heading}</strong>
        <button type="button" aria-label={`Nästa ${modeLabel(mode).toLowerCase()}`} onClick={() => setAnchor((current) => moveAnchor(current, mode, 1))}>›</button>
        <button type="button" className={styles.todayButton} onClick={() => setAnchor(todayInTimezone(activeTimezone))} disabled={isToday}>Idag</button>
      </div>
      <p className={styles.timezone}>Tidszon · {activeTimezone}</p>
    </section>

    {error && state !== "error" && <p className={styles.error} role="alert">{error}</p>}

    {isTestPlan && <section className={styles.testPlanNotice} aria-live="polite">
      <span aria-hidden="true">⌁</span>
      <div><strong>Prova planeringen</strong><p>Växla vy, välj ett kort och ändra datum eller klockslag. Ändringar finns bara i den här fliken och skickas inte vidare.</p></div>
      <button type="button" onClick={resetTestPlan}>Återställ</button>
    </section>}

    {state === "error" ? <section className={styles.failure} aria-live="polite">
      <span aria-hidden="true">!</span>
      <div><strong>Kalendern är inte tillgänglig just nu.</strong><p>{error || "Försök hämta planen igen."}</p></div>
      <button type="button" onClick={() => void loadCalendar(range)}>Försök igen</button>
    </section> : <div className={styles.workbench}>
      <div className={styles.canvas} aria-busy={state === "loading"}>
        {state === "loading" && !calendar ? <CalendarLoading /> : mode === "month" && !surfaceEntries.length ? <CalendarEmpty heading={heading} date={anchor} testPlan={isTestPlan} /> : mode === "month" ? <MonthSurface entries={entries} days={days} anchor={anchor} timezone={activeTimezone} selectedId={selectedId} onSelect={selectEntry} /> : mode === "day" ? <AgendaSurface date={anchor} entries={currentDayEntries} selectedId={selectedId} onSelect={selectEntry} testPlan={isTestPlan} /> : !surfaceEntries.length ? <CalendarEmpty heading={heading} date={anchor} testPlan={isTestPlan} /> : <WeekSurface days={days} bounds={bounds} placements={placements} draggedId={draggedId} selectedId={selectedId} onDrop={onDrop} onSelect={selectEntry} onDragStart={setDraggedId} onDragEnd={() => setDraggedId(null)} />}
      </div>
      {selected && inspectorDrawer && <button type="button" className={styles.inspectorScrim} aria-label="Stäng detaljer om kalenderposten" onClick={closeInspector} />}
      <CalendarInspector inspectorRef={inspectorRef} entry={selected} timezone={selected?.scheduleTimezone ?? activeTimezone} calendarTimezone={activeTimezone} drawer={inspectorDrawer} feedback={scheduleFeedback?.entryId === selected?.id ? scheduleFeedback : null} date={scheduleDate} time={scheduleTime} moving={movingId !== null} waitingForOtherSave={movingId !== null && movingId !== selected?.id} onClose={closeInspector} onDateChange={setScheduleDate} onTimeChange={setScheduleTime} onSubmit={submitSchedule} onMoveBy={(minutes) => {
        if (!selected) return;
        const nextMinutes = timeToMinutes(scheduleTime || selected.scheduledLocalTime) + minutes;
        let nextDate = scheduleDate || selected.scheduledLocalDate;
        if (nextMinutes < 0) nextDate = addCalendarDays(nextDate, -1);
        if (nextMinutes >= 24 * 60) nextDate = addCalendarDays(nextDate, 1);
        setScheduleDate(nextDate);
        setScheduleTime(minutesToTime((nextMinutes + 24 * 60) % (24 * 60)));
      }} onMoveDay={(daysToMove) => {
        if (!selected) return;
        setScheduleDate(addCalendarDays(scheduleDate || selected.scheduledLocalDate, daysToMove));
      }} />
    </div>}

    <UnscheduledDraftTray drafts={unscheduledDrafts} state={draftState} error={draftError} testPlan={isTestPlan} />

    <footer className={styles.footnote}>
      <span aria-hidden="true">↕</span>
      <p>{isTestPlan
        ? "I testplanen uppdateras bara den här vyn. Ingenting sparas eller skickas externt när du flyttar en punkt."
        : "Dra ett redigerbart utkast till en ny dag och tid. Du kan alltid använda tidfälten i detaljpanelen — att ändra tiden påverkar bara planen i SAGA, inte en extern kanal."}</p>
    </footer>
  </section>;
}

function CalendarLoading() {
  return <div className={styles.loading} role="status" aria-label="Hämtar innehållsplanen">
    <div className={styles.loadingToolbar} aria-hidden="true"><i /><i /><i /></div>
    <div className={styles.loadingWeek} aria-hidden="true">
      <div className={styles.loadingTimeRail}>{Array.from({ length: 7 }, (_, index) => <i key={index} />)}</div>
      {Array.from({ length: 7 }, (_, index) => <div className={styles.loadingDay} key={index}><i /><i /><i /></div>)}
    </div>
    <p>Hämtar innehållsplanen…</p>
  </div>;
}

function CalendarEmpty({ heading, date, testPlan }: { heading: string; date: string; testPlan: boolean }) {
  return <section className={styles.calendarEmpty} aria-live="polite">
    <span aria-hidden="true">✦</span>
    <div><p className={styles.kicker}>{testPlan ? "TESTPLAN" : "PLANEN ÄR TOM"}</p><h2>Inget planerat {heading.toLocaleLowerCase("sv-SE")}</h2>{testPlan
      ? <p>Den här perioden innehåller inga testposter. Växla period eller återgå till idag för att prova planeringen.</p>
      : <><p>Skapa ett utkast, välj kanal och tid. Det dyker sedan upp här som ett flyttbart planeringsobjekt.</p><Link href={`/studio/content/new?edit=1&date=${date}`}>Skapa ett utkast</Link></>}</div>
  </section>;
}

function WeekSurface({ days, bounds, placements, draggedId, selectedId, onDrop, onSelect, onDragStart, onDragEnd }: {
  days: string[];
  bounds: TimeBounds;
  placements: TimedPlacement[];
  draggedId: string | null;
  selectedId: string | null;
  onDrop: (event: DragEvent<HTMLDivElement>, date: string) => void;
  onSelect: (entry: SagaCalendarEntry) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const hours = Array.from({ length: bounds.endHour - bounds.startHour + 1 }, (_, index) => bounds.startHour + index);
  return <section className={styles.weekScroller} aria-label="Veckoplan. Välj ett inlägg för att ändra dess tid i detaljpanelen.">
    <div className={styles.weekPlanner}>
      <div className={styles.weekHeader}>
        <span aria-hidden="true" />
        {days.map((day) => <div key={day}><strong>{dateLabel(day, { weekday: "short" }).replace(".", "")}</strong><span>{dateLabel(day, { day: "numeric" })}</span></div>)}
      </div>
      <div className={styles.weekBody} style={{ "--calendar-height": `${(bounds.endHour - bounds.startHour) * 60 * MINUTE_HEIGHT}px` } as CSSProperties}>
        <div className={styles.timeRail} aria-hidden="true">{hours.slice(0, -1).map((hour) => <span key={hour} style={{ top: `${(hour - bounds.startHour) * 60 * MINUTE_HEIGHT}px` }}>{String(hour).padStart(2, "0")}:00</span>)}</div>
        <div className={styles.weekColumns}>
          {days.map((day) => <div key={day} className={styles.weekColumn} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(event, day)}>
            {hours.slice(0, -1).map((hour) => <span key={hour} className={styles.hourLine} style={{ top: `${(hour - bounds.startHour) * 60 * MINUTE_HEIGHT}px` }} aria-hidden="true" />)}
            {placements.filter((placement) => placement.entry.localDate === day).map((placement) => <CalendarCard key={placement.entry.id} entry={placement.entry} compact dragged={draggedId === placement.entry.id} selected={selectedId === placement.entry.id} placement={placement} onSelect={onSelect} onDragStart={onDragStart} onDragEnd={onDragEnd} />)}
          </div>)}
        </div>
      </div>
    </div>
  </section>;
}

function MonthSurface({ entries, days, anchor, timezone, selectedId, onSelect }: { entries: SagaCalendarEntry[]; days: string[]; anchor: string; timezone: string; selectedId: string | null; onSelect: (entry: SagaCalendarEntry) => void }) {
  const currentMonth = anchor.slice(0, 7);
  return <div className={styles.monthPlanner}>
    <div className={styles.monthWeekdays}>{["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"].map((label) => <span key={label}>{label}</span>)}</div>
    <div className={styles.monthGrid}>{days.map((day) => {
      const dayEntries = entries.filter((entry) => entry.localDate === day);
      return <section className={day.slice(0, 7) === currentMonth ? styles.monthDay : `${styles.monthDay} ${styles.monthDayMuted}`} key={day}>
        <header><time dateTime={day}>{dateLabel(day, { day: "numeric" })}</time>{day === todayInTimezone(timezone) && <span>Idag</span>}</header>
        <div>{dayEntries.map((entry) => <button id={calendarCardDomId(entry.id)} type="button" key={entry.id} className={`${styles.monthCard}${selectedId === entry.id ? ` ${styles.monthCardSelected}` : ""}`} onClick={() => onSelect(entry)} aria-controls="calendar-inspector" aria-expanded={selectedId === entry.id} aria-label={`${entry.title}. ${entry.localDate} klockan ${entry.localTime}. ${entry.localOnly ? "Testpost i den här vyn." : calendarStatusLabel(entry.status)} Välj för detaljer och flytt.`}><time>{entry.localTime}</time><AssetImage thumbnail={entry.thumbnail} alt="" fallback={<span className={styles.monthThumbEmpty} aria-hidden="true" />} />{entry.title}</button>)}</div>
      </section>;
    })}</div>
  </div>;
}

function AgendaSurface({ date, entries, selectedId, onSelect, testPlan }: { date: string; entries: SagaCalendarEntry[]; selectedId: string | null; onSelect: (entry: SagaCalendarEntry) => void; testPlan: boolean }) {
  return <section className={styles.agenda} aria-label={`Inlägg ${dateLabel(date, { weekday: "long", day: "numeric", month: "long" })}`}>
    <header><p>{dateLabel(date, { weekday: "long" })}</p><strong>{dateLabel(date, { day: "numeric", month: "long" })}</strong><span>{entries.length} {entries.length === 1 ? "planerat inlägg" : "planerade inlägg"}</span></header>
    {entries.length ? <ol>{entries.map((entry) => <li key={entry.id}><time>{entry.localTime}</time><CalendarCard entry={entry} selected={selectedId === entry.id} onSelect={onSelect} onDragStart={() => undefined} onDragEnd={() => undefined} /></li>)}</ol> : <div className={styles.dayEmpty}><span aria-hidden="true">✦</span><div><strong>Inget planerat just den här dagen.</strong>{testPlan
      ? <p>Välj en annan dag eller återgå till idag för att fortsätta prova planeringen.</p>
      : <><p>Välj en annan dag eller skapa ett nytt utkast när du är redo.</p><Link href={`/studio/content/new?edit=1&date=${date}`}>Skapa utkast</Link></>}</div></div>}
  </section>;
}

function CalendarCard({ entry, compact = false, dragged = false, selected = false, placement, onSelect, onDragStart, onDragEnd }: {
  entry: SagaCalendarEntry;
  compact?: boolean;
  dragged?: boolean;
  selected?: boolean;
  placement?: Pick<TimedPlacement, "lane" | "laneCount" | "top" | "height">;
  onSelect: (entry: SagaCalendarEntry) => void;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
}) {
  const className = [styles.postCard, compact ? styles.postCardCompact : "", dragged ? styles.postCardDragged : "", selected ? styles.postCardSelected : "", entry.editable ? styles.postCardEditable : styles.postCardLocked].filter(Boolean).join(" ");
  const cardStyle = placement ? {
    "--event-top": `${placement.top}px`,
    "--event-height": `${placement.height}px`,
    "--event-left": `${placement.lane * (100 / placement.laneCount)}%`,
    "--event-width": `${100 / placement.laneCount}%`,
  } as CSSProperties : undefined;
  return <button id={calendarCardDomId(entry.id)} type="button" className={className} style={cardStyle} draggable={compact && entry.editable} onClick={() => onSelect(entry)} onDragStart={(event) => {
    if (!entry.editable) return;
    event.dataTransfer.setData("application/x-saga-calendar", entry.id);
    event.dataTransfer.setData("text/plain", entry.title);
    event.dataTransfer.effectAllowed = "move";
    onDragStart(entry.id);
  }} onDragEnd={onDragEnd} aria-controls="calendar-inspector" aria-expanded={selected} aria-label={`${entry.title}. ${entry.localDate} klockan ${entry.localTime}. ${entry.localOnly ? "Testpost i den här vyn." : calendarStatusLabel(entry.status)} ${entry.editable ? "Välj för detaljer och flytt." : "Välj för detaljer."}`}>
    <span className={styles.cardThumb}><AssetImage thumbnail={entry.thumbnail} alt="" fallback={<span aria-hidden="true">{entry.channels[0] === "newsletter" ? "✉" : "✦"}</span>} /></span>
    <span className={styles.cardCopy}><span className={styles.cardTopline}><time>{entry.localTime}</time><span>{entry.localOnly ? "Testpost" : calendarStatusLabel(entry.status)}</span></span><strong>{entry.title}</strong><span className={styles.cardChannels}>{entry.channels.length ? entry.channels.map(channelLabel).join(" · ") : "Kanal ej vald"}</span></span>
  </button>;
}

function AssetImage({ thumbnail, alt, fallback }: { thumbnail: SagaCalendarEntry["thumbnail"]; alt: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (!thumbnail || failed) return <>{fallback}</>;
  return <img src={thumbnail.assetUrl} alt={alt} onError={() => setFailed(true)} />;
}

function UnscheduledDraftTray({ drafts, state, error, testPlan }: { drafts: UnscheduledDraft[]; state: "loading" | "ready" | "test_plan" | "error"; error: string | null; testPlan: boolean }) {
  return <section className={styles.unscheduled} aria-labelledby="unscheduled-heading">
    <header>
      <div><p className={styles.kicker}>{testPlan ? "PROVA FLÖDET" : "REDO ATT PLANERA"}</p><h2 id="unscheduled-heading">{testPlan ? "Testplanens ramar" : "Oplanerade utkast"}</h2><p>{testPlan ? "Testposterna ovan är avsiktligt tidsatta så att du kan prova dag-, vecka- och månadsvyn direkt." : "Det här är sparade utkast utan datum. Öppna ett utkast för att välja tid, kanal och bild."}</p></div>
      {!testPlan && <Link href="/studio/content/new?edit=1">Nytt utkast <span aria-hidden="true">→</span></Link>}
    </header>
    {testPlan ? <div className={styles.trayEmpty}><span aria-hidden="true">⌁</span><p>Flytta en testpost med drag och släpp i veckovyn, eller justera datum och klockslag i detaljpanelen. Ingenting sparas eller skickas vidare.</p></div> : state === "loading" ? <p className={styles.trayLoading}>Hämtar sparade utkast…</p> : state === "error" ? <div className={styles.trayError}><span aria-hidden="true">!</span><p>{error || "De oplanerade utkasten kunde inte laddas."}</p></div> : !drafts.length ? <div className={styles.trayEmpty}><span aria-hidden="true">✦</span><p>Inga oschemalagda utkast just nu.</p></div> : <ol>{drafts.map((draft) => <li key={draft.id}>
      <span className={styles.trayThumb}><AssetImage thumbnail={draft.thumbnail} alt="" fallback={<span aria-hidden="true">✦</span>} /></span>
      <div><strong>{draft.title}</strong><span>{calendarStatusLabel(draft.status)}{draft.channels.length ? ` · ${draft.channels.map(channelLabel).join(" · ")}` : ""}</span></div>
      <Link href={`/studio/content/${draft.id}?edit=1`}>Planera <span aria-hidden="true">→</span></Link>
    </li>)}</ol>}
  </section>;
}

function CalendarInspector({ inspectorRef, entry, timezone, calendarTimezone, drawer, feedback, date, time, moving, waitingForOtherSave, onClose, onDateChange, onTimeChange, onSubmit, onMoveBy, onMoveDay }: {
  inspectorRef: RefObject<HTMLElement | null>;
  entry: SagaCalendarEntry | null;
  /** The timezone owned by this entry's editorial schedule. */
  timezone: string;
  /** The timezone currently used to draw the calendar grid. */
  calendarTimezone: string;
  drawer: boolean;
  feedback: ScheduleFeedback | null;
  date: string;
  time: string;
  moving: boolean;
  waitingForOtherSave: boolean;
  onClose: () => void;
  onDateChange: (value: string) => void;
  onTimeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onMoveBy: (minutes: number) => void;
  onMoveDay: (days: number) => void;
}) {
  if (!entry) return <aside ref={inspectorRef} className={`${styles.inspector} ${styles.inspectorEmpty}`} id="calendar-inspector" aria-label="Detaljpanel">
    <span aria-hidden="true">⌁</span><div><p className={styles.kicker}>DETALJER</p><h2>Välj ett inlägg</h2><p>Klicka på en punkt i kalendern för att se kanal, bild, status och tid — och för att flytta den när det är möjligt.</p></div>
  </aside>;

  const draftHref = entry.draftId ? `/studio/content/${encodeURIComponent(entry.draftId)}` : null;
  const scheduleDate = date || entry.scheduledLocalDate;
  const scheduleTime = time || entry.scheduledLocalTime;
  const scheduleFeedbackClass = feedback
    ? `${styles.scheduleFeedback} ${styles[`scheduleFeedback${feedback.kind[0]?.toUpperCase() ?? ""}${feedback.kind.slice(1)}`] ?? ""}`
    : "";

  return <aside
    ref={inspectorRef}
    className={`${styles.inspector} ${styles.inspectorOpen}`}
    id="calendar-inspector"
    aria-labelledby="calendar-inspector-heading"
    role={drawer ? "dialog" : undefined}
    aria-modal={drawer || undefined}
    tabIndex={-1}
  >
    <div className={styles.inspectorMedia}><AssetImage thumbnail={entry.thumbnail} alt={entry.thumbnail?.altText ?? ""} fallback={<div><span aria-hidden="true">✦</span><small>Ingen bild vald</small></div>} /></div>
    <div className={styles.inspectorBody}>
      <div className={styles.inspectorTopline}>
        <div className={styles.inspectorMeta}><span className={`${styles.statusPill} ${styles[`status${entry.status[0]?.toUpperCase() ?? ""}${entry.status.slice(1)}`] ?? ""}`}>{entry.localOnly ? "Testpost" : calendarStatusLabel(entry.status)}</span><span>{entry.localOnly ? "Endast i den här vyn" : entry.kind === "automation_job" ? "Automationspunkt" : entry.kind === "plan_slot" ? "13-veckorsplan · ingen tid i kalendern" : "Sparat utkast"}</span></div>
        <button type="button" className={styles.inspectorClose} onClick={onClose} aria-label="Stäng detaljer">×</button>
      </div>
      <h2 id="calendar-inspector-heading">{entry.title}</h2>
      {entry.excerpt && <p className={styles.excerpt}>{entry.excerpt}</p>}
      <div className={styles.channels}>{entry.channels.length ? entry.channels.map((channel) => <span key={channel}>{channelLabel(channel)}</span>) : <span>Kanal ej vald</span>}</div>

      {entry.localOnly ? <div className={styles.localOnlyNote} role="note"><strong>Endast en testpost</strong><p>Den här posten saknar ett sparat utkast. Du kan prova att flytta den här, men den kan inte förhandsvisas, redigeras eller skickas externt.</p></div>
        : draftHref ? <div className={styles.inspectorActions} aria-label="Arbeta med utkastet"><Link className={styles.previewDraft} href={draftHref}>Förhandsvisa <span aria-hidden="true">↗</span></Link><Link className={styles.editDraft} href={`${draftHref}?edit=1`}>Redigera <span aria-hidden="true">→</span></Link></div>
          : entry.kind === "automation_job" && entry.automationRuleId ? <div className={styles.inspectorActions} aria-label="Arbeta med automationen"><Link className={styles.previewDraft} href="/studio/automations">Öppna automation <span aria-hidden="true">→</span></Link></div>
            : null}

      {entry.editable && (entry.draftId || entry.localOnly) ? <form className={styles.scheduleForm} onSubmit={onSubmit}>
        <div><p className={styles.kicker}>{entry.localOnly ? "ÄNDRA TESTPLAN" : "ÄNDRA TID I KALENDERN"}</p><strong>{entry.localOnly ? "Ny tid i den här vyn" : "Ny tid i SAGA"}</strong></div>
        <label><span>Datum</span><input type="date" value={date} onChange={(event) => onDateChange(event.target.value)} required /></label>
        <div className={styles.nudgeControls}><button type="button" onClick={() => onMoveDay(-1)}>Föregående dag</button><button type="button" onClick={() => onMoveDay(1)}>Nästa dag</button></div>
        <label><span>Klockslag</span><input type="time" step="1800" value={time} onChange={(event) => onTimeChange(event.target.value)} required /></label>
        <div className={styles.nudgeControls}><button type="button" onClick={() => onMoveBy(-30)}>− 30 min</button><button type="button" onClick={() => onMoveBy(30)}>+ 30 min</button></div>
        <p className={styles.scheduleSummary} aria-live="polite">Valt: {scheduleDate} kl. {scheduleTime} · {timezone}</p>
        {calendarTimezone !== timezone && <p className={styles.timezoneNotice}>Kalendern visas i {calendarTimezone}. Det här utkastet ändras i sin egen tidszon, {timezone}.</p>}
        <p>{entry.localOnly ? "Det här uppdaterar bara testplanen i den här fliken. Ingenting sparas eller skickas vidare." : `Tidszon: ${timezone}. Ändringen sparas först när du väljer Spara tid och startar ingen extern leverans.`}</p>
        {feedback && <p className={scheduleFeedbackClass} role={feedback.kind === "error" || feedback.kind === "conflict" ? "alert" : "status"}>{feedback.message}</p>}
        {waitingForOtherSave && <p role="status">En annan posts tid sparas. Dina ändringar ligger kvar här; spara dem när den sparningen är klar.</p>}
        <button className={styles.saveTime} type="submit" disabled={moving}>{waitingForOtherSave ? "Väntar på pågående sparning…" : moving ? "Sparar tid…" : entry.localOnly ? "Uppdatera testplan" : "Spara tid"}</button>
      </form> : <div className={styles.lockedNote}><span aria-hidden="true">◌</span><p>{nonEditableScheduleMessage(entry)}</p>{entry.kind === "automation_job" && entry.automationRuleId && <Link href="/studio/automations">Öppna automationer →</Link>}</div>}
    </div>
  </aside>;
}
