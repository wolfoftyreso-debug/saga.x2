import { isVercelIdentityConfigured, missingVercelIdentityConfiguration } from "@/lib/auth/vercel-oauth";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const ready = isVercelIdentityConfigured();
  const missing = missingVercelIdentityConfiguration();

  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">PRIVAT ARBETSYTA</p>
        <h1>Logga in med Vercel.</h1>
        <p>SAGA använder Vercels inloggning. Du behöver inget separat lösenord.</p>
        {ready ? (
          <a className="primary-button" href="/api/auth/authorize?next=/studio">Fortsätt med Vercel</a>
        ) : (
          <div className="setup-blocker" role="alert">
            <span className="setup-blocker-icon" aria-hidden="true">!</span>
            <div>
              <p className="assistant-label">INLOGGNING ÄR INTE ANSLUTEN</p>
              <h2>Skapa en Sign in with Vercel-app först.</h2>
              <p>Det som saknas: {missing.join(", ")}.</p>
              <a className="secondary-button" href="https://vercel.com/docs/sign-in-with-vercel/getting-started" target="_blank" rel="noreferrer">Öppna inloggningsguiden ↗</a>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
