"use client";

import { type FormEvent, useMemo, useState } from "react";
import type { ProfileSettings } from "@/lib/domain/types";

type NumericSetting = keyof Pick<
  ProfileSettings,
  | "economyWeight"
  | "technologyWeight"
  | "regulationWeight"
  | "geopoliticsWeight"
  | "swedenEuWeight"
  | "usaWeight"
  | "gulfWeight"
  | "maxItems"
  | "relevanceThreshold"
  | "alertThreshold"
>;

const topicControls: Array<{ key: NumericSetting; label: string; description: string }> = [
  { key: "economyWeight", label: "Ekonomi och marknader", description: "Räntor, skatt, kredit, valuta och systemrisk." },
  { key: "technologyWeight", label: "Teknik och nya förmågor", description: "Modeller, agenter, moln, compute och plattformar." },
  { key: "regulationWeight", label: "Reglering och juridik", description: "Data, cybersäkerhet, upphandling och automatiserade system." },
  { key: "geopoliticsWeight", label: "Geopolitik och handel", description: "Sanktioner, exportkontroller, energi och handelsregler." },
];

const regionControls: Array<{ key: NumericSetting; label: string }> = [
  { key: "swedenEuWeight", label: "Sverige/EU" },
  { key: "usaWeight", label: "USA" },
  { key: "gulfWeight", label: "Gulfregionen" },
];

export function SettingsForm({ initialSettings }: { initialSettings: ProfileSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [savedSettings, setSavedSettings] = useState(initialSettings);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [settings, savedSettings]);

  function setNumber(key: NumericSetting, value: number) {
    setSettings((current) => ({ ...current, [key]: value }));
    setState("idle");
  }

  async function save() {
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Kunde inte spara inställningarna.");
      setSavedSettings(settings);
      setState("saved");
      setMessage("Inställningarna är sparade och används vid nästa redaktionella körning.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Kunde inte spara inställningarna.");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  return (
    <form className="settings-form" onSubmit={submit}>
      <SettingsSection title="Vad du bevakar" intro="Högre vikt gör inte en nyhet tillräcklig; den påverkar bara den personliga relevansbedömningen.">
        {topicControls.map((control) => (
          <RangeControl
            key={control.key}
            id={control.key}
            label={control.label}
            description={control.description}
            value={settings[control.key]}
            onChange={(value) => setNumber(control.key, value)}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Geografisk prioritet">
        {regionControls.map((control) => (
          <RangeControl
            key={control.key}
            id={control.key}
            label={control.label}
            value={settings[control.key]}
            onChange={(value) => setNumber(control.key, value)}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Brief">
        <label className="field-label" htmlFor="max-items">Max antal poster <span>{settings.maxItems}</span></label>
        <input
          id="max-items"
          className="range-input"
          type="range"
          min="0"
          max="5"
          value={settings.maxItems}
          onChange={(event) => setNumber("maxItems", Number(event.target.value))}
        />
        <fieldset className="segmented-control">
          <legend>Briefdjup</legend>
          <label><input type="radio" name="depth" checked={settings.briefDepth === "short"} onChange={() => setSettings((current) => ({ ...current, briefDepth: "short" }))} /> Kort</label>
          <label><input type="radio" name="depth" checked={settings.briefDepth === "deep"} onChange={() => setSettings((current) => ({ ...current, briefDepth: "deep" }))} /> Fördjupad</label>
        </fieldset>
        <RangeControl id="relevance-threshold" label="Relevanströskel" description="Normalt krävs denna poäng för att få synas." value={settings.relevanceThreshold} onChange={(value) => setNumber("relevanceThreshold", value)} />
        <RangeControl id="alert-threshold" label="Tröskel för direktnotiser" description="Systemiska undantag kan passera oavsett." value={settings.alertThreshold} onChange={(value) => setNumber("alertThreshold", value)} />
      </SettingsSection>

      <SettingsSection title="Kontext">
        <label className="field-label" htmlFor="base-region">Aktuell basregion</label>
        <select id="base-region" value={settings.baseRegion} onChange={(event) => setSettings((current) => ({ ...current, baseRegion: event.target.value }))}>
          <option>Sverige</option>
          <option>EU</option>
          <option>USA</option>
          <option>UAE</option>
          <option>Gulfregionen</option>
        </select>
        <label className="field-label" htmlFor="daily-brief-time">Daglig brief</label>
        <input id="daily-brief-time" type="time" value={settings.dailyBriefTime} onChange={(event) => setSettings((current) => ({ ...current, dailyBriefTime: event.target.value }))} />
        <label className="field-label" htmlFor="timezone">Tidszon</label>
        <select id="timezone" value={settings.timezone} onChange={(event) => setSettings((current) => ({ ...current, timezone: event.target.value }))}>
          <option value="Europe/Stockholm">Europe/Stockholm</option>
          <option value="Europe/Helsinki">Europe/Helsinki</option>
          <option value="Asia/Dubai">Asia/Dubai</option>
          <option value="America/New_York">America/New_York</option>
        </select>
      </SettingsSection>

      <div className="settings-save">
        <button className="primary-button" type="submit" disabled={state === "saving" || !dirty}>
          {state === "saving" ? "Sparar…" : "Spara inställningar"}
        </button>
        {message && <p className={state === "error" ? "form-error" : "form-success"}>{message}</p>}
      </div>
    </form>
  );
}

function SettingsSection({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <h2>{title}</h2>
      {intro && <p className="muted">{intro}</p>}
      <div className="settings-controls">{children}</div>
    </section>
  );
}

function RangeControl({ id, label, description, value, onChange }: {
  id: string;
  label: string;
  description?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="range-control">
      <label className="field-label" htmlFor={id}>{label} <span>{value}</span></label>
      {description && <p className="field-description">{description}</p>}
      <input id={id} className="range-input" type="range" min="0" max="100" value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </div>
  );
}
