import Link from "next/link";
import styles from "@/components/product-settings-hub.module.css";

export type ProductSettingsActor = {
  role: "owner" | "editor" | "viewer";
  email: string | null;
  displayName: string | null;
};

type ProductSettingsHubProps = {
  actor: ProductSettingsActor | null;
};

type SettingsAreaId = "voice" | "templates" | "channels" | "api" | "review" | "automations" | "workspace";

type SettingsArea = {
  id: SettingsAreaId;
  eyebrow: string;
  title: string;
  detail: string;
  href: string;
  action: string;
};

const settingsAreas: SettingsArea[] = [
  {
    id: "voice",
    eyebrow: "REDAKTIONELL GRUND",
    title: "Mission, röst & källor",
    detail: "Bestäm ert perspektiv, hur ni låter och vilket underlag SAGA får använda.",
    href: "/studio/lens",
    action: "Öppna Editorial Lens",
  },
  {
    id: "templates",
    eyebrow: "FORMAT",
    title: "Mallar & strukturer",
    detail: "Bygg återanvändbara format för inlägg, nyhetsbrev och längre innehåll.",
    href: "/studio/templates",
    action: "Se mallarna",
  },
  {
    id: "channels",
    eyebrow: "DESTINATIONER",
    title: "Kanaler & mottagare",
    detail: "Välj vilka konton, listor och flöden som ett godkänt utkast kan förberedas för.",
    href: "/studio/channels",
    action: "Hantera kanaler",
  },
  {
    id: "api",
    eyebrow: "INTEGRATIONER",
    title: "Utgående API",
    detail: "Skapa en avgränsad läsåtkomst till valt, godkänt innehåll för egna system.",
    href: "/settings/api",
    action: "Hantera API-exporter",
  },
  {
    id: "review",
    eyebrow: "KVALITET",
    title: "Granskning & godkännande",
    detail: "Se påbörjade utkast och säkerställ att text, bild, kanal och tid håller ihop.",
    href: "/studio",
    action: "Öppna utkasten",
  },
  {
    id: "automations",
    eyebrow: "ÅTERKOMMANDE FLÖDEN",
    title: "Automationer",
    detail: "Låt ett fungerande recept skapa privata utkast på den takt ni väljer.",
    href: "/studio/automations",
    action: "Öppna automationer",
  },
  {
    id: "workspace",
    eyebrow: "ARBETSYTA",
    title: "Din Studio",
    detail: "Fortsätt där idéer, material, utkast och planering samlas i samma arbetsyta.",
    href: "/studio",
    action: "Till Studio",
  },
];

function roleLabel(role: ProductSettingsActor["role"]) {
  if (role === "owner") return "Ägare";
  if (role === "editor") return "Redaktör";
  return "Visning";
}

function workspaceName(actor: ProductSettingsActor) {
  const displayName = actor.displayName?.trim();
  if (displayName) return displayName;
  const localPart = actor.email?.split("@")[0]?.trim();
  return localPart || "Din arbetsyta";
}

function initial(actor: ProductSettingsActor) {
  return workspaceName(actor).charAt(0).toLocaleUpperCase("sv-SE") || "B";
}

function SettingsIcon({ name }: { name: SettingsAreaId }) {
  if (name === "voice") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.1 13.8V8.4a6.9 6.9 0 0 1 13.8 0v5.4M5.1 13.8H3.7v-3h1.4m13.8 3h1.4v-3h-1.4M8.1 18.9c1 .75 2.35 1.15 3.9 1.15 1.25 0 2.37-.26 3.3-.74" strokeLinecap="round" strokeLinejoin="round" /><path d="M8.1 13.8h1.3a2.6 2.6 0 0 0 5.2 0h1.3" strokeLinecap="round" /></svg>;
  }
  if (name === "templates") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.5" y="3.8" width="15" height="16.4" rx="2.4" /><path d="M8.1 8.2h7.8M8.1 12h7.8M8.1 15.8h4.4" strokeLinecap="round" /></svg>;
  }
  if (name === "channels") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7.7 12 13l8-5.3M5.6 5h12.8A1.6 1.6 0 0 1 20 6.6v10.8a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.4V6.6A1.6 1.6 0 0 1 5.6 5Z" strokeLinejoin="round" /></svg>;
  }
  if (name === "api") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3.9" y="5" width="16.2" height="14" rx="2.5" /><path d="M7.4 9.3h9.2M7.4 12.5h4.1M16.6 15.4h.01" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (name === "review") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 4.5h7.1l3.5 3.5v10.3a1.7 1.7 0 0 1-1.7 1.7H7.2a1.7 1.7 0 0 1-1.7-1.7V6.2a1.7 1.7 0 0 1 1.7-1.7Z" /><path d="M14.2 4.5V8h3.6M8.7 13l1.8 1.8 4.5-4.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (name === "automations") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18.2 8.9A6.9 6.9 0 0 0 6.3 7.5L4.7 9.1M5.8 15.1a6.9 6.9 0 0 0 11.9 1.4l1.6-1.6M4.7 5.5v3.6h3.6m7.4 9.4h3.6v-3.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m9.2 14.8 5.9-5.9 1.8 1.8-5.9 5.9-2.5.7.7-2.5ZM8 7.8h3.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Arrow() {
  return <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h11M10.8 5.8 15 10l-4.2 4.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function UnavailableSettings() {
  return (
    <section className={styles.unavailable} aria-labelledby="settings-unavailable-title">
      <span className={styles.unavailableIcon} aria-hidden="true"><SettingsIcon name="workspace" /></span>
      <div>
        <p className={styles.cardEyebrow}>ARBETSYTAN ÄR INTE REDO ÄN</p>
        <h2 id="settings-unavailable-title">Vi visar inte tomma inställningar.</h2>
        <p>Det finns ännu ingen arbetsyta att läsa eller spara i. Visa exempelgalleriet, eller öppna Studio för att se vad som blir tillgängligt när arbetsytan är redo.</p>
      </div>
      <nav className={styles.unavailableActions} aria-label="Fortsätt i produkten">
        <Link href="/preview">Visa exempelgalleriet <Arrow /></Link>
        <Link href="/studio">Öppna Studio <Arrow /></Link>
      </nav>
    </section>
  );
}

