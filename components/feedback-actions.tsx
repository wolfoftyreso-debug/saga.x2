"use client";

import { useState } from "react";

const options = [
  { type: "important", label: "Viktigt" },
  { type: "not_relevant", label: "Inte relevant" },
  { type: "more_like_this", label: "Mer sådant" },
  { type: "less_like_this", label: "Mindre sådant" },
] as const;

type FeedbackType = (typeof options)[number]["type"];

export function FeedbackActions({ eventId, briefItemId, initialSelected, compact = false }: {
  eventId: string;
  briefItemId?: string;
  initialSelected: string[];
  compact?: boolean;
}) {
  const [selected, setSelected] = useState<FeedbackType[]>(initialSelected.filter(isFeedbackType));
  const [pending, setPending] = useState<FeedbackType | null>(null);
  const [error, setError] = useState("");

  async function toggle(type: FeedbackType) {
    if (pending) return;
    const isSelected = selected.includes(type);
    setPending(type);
    setError("");
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventId, briefItemId: briefItemId ?? null, type, selected: !isSelected }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Kunde inte spara återkopplingen.");
      setSelected((current) => (isSelected ? current.filter((value) => value !== type) : [...current, type]));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Kunde inte spara återkopplingen.");
    } finally {
      setPending(null);
    }
  }

  return (
    <section className={compact ? "feedback feedback-compact" : "feedback"} aria-labelledby={`feedback-heading-${eventId}`}>
      <h2 id={`feedback-heading-${eventId}`}>{compact ? "Återkoppling" : "Hjälp briefen att bli skarpare"}</h2>
      <div className="feedback-buttons">
        {options.map((option) => {
          const active = selected.includes(option.type);
          return (
            <button
              key={option.type}
              type="button"
              className={active ? "feedback-button selected" : "feedback-button"}
              aria-pressed={active}
              disabled={Boolean(pending)}
              onClick={() => toggle(option.type)}
            >
              {pending === option.type ? "Sparar…" : option.label}
            </button>
          );
        })}
      </div>
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}

function isFeedbackType(value: string): value is FeedbackType {
  return options.some((option) => option.type === value);
}
