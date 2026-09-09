import { statusLabels } from "@/lib/domain/event-lifecycle";
import type { ConfidenceLevel, EventCategory, EventStatus, Recommendation } from "@/lib/domain/types";

const categoryLabels: Record<EventCategory, string> = {
  economy: "Ekonomi och marknader",
  technology: "Teknik och nya förmågor",
  regulation: "Reglering och juridik",
  geopolitics_trade: "Geopolitik och handel",
  security: "Säkerhet",
  energy_logistics: "Energi och logistik",
  payments: "Betalningar",
  infrastructure: "Infrastruktur",
  business: "Företag och bransch",
  local: "Lokalt",
  personal_interest: "Personligt intresse",
};

const recommendationLabels: Record<Recommendation, string> = {
  act: "Agera",
  monitor: "Bevaka",
  no_action: "Ingen åtgärd",
};

const confidenceLabels: Record<ConfidenceLevel, string> = {
  high: "Hög säkerhet",
  medium: "Medel säkerhet",
  low: "Låg säkerhet",
};

export function CategoryLabel({ category }: { category: EventCategory }) {
  return <span>{categoryLabels[category]}</span>;
}

export function StatusChip({ status }: { status: EventStatus }) {
  return <span className="chip chip-neutral">{statusLabels[status]}</span>;
}

export function RecommendationChip({ recommendation }: { recommendation: Recommendation }) {
  return <span className={`chip chip-${recommendation}`}>{recommendationLabels[recommendation]}</span>;
}

export function ConfidenceChip({ confidence }: { confidence: ConfidenceLevel }) {
  return <span className={`chip chip-confidence-${confidence}`}>{confidenceLabels[confidence]}</span>;
}
