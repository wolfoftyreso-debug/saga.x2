"use client";

import { useMemo, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SourceKind, SourceRole } from "@/lib/domain/source-catalog";
import type { SourcePolicyView } from "@/lib/services/workspace";

const roleLabels: Record<SourceRole, string> = {
  discovery: "Upptäckt",
  analysis: "Analys",
  verification: "Verifiering",
  citation: "Citering",
  direct_monitoring: "Direktbevakning",
};

const kindLabels: Record<SourceKind, string> = {
  primary: "Primärkälla",
  editorial: "Redaktionellt medium",
  company: "Företagskälla",
  creator: "Creator",
  podcast: "Podd",
  custom: "Egen källa",
};

const frequencyLabels = {
  all_relevant: "Alla relevanta tillfällen",
  daily: "Daglig genomgång",
  weekly: "Veckovis genomgång",
  material: "Endast materiella förändringar",
} as const;

const verificationLabels = {
  none: "Ingen extra regel",
  verify_material: "Verifiera materiella uppgifter",
  primary_only: "Kräv primärkälla",
  two_independent: "Kräv två oberoende källor",
} as const;

export function SourceCatalog({
  initialSources,
  briefDefinitionId,
  definitionName,
  overrideDomains = [],
}: {
  initialSources: SourcePolicyView[];
  briefDefinitionId?: string;
  definitionName?: string;
  overrideDomains?: string[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | SourceKind>("all");
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const visible = useMemo(() => initialSources.filter((source) => {
    const matchesQuery = `${source.sourceName} ${source.domain}`.toLocaleLowerCase("sv-SE").includes(query.toLocaleLowerCase("sv-SE"));
    return matchesQuery && (kind === "all" || source.sourceKind === kind);
  }), [initialSources, query, kind]);

  function save(source: SourcePolicyView) {
    setNotice(null);
    startTransition(async () => {
      try {
        const response = await fetch(briefDefinitionId ? "/api/brief-source-policies" : "/api/sources", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(briefDefinitionId ? {
            briefDefinitionId,
            domain: source.domain,
            active: source.active,
            blocked: source.blocked,
            priority: source.priority,
            roles: source.roles,
            topicFilter: source.topicFilter,
            verificationRequirement: source.verificationRequirement,
            frequency: source.frequency,
          } : {
            domain: source.domain,
            sourceName: source.sourceName,
            sourceKind: source.sourceKind,
            active: source.active,
            blocked: source.blocked,
            priority: source.priority,
            roles: source.roles,
            topicFilter: source.topicFilter,
            verificationRequirement: source.verificationRequirement,
            frequency: source.frequency,
          }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte spara källregeln.");
        setNotice(`${source.sourceName}: ${source.blocked ? "blockerad" : source.active ? "uppdaterad" : "avstängd"}.`);
        router.refresh();
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte spara källregeln.");
      }
    });
  }

  function resetOverride(source: SourcePolicyView) {
    if (!briefDefinitionId) return;
    setNotice(null);
    startTransition(async () => {
      try {
        const response = await fetch("/api/brief-source-policies", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ briefDefinitionId, domain: source.domain }),
        });
        const payload = await response.json() as { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Kunde inte återställa källregeln.");
        setNotice(`${source.sourceName} ärver nu din globala källpolicy igen.`);
        router.refresh();
      } catch (reason) {
        setNotice(reason instanceof Error ? reason.message : "Kunde inte återställa källregeln.");
      }
    });
  }

  function addSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const domain = String(form.get("domain") ?? "").trim();
    const sourceName = String(form.get("name") ?? "").trim() || domain;
    const sourceKind = String(form.get("sourceKind") ?? "custom") as SourceKind;
    if (!domain) return;
    save({
      id: null,
      sourceId: null,
      domain,
      sourceName,
      sourceKind,
      active: true,
      blocked: false,
      priority: "normal",
      roles: ["discovery", "analysis"],
      topicFilter: "",
      verificationRequirement: "verify_material",
      frequency: "material",
      isCustom: true,
    });
    event.currentTarget.reset();
  }

  return (
    <div className="source-catalog">
      <section className="source-policy-explainer">
        <strong>{briefDefinitionId ? `Egna källregler för ${definitionName ?? "den här briefen"}.` : "En blockering är teknisk, inte kosmetisk."}</strong>
        <span>{briefDefinitionId ? "Ändringar här gäller bara denna brief. Återställ en källa för att ärva din globala policy igen." : "En blockerad domän skickas inte till webbsökningen och filtreras bort innan material eller chattsvar kan publiceras."}</span>
      </section>
      {!briefDefinitionId && <form className="source-add-form" onSubmit={addSource}>
        <label><span>Ny källa, creator eller podd-domän</span><input name="domain" placeholder="exempel.se eller https://exempel.se" /></label>
        <label><span>Namn (valfritt)</span><input name="name" placeholder="Min källa" /></label>
        <label><span>Typ</span><select name="sourceKind" defaultValue="custom"><option value="custom">Egen källa</option><option value="creator">Creator</option><option value="podcast">Podd</option><option value="editorial">Redaktionellt medium</option></select></label>
        <button className="secondary-button" type="submit" disabled={isPending}>Lägg till</button>
      </form>}
      <div className="source-toolbar">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Sök källa" aria-label="Sök källa" />
        <select value={kind} onChange={(event) => setKind(event.target.value as "all" | SourceKind)} aria-label="Filtrera källtyp">
          <option value="all">Alla typer</option>
          {Object.entries(kindLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select>
      </div>
      {notice && <p className={notice.includes("Kunde") || notice.includes("giltig") ? "form-error" : "form-success"} role="status">{notice}</p>}
      <ul className="source-catalog-list">
        {visible.map((source) => <SourceRow key={`${source.domain}:${source.active}:${source.blocked}:${source.roles.join("-")}:${source.priority}:${source.frequency}:${source.topicFilter}`} source={source} isPending={isPending} onSave={save} hasOverride={overrideDomains.includes(source.domain)} onReset={briefDefinitionId ? resetOverride : undefined} />)}
      </ul>
    </div>
  );
}

function SourceRow({ source, isPending, onSave, hasOverride, onReset }: { source: SourcePolicyView; isPending: boolean; onSave: (source: SourcePolicyView) => void; hasOverride: boolean; onReset?: (source: SourcePolicyView) => void }) {
  const [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState(source);

  function toggleEnabled() {
    onSave({ ...source, active: !source.active, blocked: source.active, roles: source.active ? [] : source.roles.length ? source.roles : defaultRoles(source) });
  }

  function toggleRole(role: SourceRole) {
    const roles = source.roles.includes(role) ? source.roles.filter((value) => value !== role) : [...source.roles, role];
    onSave({ ...source, roles, active: true, blocked: false });
  }

  function saveAdvanced(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave({ ...draft, active: true, blocked: false });
    setAdvanced(false);
  }

  return (
    <li className={source.blocked ? "source-row blocked" : "source-row"}>
      <div className="source-row-heading">
        <div><strong>{source.sourceName}</strong><span>{source.domain} · {kindLabels[source.sourceKind]}</span></div>
        <button className={source.active && !source.blocked ? "source-toggle active" : "source-toggle"} type="button" disabled={isPending} onClick={toggleEnabled} aria-pressed={source.active && !source.blocked}>
          {source.active && !source.blocked ? "På" : source.blocked ? "Blockerad" : "Av"}
        </button>
      </div>
      <div className="source-roles" aria-label={`Roller för ${source.sourceName}`}>
        {(["discovery", "analysis", "verification", "citation", "direct_monitoring"] as SourceRole[]).map((role) => (
          <label key={role}><input type="checkbox" checked={source.roles.includes(role)} disabled={isPending || source.blocked} onChange={() => toggleRole(role)} /> {roleLabels[role]}</label>
        ))}
      </div>
      <div className="source-row-actions"><span>{hasOverride ? "Egen briefregel" : source.priority === "high" ? "Hög prioritet" : source.priority === "low" ? "Låg prioritet" : "Normal prioritet"}</span><div><button className="text-action" type="button" onClick={() => setAdvanced((current) => !current)} disabled={isPending}>{advanced ? "Stäng" : "Fler regler"}</button>{hasOverride && onReset && <button className="text-action" type="button" onClick={() => onReset(source)} disabled={isPending}>Ärv global</button>}</div></div>
      {advanced && (
        <form className="source-advanced-form" onSubmit={saveAdvanced}>
          <label className="stacked-field"><span>Prioritet</span><select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value as SourcePolicyView["priority"] })}><option value="high">Hög</option><option value="normal">Normal</option><option value="low">Låg</option></select></label>
          <label className="stacked-field"><span>Frekvensregel</span><select value={draft.frequency} onChange={(event) => setDraft({ ...draft, frequency: event.target.value as SourcePolicyView["frequency"] })}>{Object.entries(frequencyLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="stacked-field"><span>Verifieringskrav</span><select value={draft.verificationRequirement} onChange={(event) => setDraft({ ...draft, verificationRequirement: event.target.value as SourcePolicyView["verificationRequirement"] })}>{Object.entries(verificationLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="stacked-field source-advanced-full"><span>Ämnesfilter (valfritt)</span><input value={draft.topicFilter} maxLength={500} onChange={(event) => setDraft({ ...draft, topicFilter: event.target.value })} placeholder="Till exempel moln, energi eller lokala restauranger" /></label>
          <div className="source-advanced-actions"><button className="secondary-button" type="submit" disabled={isPending}>Spara regler</button></div>
        </form>
      )}
    </li>
  );
}

function defaultRoles(source: SourcePolicyView): SourceRole[] {
  return source.sourceKind === "primary" ? ["discovery", "verification", "citation"] : ["discovery", "analysis", "citation"];
}
