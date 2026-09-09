"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./saga-preview-gallery.module.css";

type DemoChannel = "instagram" | "linkedin" | "newsletter" | "article";
type DemoImageKey = DemoChannel | "family";

export type SagaPreviewImageAssets = Record<DemoImageKey, string>;

export type SagaPreviewExample = {
  id: string;
  channel: DemoChannel;
  title: string;
  eyebrow: string;
  image: keyof SagaPreviewImageAssets;
  supportingImage?: keyof SagaPreviewImageAssets;
  imageAlt: string;
  sourceSummary: string;
  evidence: readonly string[];
  qualityChecks: readonly string[];
  copy: {
    subject?: string;
    preheader?: string;
    lead: string;
    paragraphs: readonly string[];
    cta: string;
    tags?: readonly string[];
  };
};

export const SAGA_PREVIEW_FALLBACK_IMAGES: SagaPreviewImageAssets = {
  instagram: "/demo/saga/automation-human-work-v1.png",
  linkedin: "/demo/saga/automation-human-work-v1.png",
  newsletter: "/demo/saga/automation-human-work-v1.png",
  article: "/demo/saga/automation-human-work-v1.png",
  family: "/demo/saga/automation-human-work-v1.png",
};

export const SAGA_PREVIEW_EXAMPLES: readonly SagaPreviewExample[] = [
  {
    id: "maskinens-jobb",
    channel: "instagram",
    title: "När systemet bär repetitionen får livet mer plats.",
    eyebrow: "Instagram · bildinlägg",
    image: "instagram",
    supportingImage: "family",
    imageAlt: "En person lämnar ett byggprojekt vid vatten, med en enkel systemskiss ritad i trä.",
    sourceSummary: "Ett handbyggt referensexempel i en personlig, lågmäld ton. Inga externa nyhets- eller produktpåståenden används.",
    evidence: [
      "Kärninsikt: det som återkommer utan att behöva uppmärksamhet är ofta värt att bygga bort.",
      "Perspektiv: system ska frigöra tid utan att ta över ansvar eller omdöme.",
      "Avgränsning: inga mätetal eller löften om effekt används i exemplet.",
    ],
    qualityChecks: ["Konkret första rad", "Personlig utan stora löften", "Ingen osäker fakta"],
    copy: {
      lead: "Det finaste med ett bra system är ofta att det inte gör väsen av sig. Det som tidigare tog tid bara fungerar.",
      paragraphs: [
        "Jag bygger inte automation för att pressa in mer i dagen. Jag bygger den för att plocka bort sådant som aldrig behövde ligga på en människa från början.",
        "När repetitionen får en egen väg finns mer kvar till samtal, natur, mat, människor man tycker om och byggprojekt som får ta den tid de behöver.",
      ],
      cta: "Vilket återkommande moment skulle du helst slippa bära själv?",
      tags: ["#systembyggande", "#automation", "#arbetsliv"],
    },
  },
  {
    id: "friktion-fore-funktion",
    channel: "linkedin",
    title: "Bra system tar hand om friktionen. Människor tar hand om det viktiga.",
    eyebrow: "LinkedIn · branschreflektion",
    image: "linkedin",
    imageAlt: "En lugn byggmiljö i naturen där en systemskiss ligger synlig på ett arbetsbord.",
    sourceSummary: "Ett handbyggt referensexempel. Texten är ett perspektiv, inte en nyhetsanalys eller marknadsrapport.",
    evidence: [
      "Editorial lens: börja i arbetet som upprepas, inte i den nya tekniken.",
      "Målgrupp: team som vill bygga bort rutin utan att tappa ansvar.",
      "Ingen extern statistik, produktuppgift eller effektgaranti förekommer.",
    ],
    qualityChecks: ["Tydlig ståndpunkt", "Saklig utan säljspråk", "Mänsklig nytta före teknik"],
    copy: {
      lead: "När samma klick, kopieringar och påminnelser hamnar hos samma person vecka efter vecka är det värt att fråga om arbetet verkligen behöver vara manuellt.",
      paragraphs: [
        "För mig ligger värdet i att frigöra fokus – inte i att göra organisationer opersonliga. Erfarenhet, sammanhang och ansvar ska fortfarande finnas kvar där de behövs.",
        "Ett system som går att lita på gör det vardagliga enklare och undantagen tydliga. Där finns utrymme för bättre produkter, bättre service och arbetsdagar som tar mindre energi.",
      ],
      cta: "Vilka återkommande moment skulle ni kunna bygga bort utan att bygga bort omdömet?",
      tags: ["#systemdesign", "#automation", "#produktutveckling"],
    },
  },
  {
    id: "system-slapper",
    channel: "newsletter",
    title: "Ett mindre manuellt moment i taget.",
    eyebrow: "Nyhetsbrev · e-postutskick",
    image: "newsletter",
    imageAlt: "En människa på väg från ett byggprojekt ut i naturen i varmt kvällsljus.",
    sourceSummary: "Ett handbyggt referensexempel för e-postformat. Det visar en lugn, redaktionell följd utan mottagarlista eller utskickshantering.",
    evidence: [
      "Mottagartanke: den som vill lägga mindre tid på rutin och behålla kontrollen.",
      "Värde: tre enkla frågor före varje automatisering.",
      "Avgränsning: exemplen saknar mottagarlista, utskick och koppling till konto.",
    ],
    qualityChecks: ["Tydlig ämnesrad", "En idé i taget", "Konkreta nästa steg"],
    copy: {
      subject: "När vardagen flyter finns mer kvar till livet",
      preheader: "Tre frågor innan du automatiserar.",
      lead: "Jag återkommer ofta till samma sak: ett system ska bära det repetitiva utan att ta över människans ansvar.",
      paragraphs: [
        "1. Vad kommer tillbaka varje vecka?  2. Var fastnar det?  3. Vad behöver faktiskt ett mänskligt beslut?",
        "Automatisera först det som är tydligt. Låt resten vara synligt tills ni vet att det fungerar. Då blir förändringen mindre dramatisk – och lättare att lita på.",
      ],
      cta: "Svara gärna med ett moment du vill ge mindre av din tid.",
    },
  },
  {
    id: "frihet-att-bygga",
    channel: "article",
    title: "Vi är inte skapta för att göra en maskins arbete.",
    eyebrow: "Artikel · eget nyhetsflöde",
    image: "article",
    imageAlt: "Ett arbetsbord med en enkel systemskiss i trä och ett byggprojekt i naturen bakom.",
    sourceSummary: "Ett handbyggt referensexempel. Det beskriver en personlig systemsyn, inte en teknisk specifikation eller ett faktapåstående.",
    evidence: [
      "Artikelvinkel: från automatisering av repetition till mer mänskligt handlingsutrymme.",
      "Avgränsning: inga externa faktapåståenden är publiceringsklara i detta exempel.",
      "Ett verkligt utkast behöver verifierade källor och ägarens godkännande innan publicering.",
    ],
    qualityChecks: ["Rubrik med tydlig nytta", "Läsbar struktur", "Tydlig transparens"],
    copy: {
      lead: "Det finns arbete som förtjänar en människas uppmärksamhet. Att flytta data mellan system, jaga samma status eller svara på samma fråga om och om igen hör sällan dit.",
      paragraphs: [
        "Jag tycker om system eftersom de kan skapa ett slags lugn. När stegen hänger ihop och rutinen är pålitlig släpper lite av det där osynliga trycket i kroppen.",
        "Det är därför system är min grej. Inte för att allt ska bli perfekt, utan för att vardagen kan släppa lite när rätt saker får gå av sig själva.",
        "Den tid som frigörs behöver inte fyllas med mer arbete. Den kan gå till ett bygge, middag med människor man tycker om, en promenad i skogen eller ett problem som faktiskt behöver ens närvaro.",
      ],
      cta: "Läs om att bygga system som lämnar mer plats åt livet.",
    },
  },
];

