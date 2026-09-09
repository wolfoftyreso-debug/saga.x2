"use client";

import { useState } from "react";
import styles from "./saga-creative-direction-board.module.css";

type BeatId = "hook" | "reveal" | "value" | "offer" | "cta";

type StoryboardBeat = {
  id: BeatId;
  label: string;
  timing: string;
  visual: string;
  copy: string;
};

export type SagaCreativeDirection = {
  id: string;
  label: string;
  format: string;
  runtime: string;
  title: string;
  summary: string;
  productionNote: string;
  beats: readonly StoryboardBeat[];
  audioNote: string;
  safetyNote: string;
};

/**
 * A production-safe, local demonstration of how a loose creative thought is
 * turned into a timed short-form storyboard. It has no generated media,
 * storage or publishing side effects.
 */
export const SAGA_SEASONAL_TYRE_STORYBOARDS: readonly SagaCreativeDirection[] = [
  {
    id: "time-flies",
    label: "Tiden flyger",
    format: "Vertikal 9:16 · Reels / Stories",
    runtime: "15 sek",
    title: "Ett mönsterbrott utan att skapa fara.",
    summary: "Ett snabbt, tryggt visuellt tecken på att säsongen skiftar — sedan direkt till lugn hjälp och ett enkelt nästa steg.",
    productionNote: "Låt Sätra Elbilshus synas diskret i verkstadsmiljön redan i öppningen. All rörelse sker i en kontrollerad bild, aldrig nära människor eller trafik.",
    beats: [
      {
        id: "hook",
        label: "Hook",
        timing: "0–2 s",
        visual: "En animerad däck- och klocksymbol snurrar på en låst display i en tom, lugn verkstadsmiljö.",
        copy: "Tiden flyger.",
      },
      {
        id: "reveal",
        label: "Avslöja",
        timing: "2–4 s",
        visual: "Rörelsen stannar mjukt. En ren typografisk skylt tar över bildytan.",
        copy: "Men ditt däckbyte behöver inte överraska.",
      },
      {
        id: "value",
        label: "Värde",
        timing: "4–9 s",
        visual: "Rådgivare och kund möts i en tydligt avgränsad mottagningsyta. Tre enkla steg visas som grafiska punkter.",
        copy: "Boka i tid. Vi hjälper dig att planera bytet lugnt och tydligt.",
      },
      {
        id: "offer",
        label: "Erbjudande",
        timing: "9–12 s",
        visual: "En enda erbjudanderuta med plats för godkända villkor, datum och eventuell prisuppgift.",
        copy: "Visa endast ett verifierat erbjudande här.",
      },
      {
        id: "cta",
        label: "CTA",
        timing: "12–15 s",
        visual: "Logotyp, bokningsväg och lugn slutbild med god läsbarhet på mobil.",
        copy: "Boka din tid i Sätra.",
      },
    ],
    audioNote: "Fungerar utan ljud: varje kärnrad textas. Använd ett kort, mjukt stopp-ljud i avslöjandet om ljud är på.",
    safetyNote: "Ingen lös eller fallande rekvisita, ingen höjd, ingen trafik och inga människor i eller nära en risksituation.",
  },
  {
    id: "calendar-first",
    label: "Kalendern hinner före",
    format: "Vertikal 9:16 · Reels / Stories",
    runtime: "15 sek",
    title: "Gör planeringen till den oväntade hjälten.",
    summary: "Ett igenkännbart kalenderögonblick ersätter stress med kontroll. Passar när erbjudandet handlar om enkel bokning snarare än dramatik.",
    productionNote: "Bygg öppningen med stilla, fysiska objekt på ett skrivbord eller en neutral grafisk yta. Ingen verkstadsprocess behöver visas.",
    beats: [
      {
        id: "hook",
        label: "Hook",
        timing: "0–3 s",
        visual: "En kalenderbladsvändning stannar på första kalla veckan. Ett däckmönster syns som en enkel, stilla detalj bredvid.",
        copy: "Redan dags att tänka vinterdäck?",
      },
      {
        id: "reveal",
        label: "Avslöja",
        timing: "3–5 s",
        visual: "En bokningsmarkering landar i kalendern och förvandlar bilden från fråga till plan.",
        copy: "Bra. Då ligger du före.",
      },
      {
        id: "value",
        label: "Värde",
        timing: "5–9 s",
        visual: "Tre korta textrader med generös luft: tid, överblick och ett tydligt möte.",
        copy: "Välj en tid som passar vardagen — resten går vi igenom tillsammans.",
      },
      {
        id: "offer",
        label: "Erbjudande",
        timing: "9–12 s",
        visual: "Ett rent kort för kampanjvillkor, utan små textmassor eller otydliga löften.",
        copy: "Lägg in villkor först när de är bekräftade.",
      },
      {
        id: "cta",
        label: "CTA",
        timing: "12–15 s",
        visual: "Bokningsknapp och lokal avsändare ligger stilla i minst två sekunder.",
        copy: "Välj en tid för däckskifte.",
      },
    ],
    audioNote: "Låt en diskret kalendermarkering bära rytmen. Text och kontrast ska klara en ljudlös visning.",
    safetyNote: "Använd neutral rekvisita och godkända miljöer. Inga stressade förare, väderdrama eller verktyg i aktiv användning.",
  },
  {
    id: "season-shift",
    label: "Säsongen skiftar",
    format: "Vertikal 9:16 · Reels / Stories",
    runtime: "15 sek",
    title: "En visuellt varm växling från sommar till vinter.",
    summary: "En enkel bildövergång visar att det är dags att ta hand om nästa steg — utan att använda rädsla eller press som drivkraft.",
    productionNote: "Filma eller komponera två stilla, godkända miljöbilder. Förändringen sker i redigeringen, inte genom en fysisk stunt eller riskfylld handling.",
    beats: [
      {
        id: "hook",
        label: "Hook",
        timing: "0–3 s",
        visual: "En varm höstbild skiftar mjukt till en kyligare, klar morgonbild. Bilen står stilla på en privat, tom plats.",
        copy: "Säsongen byter tempo.",
      },
      {
        id: "reveal",
        label: "Avslöja",
        timing: "3–5 s",
        visual: "En enkel rubrik bryter övergången med hög kontrast och lugn rytm.",
        copy: "Ditt däckbyte kan vara enkelt.",
      },
      {
        id: "value",
        label: "Värde",
        timing: "5–9 s",
        visual: "Närbild på märkning, bokningsskärm och mottagningsyta — aldrig en aktiv lyft- eller bytesprocess.",
        copy: "Få koll på tid, upplägg och nästa steg före besöket.",
      },
      {
        id: "offer",
        label: "Erbjudande",
        timing: "9–12 s",
        visual: "Ett brandat informationskort med tydlig plats för den ansvariges godkända kampanjtext.",
        copy: "Skriv exakt vad som ingår — och när.",
      },
      {
        id: "cta",
        label: "CTA",
        timing: "12–15 s",
        visual: "Ren avslutning med bokningslänk, öppettider vid behov och tydlig avsändare.",
        copy: "Planera ditt däckbyte i Sätra.",
      },
    ],
    audioNote: "En mjuk årstidsövergång och textning räcker. Undvik alarmerande ljud eller effekter som signalerar fara.",
    safetyNote: "Fordonet är parkerat och platsen är tom. All bildbehandling ska förstärka övergången, inte skapa en farlig händelse.",
  },
];