export function ProductSettingsHub({ actor }: ProductSettingsHubProps) {
  const isViewer = actor?.role === "viewer";
  const actionHref = actor ? "/studio/content/new?edit=1" : "/preview";
  const actionLabel = actor ? "Skapa utkast" : "Visa exempel";

  return (
    <section className={styles.hub} aria-labelledby="product-settings-title">
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>SAGA · ARBETSYTEINSTÄLLNINGAR</p>
          <h1 id="product-settings-title">Styr det som ska hålla över tid.</h1>
          <p>Röst, format, källor, kanaler och granskning samlas här. Varje val leder vidare till ett riktigt verktyg i Studio.</p>
        </div>
        <div className={styles.heroActions}>
          <span className={styles.heroStatus}><i aria-hidden="true" />{actor ? "Arbetsyta aktiv" : "Produktvy"}</span>
          <Link className={styles.createLink} href={actionHref}>{actionLabel} <Arrow /></Link>
        </div>
      </header>

      {!actor ? <UnavailableSettings /> : <>
        <section className={styles.workspaceCard} aria-labelledby="settings-workspace-title">
          <span className={styles.avatar} aria-hidden="true">{initial(actor)}</span>
          <div className={styles.workspaceCopy}>
            <p className={styles.cardEyebrow}>AKTIV ARBETSYTA</p>
            <h2 id="settings-workspace-title">{workspaceName(actor)}</h2>
            <p>{actor.email || "Din privata arbetsyta"}</p>
          </div>
          <span className={styles.role}>{roleLabel(actor.role)}</span>
          <Link className={styles.workspaceLink} href="/studio">Öppna Studio <Arrow /></Link>
        </section>

        <section className={styles.settingsSection} aria-labelledby="settings-areas-title">
          <header className={styles.sectionHeader}>
            <div>
              <p className={styles.eyebrow}>REDIGERA GRUNDEN</p>
              <h2 id="settings-areas-title">Styr flödet, inte tekniken.</h2>
            </div>
            <p>Varje val öppnar ett riktigt verktyg i Studio.</p>
          </header>

          <div className={styles.settingsGrid}>
            {settingsAreas.map((area, index) => <Link className={styles.settingsCard} href={area.href} key={area.id}>
              <span className={styles.cardTop}><span className={styles.icon}><SettingsIcon name={area.id} /></span><span>{String(index + 1).padStart(2, "0")}</span></span>
              <span className={styles.cardEyebrow}>{area.eyebrow}</span>
              <strong>{area.title}</strong>
              <span className={styles.cardDetail}>{area.detail}</span>
              <span className={styles.cardAction}>{isViewer ? "Visa i Studio" : area.action} <Arrow /></span>
            </Link>)}
          </div>
        </section>

        <section className={styles.flowNote} aria-labelledby="settings-flow-title">
          <div>
            <p className={styles.cardEyebrow}>ARBETSSÄTT</p>
            <h2 id="settings-flow-title">Skapa först. Gör återkommande när det fungerar.</h2>
            <p>En automation ska börja med ett beprövat uttryck. Den skapar privata utkast, och ni väljer alltid nästa steg.</p>
          </div>
          <div className={styles.flowSteps} aria-label="Skapandets steg">
            <span>Riktning</span><i aria-hidden="true">→</i><span>Utkast</span><i aria-hidden="true">→</i><span>Granskning</span><i aria-hidden="true">→</i><span>Planering</span>
          </div>
        </section>
      </>}
    </section>
  );
}
