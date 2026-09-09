import Link from "next/link";

function BriefMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5c.3 4.4 2.1 6.2 6.5 6.5-4.4.3-6.2 2.1-6.5 6.5-.3-4.4-2.1-6.2-6.5-6.5 4.4-.3 6.2-2.1 6.5-6.5Z" strokeLinejoin="round" />
      <path d="M18.6 15.7c.1 1.8.9 2.6 2.7 2.7-1.8.1-2.6.9-2.7 2.7-.1-1.8-.9-2.6-2.7-2.7 1.8-.1 2.6-.9 2.7-2.7Z" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Product-facing safe gate. Connection work belongs with the deployment
 * owner, not in the editor, settings or a user's primary workflow.
 */
export function SetupRequired() {
  return (
    <main className="product-gate" aria-labelledby="product-gate-title">
      <header className="product-gate-topbar">
        <Link className="product-gate-brand" href="/" aria-label="SAGA">
          <span><BriefMark /></span>
          <strong>SAGA</strong>
        </Link>
        <span>Skapa, testa, förädla</span>
      </header>

      <section className="product-gate-card">
        <span className="product-gate-mark" aria-hidden="true"><BriefMark /></span>
        <p className="product-gate-kicker">ARBETSYTAN ÄR INTE REDO ÄN</p>
        <h1 id="product-gate-title">Här ska du skapa — inte hantera teknik.</h1>
        <p>Den här arbetsytan kan inte öppnas fullt ännu. Vi visar därför aldrig tomma formulär, låtsasdata eller knappar som inte kan spara.</p>

        <div className="product-gate-actions">
          <Link className="product-gate-primary" href="/preview">Visa exempelgalleriet <span aria-hidden="true">→</span></Link>
          <Link className="product-gate-secondary" href="/settings">Öppna produktinställningar</Link>
        </div>

        <div className="product-gate-boundary">
          <span aria-hidden="true">✓</span>
          <p><strong>När arbetsytan är ansluten</strong> öppnas riktiga utkast, bilder, mallar, kanaler och automationer här. Driftkonfiguration hanteras separat av den som ansvarar för systemet.</p>
        </div>
      </section>
    </main>
  );
}
