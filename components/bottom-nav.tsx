"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/*
 * These are the only persistent work areas in the product chrome. Deeper
 * routes remain first-class destinations, but resolve back to the work area
 * that owns the job rather than growing the main navigation every time a new
 * tool is added.
 */
const automationBuildRoutes = {
  href: "/studio/engine",
  matches: ["/studio/engine", "/studio/lens"],
} as const;

const links = [
  {
    href: "/studio/create",
    matches: [
      "/studio",
      "/studio/content",
      "/studio/research",
      "/studio/templates",
      "/studio/channels",
      "/studio/avatar",
      "/studio/series",
      "/studio/ads",
      "/preview",
    ],
    label: "Skapa",
    icon: "studio",
  },
  { href: "/studio/calendar", matches: ["/studio/calendar"], label: "Kalender", icon: "calendar" },
  {
    href: "/studio/automations",
    matches: ["/studio/automations", ...automationBuildRoutes.matches],
    label: "Automations",
    icon: "automation",
  },
  { href: "/settings", label: "Inställningar", icon: "settings" },
] as const;

type NavVariant = "bottom" | "sidebar";
type IconName = (typeof links)[number]["icon"];
type NavigationLink = {
  href: string;
  label: string;
  accessibleLabel?: string;
  icon: IconName;
  matches?: readonly string[];
};

type WorkspaceContext = {
  area: string;
  detail: string;
};

function workspaceContext(pathname: string): WorkspaceContext {
  if (pathname.startsWith("/studio/create")) return { area: "Skapa", detail: "Nytt utkast" };
  if (pathname.startsWith("/studio/calendar")) return { area: "Kalender", detail: "Innehållsplan" };
  if (pathname.startsWith("/studio/automations")) return { area: "Automations", detail: "Flöden och körningar" };
  if (pathname.startsWith("/studio/engine")) return { area: "Automations", detail: "Flödesbyggaren" };
  if (pathname.startsWith("/studio/lens")) return { area: "Automations", detail: "Editorial Lens" };
  if (pathname.startsWith("/studio/avatar")) return { area: "Studio", detail: "Bildreferenser" };
  if (pathname.startsWith("/studio/series")) return { area: "Studio", detail: "Innehållsserier" };
  if (pathname.startsWith("/studio/ads")) return { area: "Studio", detail: "Annonsverkstad" };
  if (pathname.startsWith("/studio/research")) return { area: "Studio", detail: "Research" };
  if (pathname.startsWith("/studio/templates")) return { area: "Studio", detail: "Mallar" };
  if (pathname.startsWith("/studio/channels")) return { area: "Studio", detail: "Kanaler" };
  if (pathname.startsWith("/studio/content")) return { area: "Studio", detail: "Innehåll" };
  if (pathname.startsWith("/settings")) return { area: "Inställningar", detail: "Arbetsyta" };
  // `/preview` is an explicitly local example gallery, never a preview of a
  // user's draft. Reserving that word for an actual selected draft prevents
  // the shell from implying a publishing action that has not happened.
  if (pathname.startsWith("/preview")) return { area: "Studio", detail: "Referensgalleri" };
  return { area: "Studio", detail: "Innehåll" };
}

function currentNavigationHref(pathname: string, navigationLinks: readonly NavigationLink[]) {
  const matchingLink = navigationLinks
    .flatMap((link) => (link.matches ?? [link.href]).map((match) => ({ link, match })))
    .filter(({ match }) => pathname === match || pathname.startsWith(`${match}/`))
    .sort((first, second) => second.match.length - first.match.length)[0]?.link;

  // Keep one primary destination current, including the focused routes that
  // live beneath a work area such as a draft, a creative brief or a flow.
  return matchingLink?.href ?? "/studio";
}

