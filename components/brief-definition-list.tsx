"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { BriefDefinitionView } from "@/lib/services/workspace";

const kindLabels: Record<BriefDefinitionView["kind"], string> = {
  main: "Huvudbrief",
  company: "Företag",
  economy: "Ekonomi",
  technology: "Teknik",
  regulation: "Regler",
  creator: "Creators",
  local: "Lokalt",
  custom: "Egen",
};

const weekdayLabels = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];

type BriefDraft = Omit<BriefDefinitionView, "id" | "isPrimary"> & { id?: string };

function toDraft(definition: BriefDefinitionView): BriefDraft {
  return {
    id: definition.id,
    name: definition.name,
    kind: definition.kind,
    instructions: definition.instructions,
    cadence: definition.cadence,
    localTime: definition.localTime,
    weekday: definition.weekday,
    timezone: definition.timezone,
    maxItems: definition.maxItems,
    briefDepth: definition.briefDepth,
    relevanceThreshold: definition.relevanceThreshold,
    alertThreshold: definition.alertThreshold,
    onlyWhenChanged: definition.onlyWhenChanged,
    active: definition.active,
  };
}

function newDraft(definitions: BriefDefinitionView[]): BriefDraft {
  const primary = definitions.find((definition) => definition.isPrimary) ?? definitions[0];
  return {
    name: "",
    kind: "custom",
    instructions: "",
    cadence: "daily",
    localTime: primary?.localTime ?? "07:00",
    weekday: null,
    timezone: primary?.timezone ?? "Europe/Stockholm",
    maxItems: primary?.maxItems ?? 5,
    briefDepth: primary?.briefDepth ?? "short",
    relevanceThreshold: primary?.relevanceThreshold ?? 65,
    alertThreshold: primary?.alertThreshold ?? 85,
    onlyWhenChanged: true,
    active: true,
  };
}

export function BriefDefinitionList({ definitions: initialDefinitions }: { definitions: BriefDefinitionView[] }) {
  const router = useRouter();
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const activeCount = useMemo(() => initialDefinitions.filter((definition) => definition.active).length, [initialDefinitions]);

  function beginCreate() {
    setNotice(null);
    setDraft(newDraft(initialDefinitions));
  }

  function beginEdit(definition: BriefDefinitionView) {
    setNotice(null);
    setDraft(toDraft(definition));
  }

  function persist(value: BriefDraft) {
    setNotice(null);
    startTransition(async () => {
      try {
        const method = value.id ? "PUT" : "POST";
        const body = value.id ? value : omitId(value);
        const response = await fetch("/api/brief-definitions", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte spara briefen.");
        setDraft(null);
        setNotice(value.id ? "Briefen är uppdaterad." : "Briefen är skapad.");
        router.refresh();
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte spara briefen.");
      }
    });
  }

  function setActive(definition: BriefDefinitionView, active: boolean) {
    persist({ ...toDraft(definition), active });
  }

  function remove(definition: BriefDefinitionView) {
    if (definition.isPrimary || isPending) return;
    if (!window.confirm(`Ta bort briefen “${definition.name}”? Briefar med levererad historik kan inte tas bort; pausa dem i stället.`)) return;
    setNotice(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/brief-definitions", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: definition.id }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte ta bort briefen.");
        setDraft(null);
        setNotice("Briefen är borttagen.");
        router.refresh();
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte ta bort briefen.");
      }
    });
  }

  return (
    <section className="brief-definition-section" aria-labelledby="brief-definition-heading">
      <div className="section-heading-row">
        <div><p className="eyebrow">DINA BRIEFAR</p><h2 id="brief-definition-heading">Sparade uppdrag</h2></div>
        <div className="section-heading-actions"><span>{activeCount} aktiva</span><button className="secondary-button compact-button" type="button" onClick={beginCreate} disabled={isPending}>Ny brief</button></div>
      </div>
      <p className="brief-definition-intro">Varje brief har egen frekvens, tröskel och redaktionell instruktion. Ändringar sparas direkt och påverkar nästa körning.</p>
      {notice && <p className={notice.includes("Kunde") || notice.includes("ogiltig") ? "form-error" : "form-success"} role="status">{notice}</p>}
      {draft && !draft.id && <BriefEditor draft={draft} primary={false} pending={isPending} onChange={setDraft} onCancel={() => setDraft(null)} onSubmit={persist} />}
      <div className="brief-definition-list">
        {initialDefinitions.map((definition) => (
          <article className={definition.active ? "brief-definition-card" : "brief-definition-card paused"} key={definition.id}>
            <div className="brief-definition-card-topline">
              <div>
                <span className="brief-kind">{definition.isPrimary ? "Huvudbrief" : kindLabels[definition.kind]}</span>
                {!definition.active && <span className="brief-paused-label">Pausad</span>}
                <h3>{definition.name}</h3>
                <p>{definition.instructions || "Använder din övergripande profil och relevanströskel."}</p>
              </div>
            </div>
            <div className="brief-definition-meta">
              <span>{definition.cadence === "weekly" ? `Veckovis · ${weekdayLabels[definition.weekday ?? 0]}` : "Dagligen"} · {definition.localTime}</span>
              <span>{definition.onlyWhenChanged
                ? definition.isPrimary
                  ? "Händelsekort endast vid förändring"
                  : "Endast vid förändring"
                : "Varje körning"}
              </span>
              <span>{definition.maxItems} poster · {definition.relevanceThreshold}/100</span>
            </div>
            <div className="brief-definition-actions">
              <button className="text-action" type="button" onClick={() => beginEdit(definition)} disabled={isPending}>Redigera</button>
              <Link className="text-action link-text-action" href={`/settings/brief-sources/${definition.id}`}>Briefens källor</Link>
              {!definition.isPrimary && <button className="text-action" type="button" onClick={() => setActive(definition, !definition.active)} disabled={isPending}>{definition.active ? "Pausa" : "Återuppta"}</button>}
              {!definition.isPrimary && <button className="text-action danger" type="button" onClick={() => remove(definition)} disabled={isPending}>Ta bort</button>}
            </div>
            {draft?.id === definition.id && <BriefEditor draft={draft} primary={definition.isPrimary} pending={isPending} onChange={setDraft} onCancel={() => setDraft(null)} onSubmit={persist} />}
          </article>
        ))}
      </div>
    </section>
  );
}

