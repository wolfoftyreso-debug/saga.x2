"use client";

import Link from "next/link";
import { useState, type FormEvent, type KeyboardEvent } from "react";

type FlowFormat = "newsletter" | "social" | "article" | "series";
type FlowTone = "rak" | "varm" | "expert";
type PreviewIconName = "spark" | "arrow" | "check" | "edit" | "image" | "calendar" | "send" | "layers" | "reset";

const flowFormats: Array<{ id: FlowFormat; label: string; detail: string; icon: PreviewIconName }> = [
  { id: "newsletter", label: "Nyhetsbrev", detail: "En tydlig tanke till era mottagare.", icon: "send" },
  { id: "social", label: "Socialt inlägg", detail: "En skarp vinkel för ert flöde.", icon: "spark" },
  { id: "article", label: "Artikel", detail: "En idé med mer utrymme och struktur.", icon: "edit" },
  { id: "series", label: "Återkommande serie", detail: "Ett format som kan bli ett flöde.", icon: "layers" },
];

const toneOptions: Array<{ id: FlowTone; label: string; detail: string }> = [
  { id: "rak", label: "Rak", detail: "Huvudpoängen först." },
  { id: "varm", label: "Varm", detail: "Nära och mänsklig." },
  { id: "expert", label: "Insiktsdriven", detail: "Förklara utan fluff." },
];

type Variation = { id: string; label: string; eyebrow: string; title: string; body: string; imageDirection: string };