const CHANNEL_META: Record<DemoChannel, { label: string; shortLabel: string; accent: string; format: string }> = {
  instagram: { label: "Instagram", shortLabel: "IG", accent: "#b43b72", format: "4:5 · Bildinlägg" },
  linkedin: { label: "LinkedIn", shortLabel: "in", accent: "#2866a6", format: "1.91:1 · Flödesinlägg" },
  newsletter: { label: "Nyhetsbrev", shortLabel: "✉", accent: "#8d5f16", format: "600 px · E-post" },
  article: { label: "Eget flöde", shortLabel: "↗", accent: "#2e7562", format: "16:9 · Artikel" },
};

function channelClass(channel: DemoChannel) {
  return channel === "instagram" ? styles.instagram : channel === "linkedin" ? styles.linkedin : channel === "newsletter" ? styles.newsletter : styles.article;
}

/**
 * A deliberately separate gallery of static, local reference examples. It
 * accepts only local image paths and owns no network, storage, schedule,
 * sending or publishing action.
 */
export function SagaPreviewGallery({
  images = SAGA_PREVIEW_FALLBACK_IMAGES,
  examples = SAGA_PREVIEW_EXAMPLES,
}: {
  images?: SagaPreviewImageAssets;
  examples?: readonly SagaPreviewExample[];
}) {
  const [selectedId, setSelectedId] = useState(examples[0]?.id ?? "");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const galleryRef = useRef<HTMLElement>(null);
  const selected = useMemo(() => examples.find((example) => example.id === selectedId) ?? examples[0], [examples, selectedId]);

  useEffect(() => {
    const gallery = galleryRef.current;
    if (!gallery) return;

    const syncInspector = (width: number) => setInspectorOpen(width >= 1280);
    syncInspector(gallery.getBoundingClientRect().width);

    const observer = new ResizeObserver(([entry]) => syncInspector(entry.contentRect.width));
    observer.observe(gallery);
    return () => observer.disconnect();
  }, []);

  if (!selected) return null;

  const channel = CHANNEL_META[selected.channel];

  return (
    <section className={styles.gallery} ref={galleryRef} aria-labelledby="saga-preview-title">
      <header className={styles.hero}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}><span aria-hidden="true" /> EXEMPELGALLERI · AUTOMATION AV MÄNSKLIGT ARBETE</p>
          <h1 id="saga-preview-title">Se hur en systemsyn kan bli mänskligt innehåll i fyra kanaler.</h1>
          <p>Det här är fyra handbyggda referensexempel om automation som frigör människor från repetitivt maskinarbete. De tillhör inte din arbetsyta och kan inte sparas, planeras eller publiceras.</p>
        </div>
        <div className={styles.demoBoundary} aria-label="Vad exempelgalleriet är">
          <span className={styles.boundaryIcon} aria-hidden="true"><Icon name="shield" /></span>
          <div><strong>Inte en förhandsvisning av ditt utkast</strong><p>En riktig förhandsvisning öppnar du i Studio, från ett sparat utkast.</p></div>
        </div>
      </header>

      <div className={styles.summaryBar} aria-label="Översikt">
        <span><b>4</b> referensexempel</span>
        <span><b>4</b> kanaltyper</span>
        <span><b>0</b> anslutna konton här</span>
        <Link href="/studio/content/new?edit=1">Skapa ett eget utkast <Icon name="arrow" /></Link>
      </div>

      <div className={styles.workspace}>
        <aside className={styles.collection} aria-label="Välj referensexempel">
          <div className={styles.collectionHeading}>
            <p>REFERENSEXEMPEL</p>
            <span>Systembyggaren</span>
          </div>
          <div className={styles.exampleList} role="tablist" aria-orientation="vertical" aria-label="Exempel i galleriet">
            {examples.map((example) => {
              const itemChannel = CHANNEL_META[example.channel];
              const isSelected = selected.id === example.id;
              return (
                <button
                  className={`${styles.exampleItem}${isSelected ? ` ${styles.exampleItemSelected}` : ""}`}
                  id={`preview-tab-${example.id}`}
                  key={example.id}
                  onClick={() => setSelectedId(example.id)}
                  role="tab"
                  type="button"
                  aria-selected={isSelected}
                  aria-controls={`preview-panel-${example.id}`}
                >
                  <span className={`${styles.exampleThumb} ${channelClass(example.channel)}`}>
                    <img src={images[example.image]} alt="" />
                    <i aria-hidden="true">{itemChannel.shortLabel}</i>
                  </span>
                  <span className={styles.exampleCopy}>
                    <span className={styles.exampleMeta}><i style={{ background: itemChannel.accent }} aria-hidden="true" />{itemChannel.label} · {itemChannel.format}</span>
                    <strong>{example.title}</strong>
                    <small className={styles.status}>Referensexempel</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              );
            })}
          </div>
          <p className={styles.collectionNote}><Icon name="eye" /> Välj ett exempel för att jämföra kanalform, bildriktning och textstruktur.</p>
        </aside>

        <div className={styles.stage}>
          <div className={styles.stageTopline}>
            <div><span className={`${styles.channelMark} ${channelClass(selected.channel)}`}>{channel.shortLabel}</span><p>{channel.label}</p><small>{channel.format}</small></div>
            <span className={styles.status}>Referensexempel</span>
          </div>
          <p className={styles.exampleScope} role="note"><Icon name="eye" /> Systembyggaren är en exempelprofil, inte ett anslutet konto.</p>

          <article className={`${styles.postSurface} ${channelClass(selected.channel)}`} id={`preview-panel-${selected.id}`} role="tabpanel" aria-labelledby={`preview-tab-${selected.id}`}>
            {selected.channel === "newsletter" && <div className={styles.emailChrome}><span>Systembyggaren · exempel</span><small>Visningsformat, inte e-post</small></div>}
            {selected.channel === "article" && <div className={styles.articleChrome}><span>INSIKTER · EXEMPEL</span><small>Visningsformat, inte publicerat</small></div>}
            {selected.channel !== "newsletter" && selected.channel !== "article" && <div className={styles.socialChrome}><span className={`${styles.avatar} ${channelClass(selected.channel)}`}>S</span><div><strong>Systembyggaren · exempel</strong><small>Illustrativt kanalformat</small></div><span className={styles.moreMark} aria-hidden="true">···</span></div>}
            {selected.copy.subject && <div className={styles.emailSubject}><span>Ämnesrad</span><strong>{selected.copy.subject}</strong>{selected.copy.preheader && <small>{selected.copy.preheader}</small>}</div>}
            <figure className={styles.media}>
              <img src={images[selected.image]} alt={selected.imageAlt} />
              {selected.supportingImage && <span className={styles.carouselPreview} aria-label="Andra bilden i Instagram-karusellen"><img src={images[selected.supportingImage]} alt="Andra referensbilden i karusellen." /><i>2</i></span>}
            </figure>
            <div className={styles.postCopy}>
              <p className={styles.postEyebrow}>{selected.eyebrow}</p>
              <h2>{selected.title}</h2>
              <p className={styles.lead}>{selected.copy.lead}</p>
              {selected.copy.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              <p className={styles.postCta}><span>Exempel på uppmaning</span><strong>{selected.copy.cta}</strong></p>
              {selected.copy.tags && <p className={styles.tags}>{selected.copy.tags.join("  ")}</p>}
            </div>
            {(selected.channel === "instagram" || selected.channel === "linkedin") && <div className={styles.socialFooter}><small>Visningsexempel · inte publicerat</small></div>}
          </article>

          <div className={styles.exampleBoundary} role="note">
            <span><Icon name="lock" /></span>
            <div><p>DET HÄR VISAR</p><strong>Kanalform, bildriktning och textstruktur.</strong><small>Det visar inte ett schemalagt inlägg. Skapa, redigera och planera eget innehåll i Studio.</small></div>
            <Link href="/studio/content/new?edit=1">Skapa utkast <Icon name="arrow" /></Link>
          </div>
        </div>

        <details
          className={styles.inspector}
          open={inspectorOpen}
          onToggle={(event) => setInspectorOpen(event.currentTarget.open)}
        >
          <summary className={styles.inspectorSummary}>
            <span><Icon name="source" /></span>
            <span><b>Underlag &amp; kvalitetsnoter</b><small>Varför exemplet ser ut som det gör.</small></span>
            <Icon name="chevron" />
          </summary>
          <div className={styles.inspectorBody} aria-label="Transparens och kvalitetskontroller">
            <section className={styles.inspectorIntro}>
              <p>EXEMPLETS RAM</p>
              <strong>Ett referensexempel – inte ett sparat utkast.</strong>
              <span><Icon name="lock" /> Det kan inte sparas, planeras eller publiceras härifrån.</span>
            </section>
            <section className={styles.inspectorSection}>
              <div className={styles.inspectorHeading}><span><Icon name="source" /></span><div><p>REFERENS &amp; RIKTNING</p><h2>Vad illustrerar det här?</h2></div></div>
              <p>{selected.sourceSummary}</p>
              <ul>{selected.evidence.map((item) => <li key={item}><Icon name="check" />{item}</li>)}</ul>
            </section>
            <section className={styles.inspectorSection}>
              <div className={styles.inspectorHeading}><span><Icon name="spark" /></span><div><p>KVALITET ATT TA MED</p><h2>Kontrollerad riktning</h2></div></div>
              <div className={styles.qualityList}>{selected.qualityChecks.map((check) => <span key={check}><Icon name="check" />{check}</span>)}</div>
            </section>
            <div className={styles.inspectorActions}>
              <Link href="/studio/content/new?edit=1">Skapa ett eget utkast <Icon name="arrow" /></Link>
              <Link href="/studio">Öppna Studio <Icon name="arrow" /></Link>
            </div>
          </div>
        </details>
      </div>

      <footer className={styles.footer} id="example-gallery-boundary">
        <div><span aria-hidden="true"><Icon name="shield" /></span><p><strong>Det här är ett exempelgalleri.</strong> En riktig förhandsvisning visar ditt eget, sparade utkast i Studio innan du väljer att planera eller publicera.</p></div>
        <Link href="/studio">Till Studio <Icon name="arrow" /></Link>
      </footer>
    </section>
  );
}

