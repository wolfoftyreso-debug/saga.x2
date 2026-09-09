"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import {
  createSagaOutgoingApi,
  getSagaOutgoingApis,
  revokeSagaOutgoingApi,
  rotateSagaOutgoingApi,
  sagaOutgoingContentTypeOptions,
  sagaOutgoingVisibilityOptions,
  type SagaOutgoingApiCreated,
  type SagaOutgoingApiExport,
  type SagaOutgoingContentType,
  type SagaOutgoingVisibility,
} from "@/lib/client/saga-outgoing-api";
import styles from "@/components/saga-outgoing-api-panel.module.css";

type LoadState = "loading" | "ready" | "unavailable" | "error";
type MutationState = "idle" | "creating" | "revoking" | "rotating";

type SagaOutgoingApiPanelProps = {
  /** Production stays session-scoped. Exposed only for focused browser/UI tests. */
  apiPath?: string;
  /** The server enforces this again; the UI keeps non-owners out of a dead-end form. */
  canManage?: boolean;
  /** Avoids a misleading client request when there is no signed workspace yet. */
  workspaceReady?: boolean;
};

const allContentTypes = sagaOutgoingContentTypeOptions.map((option) => option.value);

function Icon({ name }: { name: "api" | "lock" | "copy" | "check" | "warning" | "arrow" | "revoke" | "refresh" | "hide" | "read" }) {
  if (name === "api") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.8" y="5.2" width="16.4" height="13.6" rx="2.6" /><path d="M7.5 9.4h9M7.5 12.5h4.1M16.8 15.5h.01" strokeLinecap="round" /></svg>;
  if (name === "lock") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5.2" y="10" width="13.6" height="9.8" rx="2" /><path d="M8.4 10V7.7a3.6 3.6 0 0 1 7.2 0V10M12 14v2" strokeLinecap="round" /></svg>;
  if (name === "copy") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8.1" y="7.5" width="11.2" height="12" rx="2" /><path d="M15.9 7.5V5.7a2 2 0 0 0-2-2H6.7a2 2 0 0 0-2 2v9.6a2 2 0 0 0 2 2h1.4" strokeLinecap="round" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5.2 12.2 4.1 4.1 9.5-9.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "warning") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 4 8.2 14.3H3.8L12 4Z" strokeLinejoin="round" /><path d="M12 9v4.4m0 2.7h.01" strokeLinecap="round" /></svg>;
  if (name === "arrow") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13.5M13.5 6.8 18.7 12l-5.2 5.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "revoke") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.7 6.1a8.3 8.3 0 1 0 1.4 8.8M18.7 3.8v4.7H14" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "refresh") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 9.2A7.5 7.5 0 1 0 19 14.8M19 4.7v4.5h-4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "hide") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m4.3 4.3 15.4 15.4M10 6.1A10.4 10.4 0 0 1 20 12c-1.4 2.4-3.9 4.5-7.6 5.5M7.4 7.5A11.7 11.7 0 0 0 4 12c1.7 3 4.8 5.4 8 5.4 1 0 1.9-.2 2.8-.5M9.8 9.8a3 3 0 0 0 4.4 4.4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.2 4.5h11.5l2.1 2.1v12.9H5.2V4.5Z" /><path d="M8.2 9h7.6M8.2 12.5h7.6M8.2 16h4.3" strokeLinecap="round" /></svg>;
}