export function WorkspaceHeader() {
  const pathname = usePathname();
  const context = workspaceContext(pathname);

  return (
    <header className="app-topbar" aria-label="Arbetsytekontext">
      <div className="app-topbar-context">
        <span className="app-topbar-workspace"><i aria-hidden="true" />SAGA Studio</span>
        <span className="app-topbar-divider" aria-hidden="true" />
        <span className="app-topbar-area">{context.area}</span>
        <strong>{context.detail}</strong>
      </div>
      <div className="app-topbar-actions">
        <Link className="app-topbar-create" href="/studio/create" aria-label="Skapa ett nytt utkast">
          <span className="app-topbar-create-icon" aria-hidden="true"><CreateIcon /></span>
          <span>Skapa utkast</span>
        </Link>
      </div>
    </header>
  );
}

export function BottomNav() {
  const pathname = usePathname();
  const activeHref = currentNavigationHref(pathname, links);

  return (
    <nav className="bottom-nav" aria-label="Primära arbetsområden">
      <NavigationLinks links={links} activeHref={activeHref} variant="bottom" className="bottom-nav-set" />
    </nav>
  );
}

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const activeHref = currentNavigationHref(pathname, links);
  return (
    <nav className="sidebar-nav" aria-label="Primära arbetsområden">
      <NavigationLinks links={links} activeHref={activeHref} variant="sidebar" className="sidebar-nav-list" onNavigate={onNavigate} />
    </nav>
  );
}

function NavigationLinks({
  links: navigationLinks,
  activeHref,
  variant,
  className,
  onNavigate,
}: {
  links: readonly NavigationLink[];
  activeHref: string;
  variant: NavVariant;
  className: string;
  onNavigate?: () => void;
}) {
  return (
    <div className={className}>
      {navigationLinks.map((link) => {
        const active = link.href === activeHref;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            // Labels are visually removed when the desktop rail is collapsed,
            // but stay on the control so the icon-only state remains usable by
            // keyboard and screen-reader users.
            aria-label={link.accessibleLabel ?? link.label}
            className={active ? `nav-link nav-link--${variant} active` : `nav-link nav-link--${variant}`}
            href={link.href}
            key={link.href}
            onClick={onNavigate}
            title={variant === "sidebar" ? link.label : undefined}
          >
            <span className="nav-link-icon" aria-hidden="true"><NavigationIcon name={link.icon} /></span>
            <span className="nav-link-label">{link.label}</span>
          </Link>
        );
      })}
    </div>
  );
}

function NavigationIcon({ name }: { name: IconName }) {
  if (name === "studio") {
    return <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m9.2 14.8 5.9-5.9 1.8 1.8-5.9 5.9-2.5.7.7-2.5ZM8 7.8h3.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  if (name === "calendar") {
    return <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5.2" width="16" height="14.2" rx="2.5" /><path d="M7.6 3.7v3M16.4 3.7v3M4 9.3h16M8 12.7h.01M12 12.7h.01M16 12.7h.01M8 16.1h.01M12 16.1h.01" strokeLinecap="round" /></svg>;
  }
  if (name === "automation") {
    return <svg viewBox="0 0 24 24" fill="none"><path d="M18.3 9.2A7 7 0 0 0 6.1 7.8L4.5 9.4M5.7 14.8A7 7 0 0 0 17.9 16.2l1.6-1.6M4.5 5.8v3.6h3.6M19.5 18.2v-3.6h-3.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  }
  return <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" /><path d="M19.2 13.4a1.7 1.7 0 0 0 .34 1.88l.06.06-2.23 2.23-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56v.1h-3.15v-.1a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06-2.23-2.23.06-.06a1.7 1.7 0 0 0 .34-1.88 1.7 1.7 0 0 0-1.56-1.03h-.1V9.26h.1A1.7 1.7 0 0 0 6.47 8.2a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.23-2.23.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.56v-.1h3.15v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.23 2.23-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03h.1v3.15h-.1a1.7 1.7 0 0 0-1.56 1.03Z" strokeLinejoin="round" /></svg>;
}

function CreateIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M10 4v12M4 10h12" strokeLinecap="square" />
    </svg>
  );
}
