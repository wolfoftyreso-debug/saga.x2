"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const triggerOptions = [
  { value: "reported", label: "Rapporterat" },
  { value: "proposed", label: "Föreslaget" },
  { value: "negotiating", label: "Förhandling" },
  { value: "announced", label: "Annonserat" },
  { value: "signed", label: "Undertecknat" },
  { value: "adopted", label: "Antaget" },
  { value: "effective", label: "I kraft" },
  { value: "implemented", label: "Implementerat" },
  { value: "changed", label: "Villkor ändras" },
  { value: "reversed", label: "Upphävt" },
] as const;

const defaultTriggers = ["announced", "signed", "adopted", "effective", "implemented", "changed", "reversed"];

export function WatchCreateForm() {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>(defaultTriggers);
  const [onlyMaterialChange, setOnlyMaterialChange] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggleStatus(value: string) {
    setSelected((current) => current.includes(value)
      ? current.filter((status) => status !== value)
      : [...current, value]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = String(form.get("title") ?? "").trim();
    const rationale = String(form.get("rationale") ?? "").trim();
    const queryText = String(form.get("queryText") ?? "").trim();
    if (!title || selected.length === 0) {
      setNotice("Ge bevakningen ett namn och välj minst ett läge som ska trigga den.");
      return;
    }

    setNotice(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/watches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "topic",
            title,
            queryText: queryText || null,
            rationale,
            triggerStatuses: selected,
            onlyMaterialChange,
          }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte skapa bevakningen.");
        formElement.reset();
        setSelected(defaultTriggers);
        setOnlyMaterialChange(true);
        setNotice("Bevakningen är aktiv. Den återkommer bara när det valda läget faktiskt uppstår.");
        router.refresh();
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte skapa bevakningen.");
      }
    });
  }

  return (
    <form className="watch-create-form" onSubmit={submit}>
      <div className="watch-create-heading">
        <div>
          <p className="eyebrow">NY BEVAKNING</p>
          <h3>Följ en fråga tills den ändras.</h3>
        </div>
        <span>Inget flöde. Bara ett tydligt villkor.</span>
      </div>
      <div className="watch-create-fields">
        <label className="stacked-field">
          <span>Vad vill du följa?</span>
          <input name="title" required minLength={2} maxLength={220} placeholder="Exempel: EU:s AI Act för företagsmjukvara" />
        </label>
        <label className="stacked-field">
          <span>Vilken fråga ska systemet hålla i?</span>
          <textarea name="rationale" rows={2} maxLength={1_000} placeholder="Exempel: Jag vill veta när det finns ett datum eller krav som påverkar våra kunder." />
        </label>
        <label className="stacked-field">
          <span>Sökord eller avgränsning <em>valfritt</em></span>
          <input name="queryText" maxLength={500} placeholder="AI Act, general-purpose AI, Sverige" />
        </label>
      </div>
      <fieldset className="watch-trigger-picker">
        <legend>Hör av dig när det här händer</legend>
        <div>
          {triggerOptions.map((option) => (
            <label key={option.value} className={selected.includes(option.value) ? "is-selected" : ""}>
              <input
                type="checkbox"
                checked={selected.includes(option.value)}
                onChange={() => toggleStatus(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="watch-material-toggle">
        <input type="checkbox" checked={onlyMaterialChange} onChange={(event) => setOnlyMaterialChange(event.target.checked)} />
        <span><strong>Endast materiell förändring</strong><small>Vanligt brus och upprepningar stoppas även om ett valt ord nämns.</small></span>
      </label>
      <div className="watch-create-actions">
        <button className="primary-button" type="submit" disabled={isPending}>{isPending ? "Skapar…" : "Starta bevakning"}</button>
        {notice && <p className={notice.includes("Kunde") || notice.includes("minst") ? "form-error" : "form-success"} role="status">{notice}</p>}
      </div>
    </form>
  );
}