type IconName = "arrow" | "check" | "chevron" | "eye" | "image" | "lock" | "shield" | "source" | "spark";

function Icon({ name }: { name: IconName }) {
  if (name === "arrow") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.2 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "chevron") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m9.2 5.7 6 6.3-6 6.3" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "eye") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3.8 12s2.7-5 8.2-5 8.2 5 8.2 5-2.7 5-8.2 5-8.2-5-8.2-5Z" /><circle cx="12" cy="12" r="2.1" /></svg>;
  if (name === "image") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2.4" /><circle cx="9" cy="9" r="1.3" /><path d="m5.5 17 4.2-4.1 3 2.6 2.1-2.1 3.7 3.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "lock") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5.5" y="10" width="13" height="10" rx="2.2" /><path d="M8.5 10V7.8a3.5 3.5 0 0 1 7 0V10" strokeLinecap="round" /></svg>;
  if (name === "shield") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.8 19 6v5.2c0 4.3-2.7 7.5-7 9-4.3-1.5-7-4.7-7-9V6l7-2.2Z" /><path d="m8.7 12 2.1 2.1 4.5-4.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "source") return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 4.5h9.5A2.5 2.5 0 0 1 19 7v12.5H7A2.5 2.5 0 0 0 4.5 22V7A2.5 2.5 0 0 1 7 4.5Z" /><path d="M8.5 9h6m-6 3.5h6m-6 3.5h3.5" strokeLinecap="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.5c.3 4.4 2.1 6.2 6.5 6.5-4.4.3-6.2 2.1-6.5 6.5-.3-4.4-2.1-6.2-6.5-6.5 4.4-.3 6.2-2.1 6.5-6.5Z" strokeLinejoin="round" /></svg>;
}
