"use client";

import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import {
  canonicalSagaPersonaWebsite,
  deleteSagaPersonaContext,
  emptySagaPersonaContextInput,
  getSagaPersonaContext,
  putSagaPersonaContext,
  SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
  type SagaPersonaContextInput,
  type SagaPersonaContextView,
  type SagaPersonaIdentityMode,
} from "@/lib/client/saga-persona-context-api";
import styles from "@/components/saga-persona-context-panel.module.css";

type SaveState = "loading" | "ready" | "saving" | "unavailable" | "error";

type OrganizationRow = { id: string; name: string; role: string };
type WebsiteRow = { id: string; label: string; url: string };

type PersonaForm = {
  selfDescription: string;
  heightCm: string;
  clothing: string;
  environments: string;
  visualCountries: string;
  interests: string;
  workSummary: string;
  roles: string;
  organizations: OrganizationRow[];
  websites: WebsiteRow[];
  politicalMode: SagaPersonaIdentityMode;
  politicalDescription: string;
  religionMode: SagaPersonaIdentityMode;
  religionDescription: string;
  origin: string;
  birthCountry: string;
  visualContextConsent: boolean;
  sensitiveDataStorageConsent: boolean;
};

type SagaPersonaContextPanelProps = {
  /** Useful for isolated UI tests; production stays actor-scoped. */
  apiPath?: string;
};