function formatDate(value: string | null) {
  if (!value) return "Aldrig";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Okänd tidpunkt";
  return new Intl.DateTimeFormat("sv-SE", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function absoluteEndpoint(endpoint: string) {
  if (typeof window === "undefined" || /^https:\/\//iu.test(endpoint)) return endpoint;
  return new URL(endpoint, window.location.origin).toString();
}

function shellSingleQuote(value: string) {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function sagaOutgoingApiCurlCommand(endpoint: string, bearerToken: string) {
  return `curl --fail-with-body --silent --show-error --header ${shellSingleQuote(`Authorization: Bearer ${bearerToken}`)} ${shellSingleQuote(endpoint)}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("copy_failed");
}

function labelForContentType(value: SagaOutgoingContentType) {
  return sagaOutgoingContentTypeOptions.find((option) => option.value === value)?.label ?? value;
}

function labelForVisibility(value: SagaOutgoingVisibility) {
  return sagaOutgoingVisibilityOptions.find((option) => option.value === value)?.label ?? value;
}

function containsEveryContentType(values: readonly SagaOutgoingContentType[]) {
  return allContentTypes.every((type) => values.includes(type));
}

export function SagaOutgoingApiPanel({
  apiPath = "/api/saga/outgoing-apis",
  canManage = true,
  workspaceReady = true,
}: SagaOutgoingApiPanelProps) {
  const fieldId = useId();
  const [exports, setExports] = useState<SagaOutgoingApiExport[]>([]);
  const [loadState, setLoadState] = useState<LoadState>(workspaceReady && canManage ? "loading" : "unavailable");
  const [mutation, setMutation] = useState<MutationState>("idle");
  const [name, setName] = useState("");
  const [contentTypes, setContentTypes] = useState<SagaOutgoingContentType[]>(allContentTypes);
  const [visibility, setVisibility] = useState<SagaOutgoingVisibility>("published_only");
  const [created, setCreated] = useState<SagaOutgoingApiCreated | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!workspaceReady || !canManage) {
      setLoadState("unavailable");
      return;
    }
    setLoadState("loading");
    setNotice(null);
    try {
      const result = await getSagaOutgoingApis(apiPath, signal);
      setExports(result);
      setLoadState("ready");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadState("error");
      setNotice(error instanceof Error ? error.message : "API-exporterna kan inte nås just nu.");
    }
  }, [apiPath, canManage, workspaceReady]);

  useEffect(() => {
    if (!workspaceReady || !canManage) return;
    const controller = new AbortController();
    let active = true;
    void Promise.resolve().then(() => active ? load(controller.signal) : undefined);
    return () => {
      active = false;
      controller.abort();
    };
  }, [canManage, load, workspaceReady]);

  const activeExports = useMemo(() => exports.filter((item) => item.status === "active"), [exports]);
  const inactiveExports = useMemo(() => exports.filter((item) => item.status !== "active"), [exports]);
  const canCreate = loadState === "ready" && mutation === "idle" && name.trim().length >= 2 && contentTypes.length > 0;
  const secretEndpoint = created ? absoluteEndpoint(created.api.endpoint) : "";

  function toggleContentType(value: SagaOutgoingContentType) {
    setContentTypes((current) => current.includes(value)
      ? current.filter((item) => item !== value)
      : [...current, value]);
    setNotice(null);
  }

  function toggleAllContentTypes() {
    setContentTypes((current) => containsEveryContentType(current) ? [] : allContentTypes);
    setNotice(null);
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      setNotice(`${label} kopierades.`);
    } catch {
      setNotice("Kunde inte kopiera. Markera och kopiera manuellt.");
    }
  }

  function createExport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length < 2 || !contentTypes.length) {
      setNotice("Ge exporten ett namn och välj minst en innehållstyp.");
      return;
    }
    setMutation("creating");
    setNotice(null);
    void (async () => {
      try {
        const result = await createSagaOutgoingApi({
          name: trimmedName,
          contentTypes: containsEveryContentType(contentTypes) ? "all" : contentTypes,
          visibility,
        }, apiPath);
        setExports((current) => [result.api, ...current.filter((item) => item.id !== result.api.id)]);
        setCreated(result);
        setName("");
        setContentTypes(allContentTypes);
        setVisibility("published_only");
        setNotice(null);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "API-exporten kunde inte skapas.");
      } finally {
        setMutation("idle");
      }
    })();
  }

  function revokeExport(item: SagaOutgoingApiExport) {
    if (!window.confirm(`Återkalla “${item.name}”? Den kopplingen förlorar åtkomst direkt.`)) return;
    setMutation("revoking");
    setNotice(null);
    void (async () => {
      try {
        await revokeSagaOutgoingApi(item.id, apiPath);
        setExports((current) => current.map((entry) => entry.id === item.id
          ? { ...entry, status: "revoked", updatedAt: new Date().toISOString() }
          : entry));
        setNotice(`“${item.name}” är återkallad.`);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "API-exporten kunde inte återkallas.");
      } finally {
        setMutation("idle");
      }
    })();
  }

  function rotateExport(item: SagaOutgoingApiExport) {
    if (!window.confirm(`Rotera nyckeln för “${item.name}”? Den nuvarande nyckeln slutar fungera direkt.`)) return;
    setMutation("rotating");
    setNotice(null);
    void (async () => {
      try {
        const result = await rotateSagaOutgoingApi(item.id, apiPath);
        setExports((current) => current.map((entry) => entry.id === item.id ? result.api : entry));
        setCreated(result);
        setNotice(null);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Nyckeln kunde inte roteras.");
      } finally {
        setMutation("idle");
      }
    })();
  }

  const unavailableReason = !workspaceReady
    ? "En utgående API-export kan skapas när din privata arbetsyta är redo."
    : "Bara arbetsytans ägare kan skapa och återkalla API-exporter.";

  return (
    <section className={styles.panel} aria-labelledby="outgoing-api-title">
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>INTEGRATIONER · LÄS-API</p>
          <h1 id="outgoing-api-title">Låt rätt system läsa rätt innehåll.</h1>
          <p>Skapa en avgränsad, privat API-export för ett externt system. Du väljer innehåll och status först — SAGA skickar inga inlägg, mejl eller webhooks från den här inställningen.</p>
        </div>
        <div className={styles.heroTrust} aria-label="Säkerhetsprinciper">
          <span className={styles.heroIcon}><Icon name="lock" /></span>
          <div><strong>Läsning, aldrig publicering</strong><small>En nyckel ger bara åtkomst till det du uttryckligen väljer.</small></div>
        </div>
      </header>

      <section className={styles.guardrails} aria-label="API-exportens gränser">
        <Guardrail icon="read" title="Avgränsat innehåll" detail="Välj sociala inlägg, nyhetsbrev, artiklar eller allt." />
        <Guardrail icon="check" title="Aldrig utkast" detail="Privata utkast, råmaterial, media och personreferenser lämnar aldrig exporten." />
        <Guardrail icon="lock" title="Nyckel per koppling" detail="Varje export får en egen bearer-nyckel som kan återkallas direkt." />
      </section>

      {!workspaceReady || !canManage ? (
        <section className={styles.unavailable} role="status" aria-live="polite">
          <span><Icon name={!workspaceReady ? "warning" : "lock"} /></span>
          <div><h2>{!workspaceReady ? "API-exporter är inte redo än." : "API-exporter hanteras av arbetsytans ägare."}</h2><p>{unavailableReason}</p></div>
        </section>
      ) : <>
        {created ? <CreatedSecretCard created={created} endpoint={secretEndpoint} onCopy={copy} onDismiss={() => setCreated(null)} /> : null}

        <div className={styles.workspace}>
          <section className={styles.createCard} aria-labelledby="outgoing-create-title">
            <header className={styles.sectionHeader}>
              <span className={styles.step}>01</span>
              <div><p className={styles.eyebrow}>SKAPA EN EXPORT</p><h2 id="outgoing-create-title">Bestäm gränsen innan du delar åtkomst.</h2><p>Skapa en separat export för varje integration. Det gör det enkelt att förstå, spåra och återkalla åtkomst.</p></div>
            </header>

            <form className={styles.form} onSubmit={createExport}>
              <label className={styles.nameField} htmlFor={`${fieldId}-name`}>
                <span>Namn på integrationen</span>
                <input id={`${fieldId}-name`} value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} placeholder="Exempel: Automationsserver" disabled={loadState !== "ready" || mutation !== "idle"} required />
                <small>Syns bara i SAGA, så namnge systemet eller flödet som använder API:t.</small>
              </label>

              <fieldset className={styles.scopePicker} disabled={loadState !== "ready" || mutation !== "idle"}>
                <legend>Vilket innehåll får integrationen läsa?</legend>
                <label className={`${styles.scopeOption} ${containsEveryContentType(contentTypes) ? styles.scopeOptionSelected : ""}`}>
                  <input type="checkbox" checked={containsEveryContentType(contentTypes)} onChange={toggleAllContentTypes} />
                  <span className={styles.scopeMark}><Icon name="check" /></span>
                  <span><strong>Allt godkänt innehåll</strong><small>Sociala inlägg, nyhetsbrev och artiklar.</small></span>
                </label>
                <div className={styles.scopeGrid}>
                  {sagaOutgoingContentTypeOptions.map((option) => {
                    const selected = contentTypes.includes(option.value);
                    return <label className={`${styles.scopeOption} ${selected ? styles.scopeOptionSelected : ""}`} key={option.value}>
                      <input type="checkbox" checked={selected} onChange={() => toggleContentType(option.value)} />
                      <span className={styles.scopeMark}><Icon name="check" /></span>
                      <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                    </label>;
                  })}
                </div>
              </fieldset>

              <fieldset className={styles.visibilityPicker} disabled={loadState !== "ready" || mutation !== "idle"}>
                <legend>Vilken status får lämna SAGA?</legend>
                <div>
                  {sagaOutgoingVisibilityOptions.map((option) => <label className={visibility === option.value ? styles.visibilitySelected : ""} key={option.value}>
                    <input type="radio" name="outgoing-api-visibility" value={option.value} checked={visibility === option.value} onChange={() => setVisibility(option.value)} />
                    <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  </label>)}
                </div>
                <p><Icon name="warning" />Utkast, arbetsmaterial, privata bildreferenser och hemligheter ingår aldrig.</p>
              </fieldset>

              <div className={styles.createActions}>
                <button className={styles.primaryAction} type="submit" disabled={!canCreate}><Icon name="api" />{mutation === "creating" ? "Skapar säker export…" : "Skapa API-export"}</button>
                <span>Bearer-nyckeln visas en gång — sedan kan du bara återkalla och skapa en ny.</span>
              </div>
            </form>
          </section>

          <aside className={styles.guideCard} aria-labelledby="outgoing-how-title">
            <span className={styles.guideIcon}><Icon name="api" /></span>
            <p className={styles.eyebrow}>SÅ ANVÄNDS DEN</p>
            <h2 id="outgoing-how-title">Det andra systemet hämtar. SAGA pushar inte.</h2>
            <ol>
              <li><span>1</span><p><strong>Skapa en avgränsad export</strong><small>Välj format och innehållsstatus.</small></p></li>
              <li><span>2</span><p><strong>Spara bearer-nyckeln</strong><small>Den visas bara i nästa steg.</small></p></li>
              <li><span>3</span><p><strong>Koppla via GET</strong><small>Det externa systemet läser endpointen med nyckeln.</small></p></li>
            </ol>
            <p className={styles.guideFoot}><Icon name="lock" />Ingen automatisk publicering aktiveras av att skapa API:t.</p>
          </aside>
        </div>

        <section className={styles.library} aria-labelledby="outgoing-library-title">
          <header className={styles.libraryHeader}>
            <div><p className={styles.eyebrow}>AKTIVA API-EXPORTER</p><h2 id="outgoing-library-title">Kopplingar du har skapat.</h2><p>Här ser du exakt vilka gränser varje extern integration har.</p></div>
            <span>{activeExports.length} {activeExports.length === 1 ? "aktiv" : "aktiva"}</span>
          </header>

          {loadState === "loading" ? <LibrarySkeleton /> : null}
          {loadState === "error" ? <section className={styles.loadError} role="alert"><div><strong>API-exporterna kunde inte läsas.</strong><p>{notice ?? "Försök igen."}</p></div><button type="button" onClick={() => void load()}><Icon name="refresh" />Försök igen</button></section> : null}
          {loadState === "ready" && activeExports.length === 0 ? <div className={styles.empty}><span><Icon name="api" /></span><div><h3>Inga API-exporter ännu.</h3><p>Skapa en när ett externt system verkligen ska läsa ett tydligt avgränsat innehållsflöde.</p></div></div> : null}
          {loadState === "ready" && activeExports.length > 0 ? <ul className={styles.exportList}>
            {activeExports.map((item) => <ExportRow key={item.id} item={item} busy={mutation !== "idle"} onCopy={copy} onRevoke={revokeExport} onRotate={rotateExport} />)}
          </ul> : null}
        </section>

        {inactiveExports.length > 0 ? <details className={styles.revoked}><summary>Återkallade eller utgångna exporter ({inactiveExports.length})</summary><ul className={styles.exportList}>{inactiveExports.map((item) => <ExportRow key={item.id} item={item} busy={false} onCopy={copy} />)}</ul></details> : null}
      </>}

      {notice && loadState !== "error" ? <p className={notice.startsWith("Kunde") || notice.startsWith("Ge ") ? styles.errorMessage : styles.successMessage} role="status">{notice}</p> : null}
    </section>
  );
}

function Guardrail({ icon, title, detail }: { icon: "read" | "check" | "lock"; title: string; detail: string }) {
  return <div><span><Icon name={icon} /></span><p><strong>{title}</strong><small>{detail}</small></p></div>;
}

function CreatedSecretCard({ created, endpoint, onCopy, onDismiss }: { created: SagaOutgoingApiCreated; endpoint: string; onCopy: (value: string, label: string) => Promise<void>; onDismiss: () => void }) {
  const curl = sagaOutgoingApiCurlCommand(endpoint, created.bearerToken);
  return <section className={styles.secretCard} aria-labelledby="outgoing-secret-title">
    <header><div><p className={styles.eyebrow}>SPARA NYCKELN NU</p><h2 id="outgoing-secret-title">Bearer-nyckeln visas bara den här gången.</h2><p>Kopiera den till en lösenordshanterare eller din integreringsplattform. När du döljer rutan finns den inte kvar i SAGA.</p></div><button className={styles.dismissButton} type="button" onClick={onDismiss}><Icon name="hide" />Dölj och glöm</button></header>
    <CopyValue label="BEARER-NYCKEL" value={created.bearerToken} buttonLabel="Kopiera nyckel" onCopy={onCopy} secret />
    <div className={styles.secretUsage}>
      <CopyValue label="LÄS-ENDPOINT" value={endpoint} buttonLabel="Kopiera endpoint" onCopy={onCopy} />
      <CopyValue label="CURL MED NYCKEL" value={curl} buttonLabel="Kopiera cURL" onCopy={onCopy} secret />
    </div>
    <p className={styles.secretWarning}><Icon name="warning" /><span><strong>Håll nyckeln privat.</strong> Den fungerar som ett lösenord för “{created.api.name}”. Endpointen i sig ger ingen åtkomst utan bearer-nyckeln.</span></p>
  </section>;
}

function CopyValue({ label, value, buttonLabel, onCopy, secret = false }: { label: string; value: string; buttonLabel: string; onCopy: (value: string, label: string) => Promise<void>; secret?: boolean }) {
  return <div className={`${styles.copyValue} ${secret ? styles.copyValueSecret : ""}`}>
    <div><span>{label}</span><code>{value}</code></div>
    <button type="button" onClick={() => void onCopy(value, label.toLocaleLowerCase("sv-SE"))}><Icon name="copy" />{buttonLabel}</button>
  </div>;
}

function ExportRow({ item, busy, onCopy, onRevoke, onRotate }: { item: SagaOutgoingApiExport; busy: boolean; onCopy: (value: string, label: string) => Promise<void>; onRevoke?: (item: SagaOutgoingApiExport) => void; onRotate?: (item: SagaOutgoingApiExport) => void }) {
  const inactive = item.status !== "active";
  const endpoint = absoluteEndpoint(item.endpoint);
  return <li className={`${styles.exportRow} ${inactive ? styles.exportRowRevoked : ""}`}>
    <span className={styles.exportMark}><Icon name="api" /></span>
    <div className={styles.exportCore}><div className={styles.exportTitle}><strong>{item.name}</strong><span>{item.status === "revoked" ? "Återkallad" : item.status === "expired" ? "Utgången" : "Aktiv"}</span></div><p>{item.contentTypes.map(labelForContentType).join(" · ")} <i aria-hidden="true">·</i> {labelForVisibility(item.visibility)}</p><code>{endpoint}</code></div>
    <div className={styles.exportMeta}><span>{item.keyPrefix ? `Nyckelprefix ${item.keyPrefix}` : "Nyckelprefix dolt"}</span><span>Skapad {formatDate(item.createdAt)}</span><span>{item.lastUsedAt ? `Senast läst ${formatDate(item.lastUsedAt)}` : "Aldrig använd"}</span><span>{item.expiresAt ? `Går ut ${formatDate(item.expiresAt)}` : "Ingen automatisk utgång"}</span></div>
    <div className={styles.exportActions}><button type="button" onClick={() => void onCopy(endpoint, "Endpoint")}><Icon name="copy" />Kopiera endpoint</button>{!inactive && onRotate ? <button type="button" disabled={busy} onClick={() => onRotate(item)}><Icon name="refresh" />{busy ? "Uppdaterar…" : "Rotera nyckel"}</button> : null}{!inactive && onRevoke ? <button className={styles.revokeButton} type="button" disabled={busy} onClick={() => onRevoke(item)}><Icon name="revoke" />{busy ? "Återkallar…" : "Återkalla"}</button> : null}</div>
  </li>;
}

function LibrarySkeleton() {
  return <div className={styles.skeleton} aria-label="Läser API-exporter"><i /><i /><i /></div>;
}