/** Local-only product review. It previews creation and never writes or publishes data. */
export function PreviewWorkspace() {
  const [format, setFormat] = useState<FlowFormat>("newsletter");
  const [tone, setTone] = useState<FlowTone>("rak");
  const [topic, setTopic] = useState("");
  const [generated, setGenerated] = useState(false);
  const [selectedVariationId, setSelectedVariationId] = useState("direct");

  const selectedFormat = flowFormats.find((item) => item.id === format) ?? flowFormats[0];
  const selectedTone = toneOptions.find((item) => item.id === tone) ?? toneOptions[0];
  const subject = topic.trim() || "att göra vardagen enklare för era kunder";
  const variations = previewVariations(subject, selectedFormat.label, selectedTone.label);
  const selectedVariation = variations.find((item) => item.id === selectedVariationId) ?? variations[0];

  function createPreview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setGenerated(true);
    setSelectedVariationId("direct");
  }

  function onTopicKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function restart() {
    setTopic("");
    setTone("rak");
    setFormat("newsletter");
    setGenerated(false);
    setSelectedVariationId("direct");
  }

  return (
    <div className="preview-flow-shell">
      <a className="preview-flow-skip" href="#preview-flow-main">Hoppa till skapandet</a>
      <header className="preview-flow-topbar">
        <Link className="preview-flow-brand" href="/studio" aria-label="SAGA">
          <span aria-hidden="true"><PreviewIcon name="spark" /></span>
          <strong>SAGA</strong>
        </Link>
        <div className="preview-flow-topbar-center"><span>FÖRHANDSVISNING</span><small>Lokalt exempel · inget sparas</small></div>
        <Link className="preview-flow-live-link" href="/studio/content/new?edit=1">Öppna Studio <PreviewIcon name="arrow" /></Link>
      </header>

      <main className="preview-flow-main" id="preview-flow-main">
        <section className="preview-flow-intro" aria-labelledby="preview-flow-title">
          <p>SKAPA INNEHÅLL</p>
          <h1 id="preview-flow-title">Börja med det ni vill säga.</h1>
          <span>Välj format, ge en riktning och jämför uttryck innan något blir ett utkast.</span>
        </section>

        <div className="preview-flow-layout">
          <section className="preview-flow-builder" aria-labelledby="preview-flow-builder-title">
            <div className="preview-flow-section-heading">
              <span>01</span>
              <div><p>STARTA HÄR</p><h2 id="preview-flow-builder-title">Vad vill du skapa?</h2></div>
            </div>

            <form onSubmit={createPreview}>
              <fieldset className="preview-flow-format-picker">
                <legend>Välj ett format</legend>
                <div>
                  {flowFormats.map((item) => <button type="button" key={item.id} className={format === item.id ? "is-selected" : ""} aria-pressed={format === item.id} onClick={() => setFormat(item.id)}>
                    <span><PreviewIcon name={item.icon} /></span><strong>{item.label}</strong><small>{item.detail}</small>
                  </button>)}
                </div>
              </fieldset>

              <label className="preview-flow-topic">
                <span>Vad är idén eller råmaterialet?</span>
                <textarea value={topic} onChange={(event) => setTopic(event.target.value)} onKeyDown={onTopicKeyDown} placeholder="Till exempel: Vi vill berätta hur vi hjälper kunder när bilen inte startar en kall morgon." rows={4} />
                <small>Klistra in en tanke, punkter, en kundfråga eller ett underlag. ⌘/Ctrl + Enter visar exempelriktningar.</small>
              </label>

              <fieldset className="preview-flow-tone-picker">
                <legend>Vilken känsla ska uttrycket ha?</legend>
                <div>
                  {toneOptions.map((item) => <button type="button" key={item.id} className={tone === item.id ? "is-selected" : ""} aria-pressed={tone === item.id} onClick={() => setTone(item.id)}>
                    <strong>{item.label}</strong><small>{item.detail}</small>
                  </button>)}
                </div>
              </fieldset>

              <div className="preview-flow-create-row">
                <button className="preview-flow-primary" type="submit"><PreviewIcon name="spark" />Visa tre riktningar</button>
                <span>Endast lokalt exempel. Ingen AI körs och inget sparas.</span>
              </div>
            </form>
          </section>

          <aside className="preview-flow-steps" aria-label="Skapandets flöde">
            <p>FRÅN IDÉ TILL UTKAST</p>
            <ol>
              <li className="is-current"><span>01</span><div><strong>Riktning</strong><small>Format, ämne och ton.</small></div></li>
              <li className={generated ? "is-current" : ""}><span>02</span><div><strong>Variationer</strong><small>Jämför flera sätt att säga samma sak.</small></div></li>
              <li><span>03</span><div><strong>Redigera</strong><small>Gör text, bild och CTA till er egen.</small></div></li>
              <li><span>04</span><div><strong>Planera</strong><small>Välj tid och destination sist.</small></div></li>
            </ol>
            <div className="preview-flow-steps-note"><PreviewIcon name="check" /><span>Publicering är alltid ett separat, tydligt beslut.</span></div>
          </aside>
        </div>

        <section className={`preview-flow-results${generated ? " is-visible" : ""}`} aria-live="polite" aria-labelledby="preview-flow-results-title">
          <header>
            <div><p>02 · JÄMFÖR</p><h2 id="preview-flow-results-title">Tre sätt att börja på</h2><span>Exempelutkast för {selectedFormat.label.toLocaleLowerCase("sv-SE")} · {selectedTone.label.toLocaleLowerCase("sv-SE")} ton</span></div>
            {generated && <button type="button" onClick={restart}><PreviewIcon name="reset" />Börja om</button>}
          </header>

          {generated ? <div className="preview-flow-result-grid">
            <div className="preview-flow-variation-list" role="listbox" aria-label="Välj exempelriktning">
              {variations.map((variation, index) => <button key={variation.id} type="button" role="option" aria-selected={selectedVariation.id === variation.id} className={selectedVariation.id === variation.id ? "is-selected" : ""} onClick={() => setSelectedVariationId(variation.id)}>
                <span>{String(index + 1).padStart(2, "0")}</span><div><strong>{variation.label}</strong><small>{variation.eyebrow}</small></div><PreviewIcon name="arrow" />
              </button>)}
            </div>

            <article className="preview-flow-draft" aria-label="Valt exempelutkast">
              <div className="preview-flow-draft-topline"><span>EXEMPELUTKAST</span><small>{selectedFormat.label} · {selectedTone.label}</small></div>
              <h3>{selectedVariation.title}</h3>
              <p>{selectedVariation.body}</p>
              <div className="preview-flow-image-direction"><span><PreviewIcon name="image" /></span><div><strong>Bildriktning</strong><small>{selectedVariation.imageDirection}</small></div></div>
              <footer><span><PreviewIcon name="edit" />Nästa steg: öppna det riktiga utkastet och redigera.</span><Link href="/studio/content/new?edit=1">Öppna Studio <PreviewIcon name="arrow" /></Link></footer>
            </article>
          </div> : <div className="preview-flow-results-placeholder"><span><PreviewIcon name="spark" /></span><div><strong>Här ser du variationerna.</strong><p>Det intressanta är inte att fylla i inställningar. Det är att snabbt se en bra tanke bli flera användbara uttryck.</p></div></div>}
        </section>

        <section className="preview-flow-finish" aria-labelledby="preview-flow-finish-title">
          <div><p>03 · GÖR KLART</p><h2 id="preview-flow-finish-title">Redigera först. Planera sedan.</h2><span>Text, bild, rubrik och uppmaning hör hemma i ett riktigt utkast. Tid, mottagare och kanal blir relevanta först när innehållet är rätt.</span></div>
          <div className="preview-flow-finish-actions">
            <Link href="/studio/content/new?edit=1"><PreviewIcon name="edit" />Skapa ett riktigt utkast</Link>
            <Link href="/studio/automations"><PreviewIcon name="calendar" />Bygg ett återkommande flöde</Link>
          </div>
        </section>
      </main>
    </div>
  );
}

