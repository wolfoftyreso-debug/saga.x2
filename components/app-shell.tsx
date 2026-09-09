"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { BottomNav, SidebarNav, WorkspaceHeader } from "@/components/bottom-nav";

const EXPANDED_RAIL_WIDTH = 256;
const MIN_WORKBENCH_WIDTH = 924;
const MOBILE_SHELL_WIDTH = 860;

type ShellSize = "mobile" | "constrained" | "wide";

function getShellSize(width: number): ShellSize {
  if (width < MOBILE_SHELL_WIDTH) return "mobile";

  // Keep labelled work areas available at ordinary desktop widths. The rail
  // only becomes a compact tool rail once its 256px width would leave less
  // than 924px for the actual workbench (about a 1180px shell in total).
  // Measuring the shell keeps this correct when SAGA is embedded too.
  return width - EXPANDED_RAIL_WIDTH < MIN_WORKBENCH_WIDTH ? "constrained" : "wide";
}

export function AppShell({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const railToggleRef = useRef<HTMLButtonElement>(null);
  const railId = useId();
  const [shellSize, setShellSize] = useState<ShellSize>("mobile");
  const [wideRailExpanded, setWideRailExpanded] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false);

  const railIsOverlay = shellSize === "constrained" && overlayOpen;
  const railIsExpanded = shellSize === "wide" ? wideRailExpanded : railIsOverlay;
  const railState = shellSize === "mobile" ? "hidden" : railIsOverlay ? "overlay" : railIsExpanded ? "expanded" : "collapsed";

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const updateShellSize = () => {
      const nextSize = getShellSize(shell.getBoundingClientRect().width);
      setShellSize(nextSize);
      if (nextSize !== "constrained") setOverlayOpen(false);
    };

    updateShellSize();
    const observer = new ResizeObserver(updateShellSize);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!railIsOverlay) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOverlayOpen(false);
      requestAnimationFrame(() => railToggleRef.current?.focus());
    };

    document.addEventListener("keydown", closeOnEscape);
    requestAnimationFrame(() => railRef.current?.focus());
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [railIsOverlay]);

  const closeOverlay = () => {
    setOverlayOpen(false);
    requestAnimationFrame(() => railToggleRef.current?.focus());
  };

  const toggleRail = () => {
    if (shellSize === "constrained") {
      setOverlayOpen((isOpen) => !isOpen);
      return;
    }

    if (shellSize === "wide") setWideRailExpanded((isExpanded) => !isExpanded);
  };

  return (
    <div
      ref={shellRef}
      className="app-shell app-shell--with-sidebar"
      data-rail-state={railState}
      data-shell-size={shellSize}
    >
      <a className="skip-to-content" href="#app-content">Hoppa till arbetsytan</a>
      {railIsOverlay ? (
        <button className="sidebar-scrim" type="button" aria-label="Stäng navigeringen" onClick={closeOverlay} />
      ) : null}

      <aside
        ref={railRef}
        className="app-sidebar"
        id={railId}
        aria-label="SAGA arbetsområden"
        aria-modal={railIsOverlay || undefined}
        role={railIsOverlay ? "dialog" : undefined}
        tabIndex={railIsOverlay ? -1 : undefined}
      >
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <Link className="sidebar-brand" href="/studio" aria-label="SAGA, öppna Studio">
              <span className="sidebar-brand-mark" aria-hidden="true">
                <SagaControlMark />
              </span>
              <span className="sidebar-brand-copy"><strong>SAGA</strong><small>Studio</small></span>
            </Link>
            <button
              ref={railToggleRef}
              className="sidebar-rail-toggle"
              type="button"
              aria-controls={railId}
              aria-expanded={railIsExpanded}
              aria-label={railIsExpanded ? "Fäll in sidomenyn" : "Fäll ut sidomenyn"}
              onClick={toggleRail}
            >
              <span aria-hidden="true"><RailToggleIcon collapsed={!railIsExpanded} /></span>
            </button>
          </div>

          <div className="sidebar-workspace-summary" aria-label="SAGA Studio-arbetsyta">
            <span className="sidebar-workspace-mark" aria-hidden="true" />
            <span className="sidebar-workspace-copy"><small>ARBETSYTA</small><strong>SAGA Studio</strong></span>
          </div>

          <Link className="sidebar-create-action" href="/studio/create" aria-label="Skapa ett nytt utkast">
            <span className="sidebar-create-action-icon" aria-hidden="true"><CreateIcon /></span>
            <span className="sidebar-create-action-label">Skapa utkast</span>
          </Link>
        </div>

        <div className="sidebar-navigation">
          <p className="sidebar-section-label">Arbetsområden</p>
          <SidebarNav onNavigate={railIsOverlay ? closeOverlay : undefined} />
        </div>
      </aside>

      <section className="app-main">
        <WorkspaceHeader />
        <main className="page-content" id="app-content">{children}</main>
      </section>
      <BottomNav />
    </div>
  );
}

function RailToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M4 4.75h12M4 10h12M4 15.25h12" strokeLinecap="round" />
      <path d={collapsed ? "m8 7 3 3-3 3" : "m12 7-3 3 3 3"} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CreateIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none">
      <path d="M10 4v12M4 10h12" strokeLinecap="square" />
    </svg>
  );
}

function SagaControlMark() {
  return (
    <svg viewBox="0 0 28 28" fill="none">
      <rect x="5" y="5" width="7" height="7" fill="currentColor" />
      <rect x="16" y="5" width="7" height="7" fill="currentColor" opacity="0.62" />
      <rect x="5" y="16" width="7" height="7" fill="currentColor" opacity="0.62" />
      <rect x="16" y="16" width="7" height="7" fill="currentColor" />
    </svg>
  );
}