const BEAT_META: Record<BeatId, { number: string; className: string }> = {
  hook: { number: "01", className: styles.hook },
  reveal: { number: "02", className: styles.reveal },
  value: { number: "03", className: styles.value },
  offer: { number: "04", className: styles.offer },
  cta: { number: "05", className: styles.cta },
};

export function SagaCreativeDirectionBoard() {
  const [selectedId, setSelectedId] = useState(SAGA_SEASONAL_TYRE_STORYBOARDS[0]?.id ?? "");
  const selected = SAGA_SEASONAL_TYRE_STORYBOARDS.find((direction) => direction.id === selectedId) ?? SAGA_SEASONAL_TYRE_STORYBOARDS[0];

  if (!selected) return null;

  return (
    <section className={styles.board} aria-labelledby="creative-direction-title">
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}><span aria-hidden="true" /> KREATIV RIKTNING · KORTFORMAT</p>
          <h2 id="creative-direction-title">Från uppmärksamhet till bokning — utan att skapa fara.</h2>
          <p>Tre produktionsklara storyboardspår för ett vinterdäcksklipp. Varje riktning visar exakt hur hook, budskap, värde och CTA hänger ihop innan någon inspelning beställs.</p>
        </div>
        <aside className={styles.practice} aria-label="Praxis för kortformat">
          <span><Icon name="timer" /></span>
          <div><strong>Praxis i kortformat</strong><p>Fånga intresset tidigt, visa avsändaren naturligt, texta för ljudlöst flöde och håll en enda handling tydlig.</p></div>
        </aside>
      </header>

      <div className={styles.layout}>
        <div className={styles.directionList} role="tablist" aria-label="Välj kreativ riktning">
          {SAGA_SEASONAL_TYRE_STORYBOARDS.map((direction, index) => {
            const active = direction.id === selected.id;
            return (
              <button
                key={direction.id}
                id={`creative-direction-tab-${direction.id}`}
                className={`${styles.directionButton}${active ? ` ${styles.directionButtonActive}` : ""}`}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`creative-direction-panel-${direction.id}`}
                onClick={() => setSelectedId(direction.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{direction.label}</strong><small>{direction.runtime} · {direction.format}</small></div>
                <Icon name="arrow" />
              </button>
            );
          })}
          <p className={styles.localNote}><Icon name="lock" /> Lokal storyboarddemo — den skapar, bokar eller publicerar inget.</p>
        </div>

        <article className={styles.storyboard} id={`creative-direction-panel-${selected.id}`} role="tabpanel" aria-labelledby={`creative-direction-tab-${selected.id}`}>
          <header className={styles.storyboardHeader}>
            <div><p>{selected.format}</p><h3>{selected.title}</h3></div>
            <span>{selected.runtime}</span>
          </header>
          <p className={styles.summary}>{selected.summary}</p>
          <p className={styles.productionNote}><Icon name="camera" /><span><strong>Produktionsriktning</strong>{selected.productionNote}</span></p>

          <ol className={styles.beats} aria-label="Storyboard från hook till CTA">
            {selected.beats.map((beat) => {
              const meta = BEAT_META[beat.id];
              return (
                <li key={beat.id} className={meta.className}>
                  <div className={styles.beatMeta}><span>{meta.number}</span><strong>{beat.label}</strong><small>{beat.timing}</small></div>
                  <div className={styles.beatVisual}><span>Bild</span><p>{beat.visual}</p></div>
                  <div className={styles.beatCopy}><span>Copy</span><p>“{beat.copy}”</p></div>
                </li>
              );
            })}
          </ol>

          <div className={styles.executionNotes}>
            <p><Icon name="sound" /><span><strong>Ljud &amp; textning</strong>{selected.audioNote}</span></p>
            <p><Icon name="shield" /><span><strong>Säker produktion</strong>{selected.safetyNote}</span></p>
          </div>
        </article>

        <aside className={styles.guardrails} aria-label="Skyddsräcken för produktion och erbjudande">
          <div className={styles.guardrailsHeading}><span><Icon name="shield" /></span><div><p>SKYDDSRÄCKEN</p><h3>Tryggt att spela in. Sant att lova.</h3></div></div>
          <ul>
            <li><Icon name="check" />Bygg ett visuellt mönsterbrott, inte en nära-olycka eller en risksituation.</li>
            <li><Icon name="check" />Visa aldrig lösa hjul, fallhöjd, trafik, aktiva verktyg eller människor nära något riskfyllt.</li>
            <li><Icon name="check" />Låt en ansvarig godkänna plats, rekvisita, miljö och slutlig klippning före användning.</li>
          </ul>
          <div className={styles.offerGate}>
            <span><Icon name="check" /></span>
            <div><strong>Erbjudande kräver verifiering</strong><p>Pris, vad som ingår, datum, lager/tider och villkor ska vara bekräftade innan ruta 04 fylls eller något går till granskning.</p></div>
          </div>
          <p className={styles.copyGuard}><strong>Copyregel:</strong> erbjud hjälp och framförhållning — aldrig skrämsel, skuld eller påståenden som inte kan styrkas.</p>
        </aside>
      </div>
    </section>
  );
}

type IconName = "arrow" | "camera" | "check" | "lock" | "shield" | "sound" | "timer";

function Icon({ name }: { name: IconName }) {
  if (name === "arrow") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "camera") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="6.5" width="16" height="12" rx="2.3" /><path d="m9 6.5 1.2-2h3.6l1.2 2" strokeLinecap="round" strokeLinejoin="round" /><circle cx="12" cy="12.5" r="3" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.2 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "lock") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5.5" y="10" width="13" height="10" rx="2.2" /><path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" strokeLinecap="round" /></svg>;
  if (name === "shield") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.8 19 6v5.2c0 4.3-2.7 7.5-7 9-4.3-1.5-7-4.7-7-9V6l7-2.2Z" /><path d="m8.7 12 2.1 2.1 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "sound") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 10h3l4-3.5v11L8 14H5v-4Z" strokeLinejoin="round" /><path d="M15.2 9.2a4.1 4.1 0 0 1 0 5.6M17.8 6.5a7.8 7.8 0 0 1 0 11" strokeLinecap="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3.3 2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
