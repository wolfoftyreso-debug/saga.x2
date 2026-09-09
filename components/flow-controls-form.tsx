"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { FlowControlsView } from "@/lib/domain/flow-controls";

type ModuleKey = keyof FlowControlsView["modules"];

const moduleControls: Array<{
  key: ModuleKey;
  label: string;
  detail: string;
  note?: string;
}> = [
  {
    key: "worldPulse",
    label: "Världsläge",
    detail: "Tre korta lägen: konflikt och säkerhet, ekonomi och din egen exponering.",
    note: "När detta är av får du ingen daglig ‘allt lugnt’-bedömning från den delen.",
  },
  {
    key: "weeklyRecap",
    label: "Veckan hittills",
    detail: "De viktigaste verifierade ändringarna från veckan, utöver dagens nya beslutskort.",
  },
  {
    key: "strategicRadar",
    label: "AI och affärslägen",
    detail: "Officiella modellsatsningar, konkreta möjligheter och datum eller sammanhang som är värda din tid.",
  },
  {
    key: "marketSnapshot",
    label: "Marknadsläge",
    detail: "Senaste tillgängliga index, valutakurser och marknadsrörelser. Det är fakta, inte köp- eller säljråd.",
  },
  {
    key: "companyFocus",
    label: "Bolag du följer",
    detail: "Tesla, Alphabet och Investor i marknadsdelen. SpaceX bevakas som bolag utan påhittad kurs.",
    note: "Kräver att Marknadsläge är på.",
  },
];

function equalControls(left: FlowControlsView, right: FlowControlsView) {
  return JSON.stringify({ modules: left.modules, alerts: left.alerts }) === JSON.stringify({ modules: right.modules, alerts: right.alerts });
}

