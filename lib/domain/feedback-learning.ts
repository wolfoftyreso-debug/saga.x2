import type { EventCategory, ProfileSettings } from "@/lib/domain/types";

export type FeedbackRecord = {
  eventId: string;
  type: "important" | "not_relevant" | "more_like_this" | "less_like_this";
};

export type FeedbackEvent = {
  id: string;
  category: EventCategory | string;
  regions: string[];
  actors: string[];
};

/** Applies bounded, explainable learning on top of the user's explicit sliders. */
export function applyFeedbackHistory(
  settings: ProfileSettings,
  events: FeedbackEvent[],
  records: FeedbackRecord[],
): ProfileSettings {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const offsets = { economy: 0, technology: 0, regulation: 0, geopolitics: 0, swedenEu: 0, usa: 0, gulf: 0 };

  for (const record of records) {
    const event = eventById.get(record.eventId);
    if (!event) continue;
    const delta = feedbackDelta(record.type);
    const topic = categoryBucket(event.category);
    offsets[topic] += delta;
    for (const region of event.regions) {
      const bucket = regionBucket(region);
      if (bucket) offsets[bucket] += delta;
    }
  }

  return {
    ...settings,
    economyWeight: adjust(settings.economyWeight, offsets.economy),
    technologyWeight: adjust(settings.technologyWeight, offsets.technology),
    regulationWeight: adjust(settings.regulationWeight, offsets.regulation),
    geopoliticsWeight: adjust(settings.geopoliticsWeight, offsets.geopolitics),
    swedenEuWeight: adjust(settings.swedenEuWeight, offsets.swedenEu),
    usaWeight: adjust(settings.usaWeight, offsets.usa),
    gulfWeight: adjust(settings.gulfWeight, offsets.gulf),
  };
}

/** Compact context explains to the editorial model what feedback was about, not merely its sentiment. */
export function feedbackContext(events: FeedbackEvent[], records: FeedbackRecord[]): Array<{
  signal: FeedbackRecord["type"];
  category: string;
  regions: string[];
  actors: string[];
}> {
  const eventById = new Map(events.map((event) => [event.id, event]));
  return records.slice(0, 50).flatMap((record) => {
    const event = eventById.get(record.eventId);
    return event ? [{ signal: record.type, category: event.category, regions: event.regions.slice(0, 4), actors: event.actors.slice(0, 4) }] : [];
  });
}

function feedbackDelta(type: FeedbackRecord["type"]): number {
  switch (type) {
    case "important": return 7;
    case "more_like_this": return 5;
    case "not_relevant": return -8;
    case "less_like_this": return -6;
  }
}

function categoryBucket(category: string): "economy" | "technology" | "regulation" | "geopolitics" {
  if (category === "economy" || category === "payments") return "economy";
  if (category === "technology" || category === "infrastructure" || category === "business") return "technology";
  if (category === "regulation") return "regulation";
  return "geopolitics";
}

function regionBucket(region: string): "swedenEu" | "usa" | "gulf" | null {
  const value = region.toLocaleLowerCase("sv-SE");
  if (/sverige|sweden|\beu\b|europeiska unionen|european union|europa/.test(value)) return "swedenEu";
  if (/\busa\b|united states|amerika|u\.s\./.test(value)) return "usa";
  if (/uae|förenade arabemiraten|united arab emirates|gulf|gulfregionen|gcc|dubai|saudi/.test(value)) return "gulf";
  return null;
}

function adjust(weight: number, offset: number): number {
  return Math.max(0, Math.min(100, weight + Math.max(-25, Math.min(25, offset))));
}
