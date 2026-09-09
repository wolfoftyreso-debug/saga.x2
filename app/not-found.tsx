import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <p className="eyebrow">HITTADES INTE</p>
        <h1>Den här händelsen är inte tillgänglig.</h1>
        <p>Du kan bara öppna händelser som ingår i din egen briefhistorik.</p>
        <Link className="primary-button link-button" href="/">Till Idag</Link>
      </section>
    </main>
  );
}
