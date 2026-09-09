import Link from "next/link";
import type { AppActor } from "@/lib/neon/auth-repository";
import { isVercelIdentityConfigured } from "@/lib/auth/vercel-oauth";

type VercelSettingsPanelProps = {
  actor: AppActor;
  blobReady: boolean;
  aiReady: boolean;
  cronReady: boolean;
};

type ServiceId = "database" | "media" | "identity" | "ai" | "cron";

type Service = {
  id: ServiceId;
  label: string;
  ready: boolean;
  readyDetail: string;
  pendingDetail: string;
  guideHref: string;
  actionLabel: string;
};

function ServiceIcon({ id }: { id: ServiceId }) {
  if (id === "database") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="5" rx="6.5" ry="2.8" /><path d="M5.5 5v7c0 1.55 2.9 2.8 6.5 2.8s6.5-1.25 6.5-2.8V5M5.5 12v7c0 1.55 2.9 2.8 6.5 2.8s6.5-1.25 6.5-2.8v-7" /></svg>;
  }

  if (id === "media") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.2 18.5a4 4 0 0 1 .75-7.93A5.1 5.1 0 0 1 17.7 9a3.9 3.9 0 0 1-.25 7.8H7.2Z" /><path d="M12 7v8M9.3 12.2 12 15l2.7-2.8" /></svg>;
  }

  if (id === "identity") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.2" /><path d="M5.5 19c.65-3.08 3.05-4.7 6.5-4.7s5.85 1.62 6.5 4.7" /></svg>;
  }

  if (id === "ai") {
    return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 .85 3.15L16 7l-3.15.85L12 11l-.85-3.15L8 7l3.15-.85L12 3ZM18.2 12l.55 2.05 2.05.55-2.05.55-.55 2.05-.55-2.05-2.05-.55 2.05-.55.55-2.05ZM6.2 14l.7 2.6 2.6.7-2.6.7-.7 2.6-.7-2.6-2.6-.7 2.6-.7.7-2.6Z" /></svg>;
  }

  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="7.3" /><path d="M12 8v4.35l2.9 1.75M12 2.7v2M21.3 12h-2" /></svg>;
}

function ServiceStatus({ service }: { service: Service }) {
  const detail = service.ready ? service.readyDetail : service.pendingDetail;

  return (
    <li className={`vercel-settings-service ${service.ready ? "is-ready" : "is-pending"}`}>
      <span className="vercel-settings-service-icon"><ServiceIcon id={service.id} /></span>
      <div className="vercel-settings-service-copy">
        <div className="vercel-settings-service-title">
          <strong>{service.label}</strong>
          <span className="vercel-settings-state">{service.ready ? "Ansluten" : "Behöver åtgärd"}</span>
        </div>
        <p>{detail}</p>
      </div>
      <a className="vercel-settings-service-action" href={service.guideHref} target="_blank" rel="noreferrer">
        {service.ready ? "Guide" : service.actionLabel} <span aria-hidden="true">↗</span>
      </a>
    </li>
  );
}