export function FlowControlsForm({ initialControls }: { initialControls: FlowControlsView }) {
  const router = useRouter();
  const [controls, setControls] = useState(initialControls);
  const [savedControls, setSavedControls] = useState(initialControls);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState("");
  const dirty = useMemo(() => !equalControls(controls, savedControls), [controls, savedControls]);
  const marketEnabled = controls.modules.marketSnapshot;

  function setModule(key: ModuleKey, enabled: boolean) {
    setControls((current) => ({
      ...current,
      modules: {
        ...current.modules,
        [key]: enabled,
        ...(key === "marketSnapshot" && !enabled ? { companyFocus: false } : {}),
      },
    }));
    setState("idle");
  }

  function setAlertValue(path: "enabled" | "quietHoursEnabled" | "allowSystemicDuringQuietHours" | "start" | "end", value: boolean | string) {
    setControls((current) => ({
      ...current,
      alerts: {
        ...current.alerts,
        ...(path === "enabled" ? { enabled: Boolean(value) } : {}),
        quietHours: {
          ...current.alerts.quietHours,
          ...(path === "quietHoursEnabled" ? { enabled: Boolean(value) } : {}),
          ...(path === "allowSystemicDuringQuietHours" ? { allowSystemicDuringQuietHours: Boolean(value) } : {}),
          ...(path === "start" ? { start: String(value) } : {}),
          ...(path === "end" ? { end: String(value) } : {}),
        },
      },
    }));
    setState("idle");
  }

  async function save() {
    setState("saving");
    setMessage("");
    try {
      const response = await fetch("/api/settings/flow", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modules: controls.modules, alerts: controls.alerts }),
      });
      const payload = await response.json() as { controls?: FlowControlsView; error?: string };
      if (!response.ok || !payload.controls) throw new Error(payload.error ?? "Kunde inte spara flödeskontrollerna.");
      setControls(payload.controls);
      setSavedControls(payload.controls);
      setState("saved");
      setMessage("Flödet är uppdaterat. Ändringen används vid nästa kontroll.");
      router.refresh();
    } catch (reason) {
      setState("error");
      setMessage(reason instanceof Error ? reason.message : "Kunde inte spara flödeskontrollerna.");
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void save();
  }

  return (
    <form className="flow-controls-form settings-control-section" onSubmit={submit}>
      <div className="settings-control-section-heading">
        <p className="eyebrow">INNEHÅLL OCH AVBROTT</p>
        <h2>Bestäm vad briefen ska innehålla.</h2>
        <p>Stäng av en modul om den inte hjälper dig att fatta bättre beslut. Händelseregistret, källkraven och brusfiltret är alltid kvar.</p>
      </div>

      <section className="flow-control-group" aria-labelledby="flow-modules-title">
        <div className="flow-control-group-heading">
          <div>
            <p className="eyebrow">BRIEFENS DELAR</p>
            <h3 id="flow-modules-title">Visa bara det du använder.</h3>
          </div>
          <span>{moduleControls.filter((control) => controls.modules[control.key]).length} av {moduleControls.length} på</span>
        </div>
        <div className="flow-module-list">
          {moduleControls.map((control) => {
            const checked = controls.modules[control.key];
            const disabled = control.key === "companyFocus" && !marketEnabled;
            return (
              <label className={`flow-module-row${checked ? " is-enabled" : ""}${disabled ? " is-disabled" : ""}`} key={control.key}>
                <span className="flow-module-copy">
                  <strong>{control.label}</strong>
                  <small>{control.detail}</small>
                  {control.note && <em>{control.note}</em>}
                </span>
                <span className="flow-switch">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => setModule(control.key, event.target.checked)}
                    aria-label={`${checked ? "Stäng av" : "Slå på"} ${control.label}`}
                  />
                  <span aria-hidden="true" />
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="flow-control-group" aria-labelledby="flow-alerts-title">
        <div className="flow-control-group-heading">
          <div>
            <p className="eyebrow">DIREKTNOTISER</p>
            <h3 id="flow-alerts-title">Välj när systemet får avbryta dig.</h3>
          </div>
          <span>{controls.alerts.enabled ? "På" : "Av"}</span>
        </div>
        <label className={`flow-module-row${controls.alerts.enabled ? " is-enabled" : ""}`}>
          <span className="flow-module-copy">
            <strong>Skicka direktnotiser i chatten</strong>
            <small>Gäller bara kvalificerade händelser över din direktnotiströskel. Det här är inte pushnotiser till telefonen.</small>
          </span>
          <span className="flow-switch">
            <input type="checkbox" checked={controls.alerts.enabled} onChange={(event) => setAlertValue("enabled", event.target.checked)} aria-label="Skicka direktnotiser i chatten" />
            <span aria-hidden="true" />
          </span>
        </label>

        <div className={`quiet-hours-card${!controls.alerts.enabled ? " is-disabled" : ""}`}>
          <label className="quiet-hours-toggle">
            <input
              type="checkbox"
              checked={controls.alerts.quietHours.enabled}
              disabled={!controls.alerts.enabled}
              onChange={(event) => setAlertValue("quietHoursEnabled", event.target.checked)}
            />
            <span>
              <strong>Tysta timmar</strong>
              <small>Håll direktnotiser tills tystnaden är över. Briefar och händelser sparas ändå.</small>
            </span>
          </label>
          <div className="quiet-hours-times" aria-disabled={!controls.alerts.enabled || !controls.alerts.quietHours.enabled}>
            <label>
              <span>Från</span>
              <input type="time" value={controls.alerts.quietHours.start} disabled={!controls.alerts.enabled || !controls.alerts.quietHours.enabled} onChange={(event) => setAlertValue("start", event.target.value)} />
            </label>
            <span aria-hidden="true">→</span>
            <label>
              <span>Till</span>
              <input type="time" value={controls.alerts.quietHours.end} disabled={!controls.alerts.enabled || !controls.alerts.quietHours.enabled} onChange={(event) => setAlertValue("end", event.target.value)} />
            </label>
          </div>
          <label className="quiet-hours-override">
            <input
              type="checkbox"
              checked={controls.alerts.quietHours.allowSystemicDuringQuietHours}
              disabled={!controls.alerts.enabled || !controls.alerts.quietHours.enabled}
              onChange={(event) => setAlertValue("allowSystemicDuringQuietHours", event.target.checked)}
            />
            <span>Släpp igenom en systemisk kris även under tysta timmar.</span>
          </label>
        </div>
      </section>

      <div className="settings-save flow-controls-save">
        <button className="primary-button" type="submit" disabled={state === "saving" || !dirty}>
          {state === "saving" ? "Sparar…" : "Spara flöde och notiser"}
        </button>
        {message && <p className={state === "error" ? "form-error" : "form-success"} role="status">{message}</p>}
      </div>
    </form>
  );
}
