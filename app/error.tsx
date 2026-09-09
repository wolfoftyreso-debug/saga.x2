"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">TILLFÄLLIGT FEL</p>
        <h1>Briefen kunde inte läsas just nu.</h1>
        <p>Ingen ofullständig information visas. Försök igen om en liten stund.</p>
        <button className="primary-button" onClick={reset}>Försök igen</button>
      </section>
    </main>
  );
}