/** The deployment control surface intentionally exposes only real Vercel configuration. */
export function VercelSettingsPanel({ actor, blobReady, aiReady, cronReady }: VercelSettingsPanelProps) {
  const identityReady = isVercelIdentityConfigured();
  const services: Service[] = [
    {
      id: "database",
      label: "Neon-databas",
      ready: true,
      readyDetail: "Arbetsytor, utkast och automationer sparas i den anslutna Vercel-integrationen.",
      pendingDetail: "Anslut Neon från Vercel Marketplace för att spara arbetsytan.",
      guideHref: "https://vercel.com/marketplace/neon",
      actionLabel: "Anslut Neon",
    },
    {
      id: "media",
      label: "Privat Blob-media",
      ready: blobReady,
      readyDetail: "Originalbilder och filer lagras privat och hämtas bara via den skyddade Studio-vägen.",
      pendingDetail: "Koppla en privat Blob store innan någon kan ladda upp bilder eller originalfiler.",
      guideHref: "https://vercel.com/docs/vercel-blob/using-blob-sdk",
      actionLabel: "Koppla Blob",
    },
    {
      id: "identity",
      label: "Sign in with Vercel",
      ready: identityReady,
      readyDetail: "Sessionen verifieras på servern. Ingen användarhemlighet ligger i webbläsaren.",
      pendingDetail: "Skapa Vercel-appen och lägg in klient-id och client secret i samma Vercel-projekt.",
      guideHref: "https://vercel.com/docs/sign-in-with-vercel/getting-started",
      actionLabel: "Konfigurera inloggning",
    },
    {
      id: "ai",
      label: "AI Gateway",
      ready: aiReady,
      readyDetail: "Studio kan skapa AI-utkast via den serverstyrda AI-vägen.",
      pendingDetail: "Lägg till AI_GATEWAY_API_KEY lokalt eller aktivera Vercel OIDC i din produktionsmiljö.",
      guideHref: "https://vercel.com/docs/ai-gateway",
      actionLabel: "Öppna AI Gateway",
    },
    {
      id: "cron",
      label: "Schemalagd körning",
      ready: cronReady,
      readyDetail: "Vercel Cron kan väcka kön och skapa privata utkast enligt ditt schema.",
      pendingDetail: "Sätt CRON_SECRET innan schemalagda automationer får köra.",
      guideHref: "https://vercel.com/docs/cron-jobs",
      actionLabel: "Konfigurera Cron",
    },
  ];
  const readyCount = services.filter((service) => service.ready).length;
  const nextService = services.find((service) => !service.ready);
  const isReady = readyCount === services.length;
  const roleLabel = actor.role === "owner" ? "Ägare" : actor.role === "editor" ? "Redaktör" : "Visning";
  const avatarInitial = (actor.displayName || actor.email || "B").trim().charAt(0).toUpperCase() || "B";

  return (
    <div className="settings-control-page vercel-settings-page">
      <header className="vercel-settings-hero">
        <div className="vercel-settings-hero-copy">
          <span className="vercel-settings-product-mark" aria-hidden="true"><span /><span /><span /></span>
          <p className="eyebrow">VERCEL-ARBETSYTA</p>
          <h1>Allt viktigt. På ett ställe.</h1>
          <p>Här ser du vad som faktiskt är anslutet till SAGA, vad som saknas och exakt var du gör nästa ändring.</p>
        </div>
        <div className={`vercel-settings-readiness ${isReady ? "is-ready" : "is-pending"}`} aria-label={`${readyCount} av ${services.length} Vercel-tjänster är anslutna`}>
          <span className="vercel-settings-readiness-label">Driftstatus</span>
          <strong><span>{readyCount}</span> / {services.length}</strong>
          <p>{isReady ? "Basen är klar för Studio." : `${services.length - readyCount} ${services.length - readyCount === 1 ? "sak återstår" : "saker återstår"}.`}</p>
          <span className="vercel-settings-progress" aria-hidden="true"><i style={{ width: `${(readyCount / services.length) * 100}%` }} /></span>
        </div>
      </header>

      <section className="vercel-settings-workspace" aria-labelledby="vercel-workspace-title">
        <div className="vercel-settings-avatar" aria-hidden="true">{avatarInitial}</div>
        <div className="vercel-settings-workspace-copy">
          <p className="eyebrow">AKTIV ARBETSYTA</p>
          <h2 id="vercel-workspace-title">{actor.displayName || "Din privata arbetsyta"}</h2>
          <p>{actor.email || "Vercel-kontot är anslutet."}</p>
        </div>
        <span className="vercel-settings-role">{roleLabel}</span>
        <Link className="vercel-settings-studio-link" href="/studio">Öppna Studio <span aria-hidden="true">→</span></Link>
      </section>

      {nextService ? (
        <section className="vercel-settings-next" aria-labelledby="vercel-next-title">
          <div className="vercel-settings-next-marker" aria-hidden="true"><span>01</span></div>
          <div>
            <p className="eyebrow">NÄSTA ÅTGÄRD</p>
            <h2 id="vercel-next-title">Gör klart {nextService.label}.</h2>
            <p>{nextService.pendingDetail}</p>
          </div>
          <a className="primary-action vercel-settings-next-action" href={nextService.guideHref} target="_blank" rel="noreferrer">
            {nextService.actionLabel} <span aria-hidden="true">↗</span>
          </a>
        </section>
      ) : (
        <section className="vercel-settings-next is-complete" aria-labelledby="vercel-next-title">
          <div className="vercel-settings-next-marker" aria-hidden="true">✓</div>
          <div>
            <p className="eyebrow">KLART</p>
            <h2 id="vercel-next-title">Vercel-basen är ansluten.</h2>
            <p>Skapa ett utkast eller öppna automationerna. Publicering är alltid ett separat, medvetet steg i Studio.</p>
          </div>
          <Link className="primary-action vercel-settings-next-action" href="/studio/engine">Öppna Content Engine <span aria-hidden="true">→</span></Link>
        </section>
      )}

      <section className="vercel-settings-services" aria-labelledby="vercel-services-title">
        <header className="vercel-settings-section-heading">
          <div>
            <p className="eyebrow">KONFIGURATION</p>
            <h2 id="vercel-services-title">Det som driver Studio</h2>
          </div>
          <span>Hemligheter visas aldrig här.</span>
        </header>
        <ul className="vercel-settings-status-list">
          {services.map((service) => <ServiceStatus key={service.id} service={service} />)}
        </ul>
      </section>

      <section className="vercel-settings-workflow" aria-labelledby="vercel-workflow-title">
        <div>
          <p className="eyebrow">ARBETSFÖRLOPP</p>
          <h2 id="vercel-workflow-title">Fortsätt där arbetet sker.</h2>
          <p>Inställningar för innehåll, mallar och automationer bor i Studio. Här finns bara drift och anslutningar.</p>
        </div>
        <nav aria-label="Gå vidare i Studio">
          <Link href="/studio/engine">Öppna Content Engine <span aria-hidden="true">→</span></Link>
          <Link href="/studio/automations">Se automationer <span aria-hidden="true">→</span></Link>
          <Link href="/studio/channels">Hantera kanaler <span aria-hidden="true">→</span></Link>
        </nav>
      </section>
    </div>
  );
}