function previewVariations(topic: string, format: string, tone: string): Variation[] {
  return [
    { id: "direct", label: "Rak öppning", eyebrow: "Nyttan först", title: `Det här gör ${topic} enklare.`, body: `Börja i den konkreta situationen. Förklara sedan vad ni gör annorlunda och ge läsaren ett enkelt nästa steg. Det här visar hur en ${format.toLocaleLowerCase("sv-SE")} kan få en tydlig kärna utan utfyllnad.`, imageDirection: "En vardaglig situation, nära motiv, mjukt naturligt ljus och ingen text i bilden." },
    { id: "human", label: "Mänsklig situation", eyebrow: "Från igenkänning till hjälp", title: `När ${topic} händer vill man veta vad som gäller.`, body: `Öppna med ett ögonblick som målgruppen känner igen. Visa vad som är svårt, hur ni hjälper och vad man kan göra direkt. Tonen är ${tone.toLocaleLowerCase("sv-SE")}, men fortfarande konkret.`, imageDirection: "En person i rätt miljö, tydlig handling och lugn komposition med plats för kanalens beskärning." },
    { id: "insight", label: "Insikt och vinkel", eyebrow: "Förklara varför", title: `Det finns en bättre väg än att bara hantera ${topic}.`, body: "Lyft en insikt som gör ämnet användbart. Bryt ned den i ett enkelt resonemang och avsluta med ett tydligt erbjudande eller en fråga. Då får innehållet en egen ståndpunkt, inte bara information.", imageDirection: "En ren, redaktionell bild med ett visuellt fokus och en diskret färgpalett som passar varumärket." },
  ];
}

function PreviewIcon({ name }: { name: PreviewIconName }) {
  if (name === "spark") return <svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5c.3 4.4 2.1 6.2 6.5 6.5-4.4.3-6.2 2.1-6.5 6.5-.3-4.4-2.1-6.2-6.5-6.5 4.4-.3 6.2-2.1 6.5-6.5Z" strokeLinejoin="round" /><path d="M18.6 15.7c.1 1.8.9 2.6 2.7 2.7-1.8.1-2.6.9-2.7 2.7-.1-1.8-.9-2.6-2.7-2.7 1.8-.1 2.6-.9 2.7-2.7Z" strokeLinejoin="round" /></svg>;
  if (name === "arrow") return <svg viewBox="0 0 24 24" fill="none"><path d="M5 12h13M13 7l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "check") return <svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.2 4L19 7" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "edit") return <svg viewBox="0 0 24 24" fill="none"><path d="m6.2 16.9 1-3.6L16.4 4l3.6 3.6-9.3 9.3-4.5 1.2ZM14.4 6l3.6 3.6M5 20h14" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "image") return <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="4" width="16" height="16" rx="2.4" /><circle cx="9" cy="9" r="1.3" /><path d="m5.5 17 4.2-4.1 3 2.6 2.1-2.1 3.7 3.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  if (name === "calendar") return <svg viewBox="0 0 24 24" fill="none"><rect x="4" y="5.2" width="16" height="14.2" rx="2.5" /><path d="M7.6 3.7v3M16.4 3.7v3M4 9.3h16M8 12.7h.01M12 12.7h.01M16 12.7h.01" strokeLinecap="round" /></svg>;
  if (name === "send") return <svg viewBox="0 0 24 24" fill="none"><path d="m4 11.7 15.7-7.1-5.6 15.1-3.1-5.1-5.1-2.9Z" strokeLinejoin="round" /><path d="m10.8 14.5 3.6-3.8" strokeLinecap="round" /></svg>;
  if (name === "layers") return <svg viewBox="0 0 24 24" fill="none"><path d="m12 4 8 4.2-8 4.2L4 8.2 12 4Zm-8 8 8 4.2 8-4.2M4 15.8l8 4.2 8-4.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg viewBox="0 0 24 24" fill="none"><path d="M5 12a7 7 0 1 0 2-4.9M5 4.8v4.6h4.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