function splitList(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function joinList(value: readonly string[]): string {
  return value.join("\n");
}

function optionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function rowId(prefix: string, index: number): string {
  return `${prefix}-${index}`;
}

export function personaContextFormFromView(context: SagaPersonaContextView | null): PersonaForm {
  const fallback = emptySagaPersonaContextInput();
  const current = context ?? { ...fallback, modelUse: { visualContextConsent: false, activeIntegration: false } };
  return {
    selfDescription: current.selfDescription ?? "",
    heightCm: current.heightCm?.toString() ?? "",
    clothing: joinList(current.clothing),
    environments: joinList(current.environments),
    visualCountries: joinList(current.visualCountries),
    interests: joinList(current.interests),
    workSummary: current.workSummary ?? "",
    roles: joinList(current.roles),
    organizations: current.organizations.map((organization, index) => ({
      id: rowId("organization", index),
      name: organization.name,
      role: organization.role ?? "",
    })),
    websites: current.websites.map((website, index) => ({
      id: rowId("website", index),
      label: website.label,
      url: website.url,
    })),
    politicalMode: current.political.mode,
    politicalDescription: current.political.description ?? "",
    religionMode: current.religion.mode,
    religionDescription: current.religion.description ?? "",
    origin: current.origin ?? "",
    birthCountry: current.birthCountry ?? "",
    visualContextConsent: current.visualContextConsent,
    // A receipt is intentionally write-only and must be freshly acknowledged
    // for the next saved sensitive revision.
    sensitiveDataStorageConsent: false,
  };
}

function hasSensitivePersonaData(form: PersonaForm): boolean {
  return form.politicalMode !== "not_specified"
    || form.religionMode !== "not_specified"
    || Boolean(optionalText(form.origin))
    || Boolean(optionalText(form.birthCountry));
}

function identityFromForm(mode: SagaPersonaIdentityMode, description: string) {
  const normalizedDescription = optionalText(description);
  return mode === "self_described" && normalizedDescription
    ? { mode, description: normalizedDescription } as const
    : { mode } as const;
}

function organizationsFromForm(rows: OrganizationRow[]): SagaPersonaContextInput["organizations"] {
  return rows.flatMap((row) => {
    const name = optionalText(row.name);
    const role = optionalText(row.role);
    if (!name && !role) return [];
    if (!name) throw new Error("Ange verksamhetens eller arbetsplatsens namn innan du sparar rollen.");
    return [{ name, ...(role ? { role } : {}) }];
  });
}

function websitesFromForm(rows: WebsiteRow[]): SagaPersonaContextInput["websites"] {
  return rows.flatMap((row) => {
    const label = optionalText(row.label);
    const url = optionalText(row.url);
    if (!label && !url) return [];
    if (!label || !url) throw new Error("Ge varje hemsida både ett namn och en HTTPS-adress.");
    const canonicalUrl = canonicalSagaPersonaWebsite(url);
    if (!canonicalUrl) throw new Error("Ange en offentlig HTTPS-startsida. Lokala adresser, inloggningar och undersidor sparas inte.");
    return [{ label, url: canonicalUrl }];
  });
}

export function sagaPersonaContextInputFromForm(form: PersonaForm): SagaPersonaContextInput {
  const heightText = optionalText(form.heightCm);
  const heightCm = heightText === null ? null : Number(heightText);
  if (heightCm !== null && (!Number.isInteger(heightCm) || heightCm < 80 || heightCm > 250)) {
    throw new Error("Längd ska anges i hela centimeter mellan 80 och 250.");
  }
  if (form.politicalMode === "self_described" && !optionalText(form.politicalDescription)) {
    throw new Error("Skriv en kort privat beskrivning eller välj Neutral eller Väljer att inte ange.");
  }
  if (form.religionMode === "self_described" && !optionalText(form.religionDescription)) {
    throw new Error("Skriv en kort privat beskrivning eller välj Neutral eller Väljer att inte ange.");
  }
  const sensitiveDataPresent = hasSensitivePersonaData(form);
  if (sensitiveDataPresent && !form.sensitiveDataStorageConsent) {
    throw new Error("Bekräfta att känsliga uppgifter får lagras privat innan du sparar.");
  }
  return {
    selfDescription: optionalText(form.selfDescription),
    heightCm,
    clothing: splitList(form.clothing),
    environments: splitList(form.environments),
    visualCountries: splitList(form.visualCountries),
    interests: splitList(form.interests),
    workSummary: optionalText(form.workSummary),
    roles: splitList(form.roles),
    organizations: organizationsFromForm(form.organizations),
    websites: websitesFromForm(form.websites),
    political: identityFromForm(form.politicalMode, form.politicalDescription),
    religion: identityFromForm(form.religionMode, form.religionDescription),
    origin: optionalText(form.origin),
    birthCountry: optionalText(form.birthCountry),
    visualContextConsent: form.visualContextConsent,
    ...(sensitiveDataPresent ? {
      sensitiveDataStorageConsent: {
        accepted: true,
        version: SAGA_PERSONA_SENSITIVE_STORAGE_CONSENT_VERSION,
      },
    } : {}),
  };
}

function usePersonaForm(initial: PersonaForm) {
  const [form, setForm] = useState(initial);

  function update<Key extends keyof PersonaForm>(key: Key, value: PersonaForm[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  return { form, setForm, update };
}

function Icon({ name }: { name: "private" | "person" | "spark" | "warning" | "add" | "remove" | "refresh" | "erase" }) {
  if (name === "private") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10.2" width="14" height="9.8" rx="2.1" /><path d="M8.3 10.2V7.7a3.7 3.7 0 0 1 7.4 0v2.5M12 14v2.2" strokeLinecap="round" /></svg>;
  if (name === "person") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.3" /><path d="M5.3 20c.7-3.4 3.2-5.3 6.7-5.3s6 1.9 6.7 5.3" strokeLinecap="round" /></svg>;
  if (name === "spark") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3ZM18.4 16.1l.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "warning") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 4 8.1 14H3.9L12 4Z" strokeLinejoin="round" /><path d="M12 9v4.2m0 2.8h.01" strokeLinecap="round" /></svg>;
  if (name === "add") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>;
  if (name === "remove") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.5 7.2h13M9.3 7.2V5.3h5.4v1.9m-7.8 0 .8 11.1h8.6l.8-11.1M10 10.3v5.4m4 0v-5.4" strokeLinecap="round" /></svg>;
  if (name === "refresh") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19.2 9.1A7.5 7.5 0 1 0 19 15M19.2 4.8v4.3h-4.3" strokeLinecap="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5.4 7.2 13.2 9.6M18.6 7.2 5.4 16.8" strokeLinecap="round" /><path d="M12 4.8v14.4" strokeLinecap="round" /></svg>;
}

export function SagaPersonaContextPanel({ apiPath = "/api/saga/persona-context" }: SagaPersonaContextPanelProps) {
  const fieldId = useId();
  const { form, setForm, update } = usePersonaForm(personaContextFormFromView(null));
  const [state, setState] = useState<SaveState>("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [modelUse, setModelUse] = useState<SagaPersonaContextView["modelUse"]>({ visualContextConsent: false, activeIntegration: false });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState("loading");
    setMessage(null);
    try {
      const result = await getSagaPersonaContext(apiPath, signal);
      setForm(personaContextFormFromView(result.context));
      setModelUse(result.context?.modelUse ?? { visualContextConsent: false, activeIntegration: false });
      setState("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState("unavailable");
      setMessage(error instanceof Error ? error.message : "Närvaroprofilen kan inte nås just nu.");
    }
  }, [apiPath, setForm]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // Defer the async read so this effect only subscribes/cleans up. It also
    // prevents a synchronous loading-state update during React's effect pass.
    void Promise.resolve().then(() => active ? load(controller.signal) : undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [load]);

  const isBusy = state === "loading" || state === "saving";
  const isReady = state === "ready" || state === "error";
  const sensitiveDataPresent = hasSensitivePersonaData(form);

  function updateSensitive<Key extends "politicalMode" | "politicalDescription" | "religionMode" | "religionDescription" | "origin" | "birthCountry">(
    key: Key,
    value: PersonaForm[Key],
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
      // Each sensitive change needs a fresh, explicit storage acknowledgement.
      sensitiveDataStorageConsent: false,
    }));
  }

  function setOrganization(id: string, key: "name" | "role", value: string) {
    update("organizations", form.organizations.map((row) => row.id === id ? { ...row, [key]: value } : row));
  }

  function setWebsite(id: string, key: "label" | "url", value: string) {
    update("websites", form.websites.map((row) => row.id === id ? { ...row, [key]: value } : row));
  }

  function addOrganization() {
    update("organizations", [...form.organizations, { id: rowId("organization", Date.now()), name: "", role: "" }]);
  }

  function addWebsite() {
    update("websites", [...form.websites, { id: rowId("website", Date.now()), label: "", url: "" }]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isReady) return;
    setState("saving");
    setMessage(null);
    try {
      const input = sagaPersonaContextInputFromForm(form);
      const saved = await putSagaPersonaContext(input, apiPath);
      setForm(personaContextFormFromView(saved));
      setModelUse(saved.modelUse);
      setState("ready");
      setMessage(saved.visualContextConsent
        ? "Närvaroprofilen är sparad. Visuell riktning är dokumenterad, men ingen modellintegration eller publicering körs från den här sidan."
        : "Närvaroprofilen är sparad privat. Visuell AI-användning är fortfarande avstängd.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Närvaroprofilen kunde inte sparas.");
    }
  }

  async function clearProfile() {
    if (!window.confirm("Ta bort närvaroprofilen och hela dess versionshistorik? Detta kan inte ångras från den här sidan.")) return;
    setState("saving");
    setMessage(null);
    try {
      await deleteSagaPersonaContext(apiPath);
      setForm(personaContextFormFromView(null));
      setModelUse({ visualContextConsent: false, activeIntegration: false });
      setState("ready");
      setMessage("Närvaroprofilen och dess versionshistorik är borttagna. Bildreferenserna påverkas inte.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Närvaroprofilen kunde inte rensas.");
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="persona-context-title">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>PRIVAT NÄRVAROPROFIL</p>
          <h2 id="persona-context-title">Beskriv din närvaro — på dina villkor.</h2>
          <p>Det här är ditt eget skrivna underlag för ton, kroppsspråk och miljöer. Det kompletterar fotoreferenserna, men skapar inget innehåll eller någon bild av sig självt.</p>
        </div>
        <span className={styles.privateMark}><Icon name="private" />Privat</span>
      </header>

      <section className={styles.privacyStrip} aria-label="Hur närvaroprofilen används">
        <div><span><Icon name="person" /></span><p><strong>Du beskriver själv.</strong> SAGA fyller inte i identitet från foton, länkar eller annat material.</p></div>
        <div><span><Icon name="spark" /></span><p><strong>Inget körs vid sparande.</strong> Ingen modell, bild, kalender eller publicering startas här.</p></div>
        <div><span><Icon name="private" /></span><p><strong>Känslig identitet är avstängd.</strong> Den hålls privat och används inte för modell eller publicering.</p></div>
      </section>

      {state === "unavailable" ? <section className={styles.unavailable} role="status" aria-live="polite">
        <span><Icon name="warning" /></span>
        <div><h3>Närvaroprofilen är inte tillgänglig just nu.</h3><p>{message}</p></div>
        <button type="button" onClick={() => void load()}><Icon name="refresh" />Försök igen</button>
      </section> : null}

      <form className={styles.form} onSubmit={save}>
        <section className={styles.card} aria-labelledby="persona-basics-title">
          <header className={styles.cardHeader}>
            <span className={styles.step}>01</span>
            <div><p className={styles.cardEyebrow}>VARDAG OCH UTTRYCK</p><h3 id="persona-basics-title">Det som ska kännas igen — utan att bli en mall.</h3><p>Beskriv med dina egna ord. En rad per exempel fungerar bra i fälten med flera värden.</p></div>
          </header>
          <div className={styles.fields}>
            <Field label="Kort om dig" hint="Din egen beskrivning av uttryck, temperament eller berättarperspektiv.">
              <textarea value={form.selfDescription} onChange={(event) => update("selfDescription", event.target.value)} rows={4} maxLength={1200} placeholder="Exempel: Lugn, nyfiken systembyggare som hellre visar än säljer in." disabled={!isReady || isBusy} />
            </Field>
            <div className={styles.twoColumns}>
              <Field label="Längd i centimeter" hint="Frivilligt. Används inte förrän du väljer en separat visuell riktning.">
                <input value={form.heightCm} onChange={(event) => update("heightCm", event.target.value)} inputMode="numeric" pattern="[0-9]*" placeholder="Exempel: 180" disabled={!isReady || isBusy} />
              </Field>
              <Field label="Klädsel och silhuett" hint="En rad per återkommande plagg, material eller stil.">
                <textarea value={form.clothing} onChange={(event) => update("clothing", event.target.value)} rows={3} placeholder="Mörk overshirt&#10;Slitna arbetsbyxor&#10;Diskreta färger" disabled={!isReady || isBusy} />
              </Field>
            </div>
            <Field label="Miljöer du vill återkomma till" hint="Natur, byggprojekt, arbetsmiljöer eller andra verkliga platser — inte exakta adresser.">
              <textarea value={form.environments} onChange={(event) => update("environments", event.target.value)} rows={3} placeholder="Skogsbryn&#10;Pågående byggprojekt&#10;Lugna arbetsbord" disabled={!isReady || isBusy} />
            </Field>
            <div className={styles.twoColumns}>
              <Field label="Länder och regioner med visuell relevans" hint="Frivilligt. Ange bara platser du vill associera med uttrycket.">
                <textarea value={form.visualCountries} onChange={(event) => update("visualCountries", event.target.value)} rows={3} placeholder="Sverige&#10;Norden" disabled={!isReady || isBusy} />
              </Field>
              <Field label="Intressen och återkommande teman" hint="Saker som kan hjälpa rätt känsla, inte ett innehållsfilter.">
                <textarea value={form.interests} onChange={(event) => update("interests", event.target.value)} rows={3} placeholder="Systembyggande&#10;Natur&#10;Teknik som frigör tid" disabled={!isReady || isBusy} />
              </Field>
            </div>
          </div>
        </section>

        <details className={styles.disclosure} open>
          <summary><span><Icon name="person" /></span><span><strong>Arbete, verksamheter och hemsidor</strong><small>Privata kontextuppgifter. Länkar visas och öppnas aldrig här.</small></span></summary>
          <div className={styles.disclosureBody}>
            <Field label="Ditt arbete och det du bygger" hint="Kort om verksamheter, uppdrag och problem du bryr dig om.">
              <textarea value={form.workSummary} onChange={(event) => update("workSummary", event.target.value)} rows={4} maxLength={1200} placeholder="Exempel: Jag bygger system som frigör människor från repetitivt arbete." disabled={!isReady || isBusy} />
            </Field>
            <Field label="Roller, arbeten eller uppdrag" hint="En rad per roll eller uppdrag.">
              <textarea value={form.roles} onChange={(event) => update("roles", event.target.value)} rows={3} placeholder="Grundare&#10;Systemdesigner&#10;Byggprojekt" disabled={!isReady || isBusy} />
            </Field>

            <div className={styles.repeatingSection}>
              <div><strong>Verksamheter och organisationer</strong><small>Frivilligt. Spara namn och eventuell roll — inte känsliga kunduppgifter.</small></div>
              {form.organizations.map((organization, index) => <div className={styles.row} key={organization.id}>
                <label><span className="sr-only">Namn på verksamhet eller organisation {index + 1}</span><input value={organization.name} onChange={(event) => setOrganization(organization.id, "name", event.target.value)} placeholder="Verksamhet eller organisation" disabled={!isReady || isBusy} /></label>
                <label><span className="sr-only">Roll i verksamhet eller organisation {index + 1}</span><input value={organization.role} onChange={(event) => setOrganization(organization.id, "role", event.target.value)} placeholder="Din roll (valfritt)" disabled={!isReady || isBusy} /></label>
                <button type="button" className={styles.removeButton} onClick={() => update("organizations", form.organizations.filter((row) => row.id !== organization.id))} aria-label={`Ta bort verksamhet ${index + 1}`} disabled={!isReady || isBusy}><Icon name="remove" /></button>
              </div>)}
              <button type="button" className={styles.addButton} onClick={addOrganization} disabled={!isReady || isBusy}><Icon name="add" />Lägg till verksamhet</button>
            </div>

            <div className={styles.repeatingSection}>
              <div><strong>Hemsidor</strong><small>Vi sparar endast en offentlig HTTPS-startsida som text. Den förhandsvisas eller hämtas aldrig av SAGA här.</small></div>
              {form.websites.map((website, index) => <div className={styles.row} key={website.id}>
                <label><span className="sr-only">Namn på hemsida {index + 1}</span><input value={website.label} onChange={(event) => setWebsite(website.id, "label", event.target.value)} placeholder="Namn på hemsidan" disabled={!isReady || isBusy} /></label>
                <label><span className="sr-only">HTTPS-adress för hemsida {index + 1}</span><input value={website.url} onChange={(event) => setWebsite(website.id, "url", event.target.value)} inputMode="url" placeholder="https://exempel.se" disabled={!isReady || isBusy} /></label>
                <button type="button" className={styles.removeButton} onClick={() => update("websites", form.websites.filter((row) => row.id !== website.id))} aria-label={`Ta bort hemsida ${index + 1}`} disabled={!isReady || isBusy}><Icon name="remove" /></button>
              </div>)}
              <button type="button" className={styles.addButton} onClick={addWebsite} disabled={!isReady || isBusy}><Icon name="add" />Lägg till hemsida</button>
            </div>
          </div>
        </details>

        <details className={`${styles.disclosure} ${styles.sensitiveDisclosure}`}>
          <summary><span><Icon name="private" /></span><span><strong>Valfri känslig identitet</strong><small>Privat, eget skrivet och exkluderat från AI, bilder, innehåll och publicering.</small></span></summary>
          <div className={styles.disclosureBody}>
            <section className={styles.sensitiveIntro}><Icon name="warning" /><p><strong>Du behöver inte fylla i något här.</strong> SAGA gissar inte politiskt engagemang, religion, ursprung eller födelseland från foton eller andra uppgifter. Även om du skriver något här används det inte av en modell eller i publicerat innehåll.</p></section>
            <IdentityControl id={`${fieldId}-political`} label="Politiskt engagemang" mode={form.politicalMode} description={form.politicalDescription} onModeChange={(mode) => updateSensitive("politicalMode", mode)} onDescriptionChange={(description) => updateSensitive("politicalDescription", description)} disabled={!isReady || isBusy} />
            <IdentityControl id={`${fieldId}-religion`} label="Religion eller livsåskådning" mode={form.religionMode} description={form.religionDescription} onModeChange={(mode) => updateSensitive("religionMode", mode)} onDescriptionChange={(description) => updateSensitive("religionDescription", description)} disabled={!isReady || isBusy} />
            <div className={styles.twoColumns}>
              <Field label="Ursprung eller kulturell kontext" hint="Valfritt och privat. Inte en instruktion till modellen.">
                <input value={form.origin} onChange={(event) => updateSensitive("origin", event.target.value)} placeholder="Väljer att inte ange" disabled={!isReady || isBusy} />
              </Field>
              <Field label="Födelseland" hint="Valfritt och privat. Inte en instruktion till modellen.">
                <input value={form.birthCountry} onChange={(event) => updateSensitive("birthCountry", event.target.value)} placeholder="Väljer att inte ange" disabled={!isReady || isBusy} />
              </Field>
            </div>
            {sensitiveDataPresent ? <section className={styles.sensitiveStorageConsent} aria-label="Samtycke till privat lagring av känsliga uppgifter">
              <label>
                <input type="checkbox" required checked={form.sensitiveDataStorageConsent} onChange={(event) => update("sensitiveDataStorageConsent", event.target.checked)} disabled={!isReady || isBusy} />
                <span><strong>Jag bekräftar privat lagring av de valfria känsliga uppgifterna ovan.</strong><small>Uppgifterna är självbeskrivna, stannar i den privata arbetsytan och används inte av modell, bildskapande, innehåll eller publicering. Bekräftelsen gäller den här sparningen.</small></span>
              </label>
            </section> : null}
          </div>
        </details>

        <section className={styles.usageCard} aria-labelledby="persona-usage-title">
          <header><p className={styles.cardEyebrow}>SEPARAT ANVÄNDNINGSVAL</p><h3 id="persona-usage-title">Visuell riktning kräver ditt uttryckliga val.</h3><p>Detta omfattar bara klädsel, miljöer och visuellt relevanta länder. Känslig identitet omfattas aldrig.</p></header>
          <label className={styles.consent}>
            <input type="checkbox" checked={form.visualContextConsent} onChange={(event) => update("visualContextConsent", event.target.checked)} disabled={!isReady || isBusy} />
            <span><strong>Jag vill att SAGA får spara detta som privat visuell riktning.</strong><small>Det gör inte att en modell, bildgenerering, kalender eller publicering startas automatiskt.</small></span>
          </label>
          <p className={styles.integrationStatus} role="status"><Icon name="spark" />{modelUse.activeIntegration ? "Privat visuell integration är tillåten; varje användning behöver fortfarande ett granskat bildflöde." : "Ingen modellintegration är aktiv just nu."}</p>
        </section>

        <div className={styles.actions}>
          <button type="submit" className={styles.saveButton} disabled={!isReady || isBusy}><Icon name="private" />{state === "saving" ? "Sparar privat…" : "Spara närvaroprofil"}</button>
          <p>Det här sparar bara ditt privata underlag. Det skapar inte en avatar och postar ingenting.</p>
        </div>
        {state === "error" && message ? <p className={styles.error} role="alert">{message}</p> : null}
        {state === "ready" && message ? <p className={styles.success} role="status">{message}</p> : null}
      </form>

      <details className={styles.destructive}>
        <summary>Rensa närvaroprofil</summary>
        <p>Tar bort den sparade närvaroprofilen och hela dess versionshistorik. Dina privata bildreferenser tas inte bort här.</p>
        <button type="button" onClick={() => void clearProfile()} disabled={!isReady || isBusy}><Icon name="erase" />Ta bort närvaroprofilen</button>
      </details>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}<small>{hint}</small></label>;
}

function IdentityControl({
  id,
  label,
  mode,
  description,
  onModeChange,
  onDescriptionChange,
  disabled,
}: {
  id: string;
  label: string;
  mode: SagaPersonaIdentityMode;
  description: string;
  onModeChange: (mode: SagaPersonaIdentityMode) => void;
  onDescriptionChange: (description: string) => void;
  disabled: boolean;
}) {
  return <fieldset className={styles.identityControl}>
    <legend>{label}</legend>
    <p>Helt valfritt. Standard är att inte ange något.</p>
    <div className={styles.identityOptions}>
      <label><input id={`${id}-none`} type="radio" name={id} checked={mode === "not_specified"} onChange={() => onModeChange("not_specified")} disabled={disabled} />Väljer att inte ange</label>
      <label><input id={`${id}-neutral`} type="radio" name={id} checked={mode === "neutral"} onChange={() => onModeChange("neutral")} disabled={disabled} />Neutral</label>
      <label><input id={`${id}-private`} type="radio" name={id} checked={mode === "self_described"} onChange={() => onModeChange("self_described")} disabled={disabled} />Beskriv privat</label>
    </div>
    {mode === "self_described" ? <label className={styles.privateDescription} htmlFor={`${id}-description`}><span className="sr-only">Privat beskrivning: {label}</span><textarea id={`${id}-description`} value={description} onChange={(event) => onDescriptionChange(event.target.value)} rows={3} maxLength={500} placeholder="Din egen korta beskrivning. Används inte automatiskt." disabled={disabled} /></label> : null}
  </fieldset>;
}