function omitId(draft: BriefDraft) {
  return {
    name: draft.name,
    kind: draft.kind,
    instructions: draft.instructions,
    cadence: draft.cadence,
    localTime: draft.localTime,
    weekday: draft.weekday,
    timezone: draft.timezone,
    maxItems: draft.maxItems,
    briefDepth: draft.briefDepth,
    relevanceThreshold: draft.relevanceThreshold,
    alertThreshold: draft.alertThreshold,
    onlyWhenChanged: draft.onlyWhenChanged,
    active: draft.active,
  };
}

function BriefEditor({ draft, primary, pending, onChange, onCancel, onSubmit }: {
  draft: BriefDraft;
  primary: boolean;
  pending: boolean;
  onChange: (draft: BriefDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: BriefDraft) => void;
}) {
  function update<Key extends keyof BriefDraft>(key: Key, value: BriefDraft[Key]) {
    onChange({ ...draft, [key]: value });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit({ ...draft, weekday: draft.cadence === "weekly" ? draft.weekday ?? 0 : null });
  }

  return (
    <form className="brief-editor" onSubmit={submit}>
      <div className="brief-editor-heading"><strong>{draft.id ? "Redigera brief" : "Ny brief"}</strong><span>Inget sparas förrän du väljer Spara.</span></div>
      <div className="brief-editor-grid">
        <label className="stacked-field"><span>Namn</span><input value={draft.name} required minLength={2} maxLength={80} onChange={(event) => update("name", event.target.value)} placeholder="Till exempel Europeisk AI-reglering" /></label>
        <label className="stacked-field"><span>Typ</span>
          <select value={draft.kind} disabled={primary} onChange={(event) => update("kind", event.target.value as BriefDefinitionView["kind"])}>
            {Object.entries(kindLabels).filter(([value]) => primary || value !== "main").map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="stacked-field brief-editor-full"><span>Redaktionell instruktion</span><textarea value={draft.instructions} rows={3} maxLength={2_000} onChange={(event) => update("instructions", event.target.value)} placeholder="Vad ska denna brief prioritera, och vad ska den ignorera?" /></label>
        <label className="stacked-field"><span>Frekvens</span><select value={draft.cadence} onChange={(event) => update("cadence", event.target.value as BriefDefinitionView["cadence"])}><option value="daily">Dagligen</option><option value="weekly">Veckovis</option></select></label>
        {draft.cadence === "weekly" && <label className="stacked-field"><span>Veckodag</span><select value={draft.weekday ?? 0} onChange={(event) => update("weekday", Number(event.target.value))}>{weekdayLabels.map((label, index) => <option key={label} value={index}>{label}</option>)}</select></label>}
        <label className="stacked-field"><span>Tid</span><input type="time" value={draft.localTime} onChange={(event) => update("localTime", event.target.value)} /></label>
        <label className="stacked-field"><span>Tidszon</span><input value={draft.timezone} minLength={3} maxLength={80} onChange={(event) => update("timezone", event.target.value)} /></label>
        <label className="stacked-field"><span>Max poster</span><input type="number" min="0" max="5" value={draft.maxItems} onChange={(event) => update("maxItems", Number(event.target.value))} /></label>
        <label className="stacked-field"><span>Briefdjup</span><select value={draft.briefDepth} onChange={(event) => update("briefDepth", event.target.value as BriefDefinitionView["briefDepth"])}><option value="short">Kort</option><option value="deep">Fördjupad</option></select></label>
        <label className="stacked-field"><span>Relevanströskel (0–100)</span><input type="number" min="0" max="100" value={draft.relevanceThreshold} onChange={(event) => update("relevanceThreshold", Number(event.target.value))} /></label>
        <label className="stacked-field"><span>Direktnotiströskel (0–100)</span><input type="number" min="0" max="100" value={draft.alertThreshold} onChange={(event) => update("alertThreshold", Number(event.target.value))} /></label>
      </div>
      <div className="brief-editor-toggles">
        <label><input type="checkbox" checked={draft.onlyWhenChanged} onChange={(event) => update("onlyWhenChanged", event.target.checked)} /> Endast vid materiell förändring</label>
        {primary ? <span>Huvudbriefen är alltid aktiv. Världsläge kan ändå visas varje dag när modulen är på.</span> : <label><input type="checkbox" checked={draft.active} onChange={(event) => update("active", event.target.checked)} /> Aktiv</label>}
      </div>
      <div className="brief-editor-actions"><button className="primary-button" disabled={pending} type="submit">{pending ? "Sparar…" : "Spara brief"}</button>{draft.id && <Link className="text-action link-text-action" href={`/settings/brief-sources/${draft.id}`}>Briefens källor</Link>}<button className="text-action" disabled={pending} type="button" onClick={onCancel}>Avbryt</button></div>
    </form>
  );
}
