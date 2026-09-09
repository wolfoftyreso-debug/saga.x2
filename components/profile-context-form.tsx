"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { ProfileContextView } from "@/lib/services/workspace";

type FormState = {
  workSummary: string;
  roleTitle: string;
  organizations: string;
  sectors: string;
  markets: string;
  dependencies: string;
  decisions: string;
  risks: string;
  opportunities: string;
  interests: string;
  exclusions: string;
  languages: string;
};

const suggestedCompanyFocus = ["Tesla", "SpaceX", "Investor", "Alphabet"];
const suggestedOpportunityFocus = [
  "Officiellt annonserade AI-modellfunktioner och datum",
  "Konkreta AI-affärsmöjligheter, upphandlingar och partnerskap",
  "Konferenser, deadlines och sammanhang där närvaro kan vara värd tiden",
];

function initialState(context: ProfileContextView | null): FormState {
  return {
    workSummary: context?.workSummary ?? "",
    roleTitle: context?.roleTitle ?? "",
    organizations: context?.organizations.join(", ") ?? "",
    sectors: context?.sectors.join(", ") ?? "",
    markets: context?.markets.join(", ") ?? "",
    dependencies: context?.dependencies.join(", ") ?? "",
    decisions: context?.decisions.join(", ") ?? "",
    risks: context?.risks.join(", ") ?? "",
    opportunities: context?.opportunities.join(", ") ?? "",
    interests: context?.interests.join(", ") ?? "",
    exclusions: context?.exclusions.join(", ") ?? "",
    languages: context?.languages.join(", ") ?? "sv, en",
  };
}

function split(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function appendList(value: string, additions: readonly string[]): string {
  const current = split(value);
  const seen = new Set(current.map((item) => item.toLocaleLowerCase("sv-SE")));
  const merged = [...current];
  for (const addition of additions) {
    if (!seen.has(addition.toLocaleLowerCase("sv-SE"))) merged.push(addition);
  }
  return merged.join(", ");
}

export function ProfileContextForm({ initialContext, onboarding = false }: { initialContext: ProfileContextView | null; onboarding?: boolean }) {
  const router = useRouter();
  const initial = useMemo(() => initialState(initialContext), [initialContext]);
  const [form, setForm] = useState(initial);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");

  function update(key: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
    setState("idle");
  }

  function addSuggestedFocus() {
    setForm((current) => ({
      ...current,
      interests: appendList(current.interests, suggestedCompanyFocus),
      opportunities: appendList(current.opportunities, suggestedOpportunityFocus),
    }));
    setState("idle");
    setMessage("Fokusområdena är tillagda. Spara profilen för att använda dem i nästa brief.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/profile-context", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workSummary: form.workSummary,
          roleTitle: form.roleTitle,
          organizations: split(form.organizations),
          sectors: split(form.sectors),
          markets: split(form.markets),
          dependencies: split(form.dependencies),
          decisions: split(form.decisions),
          risks: split(form.risks),
          opportunities: split(form.opportunities),
          interests: split(form.interests),
          exclusions: split(form.exclusions),
          languages: split(form.languages),
          onboardingComplete: true,
        }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Kunde inte spara profilen.");
      setState("saved");
      setMessage(onboarding ? "Profilen är sparad. Jag använder den vid nästa redaktionella körning." : "Din synliga relevansprofil är uppdaterad.");
      router.refresh();
      if (onboarding) router.push("/");
    } catch (reason) {
      setState("error");
      setMessage(reason instanceof Error ? reason.message : "Kunde inte spara profilen.");
    }
  }

  return (
    <form className="profile-context-form" onSubmit={submit}>
      <section id={onboarding ? undefined : "profile-control"} className="settings-section">
        <p className="eyebrow">DITT SAMMANHANG</p>
        <h2>{onboarding ? "Berätta vad som berör dig" : "Det här använder systemet som relevanskontext"}</h2>
        <p className="muted">Profilen kan omfatta arbete, vardag och personliga intressen. Den är synlig och redigerbar, inte ett dolt minne.</p>
        <div className="settings-controls">
          <TextField label="Din roll" value={form.roleTitle} onChange={(value) => update("roleTitle", value)} placeholder="Exempel: Grundare och teknisk beslutsfattare" />
          <TextArea label="Kort om din vardag, ditt arbete och dina verksamheter" value={form.workSummary} onChange={(value) => update("workSummary", value)} placeholder="Vad du gör, vilka beslut du tar och vad som gör information relevant för dig." />
          <TextField label="Företag och organisationer" value={form.organizations} onChange={(value) => update("organizations", value)} placeholder="Kommaseparerat" />
          <TextField label="Branscher, områden eller återkommande ämnen" value={form.sectors} onChange={(value) => update("sectors", value)} placeholder="Programvara, betalningar, offentlig sektor" />
          <TextField label="Viktiga marknader och länder" value={form.markets} onChange={(value) => update("markets", value)} placeholder="Sverige, EU, USA" />
          <TextField label="Viktiga leverantörer eller beroenden" value={form.dependencies} onChange={(value) => update("dependencies", value)} placeholder="Molnplattformar, modeller, betalningsleverantörer" />
        </div>
      </section>
      <section id={onboarding ? undefined : "focus-control"} className="settings-section">
        <p className="eyebrow">VAD DU VILL HÅLLA KOLL PÅ</p>
        <div className="settings-controls">
          <TextField label="Beslut du står inför" value={form.decisions} onChange={(value) => update("decisions", value)} placeholder="Kommaseparerat" />
          <TextField label="Risker eller frågor att bevaka" value={form.risks} onChange={(value) => update("risks", value)} placeholder="Kommaseparerat" />
          <div id={onboarding ? undefined : "radar-control"} className="profile-radar-control">
            <TextField label="Affärsmöjligheter och sammanhang du letar efter" value={form.opportunities} onChange={(value) => update("opportunities", value)} placeholder="Upphandlingar, partnerskap, konferenser" />
          </div>
          <TextField label="Bolag, aktier och ämnen som alltid ska prioriteras" value={form.interests} onChange={(value) => update("interests", value)} placeholder="Tesla, SpaceX, Investor, Alphabet" />
          <TextField label="Sådant du uttryckligen vill undvika" value={form.exclusions} onChange={(value) => update("exclusions", value)} placeholder="Generella börsrörelser, inrikespolitik" />
          <TextField label="Tillåtna språk" value={form.languages} onChange={(value) => update("languages", value)} placeholder="sv, en" />
        </div>
        <aside className="profile-focus-starter">
          <div>
            <p className="eyebrow">FÖRESLAGEN START</p>
            <strong>Tesla, SpaceX, Investor, Alphabet, AI-roadmaps, affärslägen och relevanta sammanhang.</strong>
            <span>Bolagen blir en prioriterad bevakning. SpaceX får bara kursdata om en verifierbar notering finns.</span>
          </div>
          <button className="secondary-button" type="button" onClick={addSuggestedFocus}>Lägg till i min profil</button>
        </aside>
      </section>
      <div className="profile-save-row">
        <button className="primary-button" type="submit" disabled={state === "saving"}>{state === "saving" ? "Sparar…" : onboarding ? "Spara och börja" : "Spara profil"}</button>
        {message && <p className={state === "error" ? "form-error" : "form-success"}>{message}</p>}
      </div>
    </form>
  );
}

function TextField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="stacked-field"><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function TextArea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="stacked-field"><span>{label}</span><textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}
