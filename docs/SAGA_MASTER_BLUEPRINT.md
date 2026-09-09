# SAGA Master Blueprint v1

**SAGA — Scheduled Automated Generative Authoring**  
**Produktlöfte:** SAGA gör signal till berättelse, berättelse till innehåll och innehåll till styrd publicering.

SAGA är en multi-tenant editorial intelligence- och content orchestration-plattform. Den lyssnar på omvärlden, hittar robusta signaler, tolkar dem genom varje organisations mission och strategi, bygger redaktionellt och visuellt genomarbetat innehåll och gör publiceringen styrbar från ett ställe.

Det här dokumentet är den produkt- och implementationstekniska riktningen för SAGA. Det beskriver vad som måste vara sant i produkten, vilka befintliga byggstenar som används och i vilken ordning motorerna byggs färdiga.

## 1. Kärnkontrakt

SAGA ska aldrig vara en skrivyta som råkar ha automation. Den ska vara en kontrollerbar kedja:

```text
Källor → Signaler → Trovärdighet → Redaktionellt perspektiv → Innehåll
       → Bild och media → Kanal-QA → Godkänd publicering → Lärande
```

Varje pil representerar ett beständigt objekt med ägare, tidsstämpel, versionsnummer, underlag och tydligt nästa tillstånd. En användare ska kunna öppna ett planerat inlägg i kalendern och se:

1. varför ämnet valdes,
2. exakt vilka källor som stödjer det,
3. vilken mission, tonalitet och regelversion som styrde vinkeln,
4. vilka text- och bildvarianter som skapades,
5. vilket kvalitetstest som passerade eller inte passerade, och
6. vem eller vilken policy som godkände publiceringen.

### Den kanoniska innehållskedjan

| Objekt | Syfte | Får gå vidare när |
| --- | --- | --- |
| **Source item** | Ett inläst RSS-inlägg, API-resultat, dokument eller godkänt sökresultat. | Källan är aktiv, tillåten och normaliserad. |
| **Signal cluster** | Flera relaterade omnämnanden av samma substantiella händelse eller tema. | Minst två oberoende, seriösa bekräftelser uppfyller policyn. |
| **Evidence dossier** | Transparent faktaunderlag: vad som är känt, osäkert, motsägs och inte kan hävdas. | Beviskedjan och dess begränsningar är sparade. |
| **Editorial brief** | SAGA:s definierade "our take": relevans, vinkel, målgrupp och konstruktiva nästa steg. | Mission- och tonalitetskontrollerna är godkända. |
| **Content package** | Huvudtext, rubrik, CTA, citat, faktanoter och bildbrief. | Påståenden, struktur och läsbarhet klarar QC. |
| **Channel variant** | Kanaloptimerad version av samma budskap, exempelvis LinkedIn, Instagram eller nyhetsbrev. | Kanalens format-, media- och policykrav är uppfyllda. |
| **Release** | Ett planerat eller publicerat utfall med revisionskvitto. | Rätt kontrolläge, behörighet och destination är bekräftade. |
| **Learning event** | Utfalls- och redaktionell feedback kopplad till exakt version. | Mätning eller mänsklig feedback har registrerats. |

## 2. SAGA-doktrinen — icke förhandlingsbara regler

1. **Bevis före berättelse.** SAGA publicerar inte från en svag eller ensam signal. Standardregeln är minst två seriösa, oberoende källor från olika domäner. Ett undantag med en primärkälla får endast skapa ett utkast och kräver uttrycklig mänsklig granskning.
2. **Trovärdighet är förklarbar.** Varje signal visar antal omnämnanden, oberoende domäner, källtyp, källvikt, datum, motstridigheter och exakt varför den kvalade in.
3. **Mission före trend.** Ett ämne utan tydlig koppling till organisationens mission, strategi, målgrupp eller kompetens ska avvisas eller stanna som research — inte bli innehåll bara för att det trendar.
4. **Konstruktivt framför polemiskt.** SAGA ska vara seriös, kunnig, hoppfull, välformulerad och lösningsorienterad. Den får inte använda konflikt, cynism, rädsla eller sensation som genväg till räckvidd.
5. **Ingen falsk säkerhet.** Osäkerhet, begränsning och motstridiga underlag ska synas i dossiern och ska påverka både påståenden och godkännanden.
6. **Människan väljer autonomin.** Systemet får aldrig expandera från utkast till publicering av sig självt. Kontrolläge väljs per regel och per destination och kan när som helst sänkas eller pausas.
7. **Versionera allt som styr ett utfall.** Källa, policy, missionprofil, editorial lens, recept, modellpolicy, prompt, bildinstruktion, kanalregel och godkännande ska kunna spåras per release.
8. **Hårda workspace-gränser.** All data, alla mediaobjekt, alla OAuth-kopplingar, alla automatiseringar och varje revisionskvitto är workspace-skopade på servern. Klienten väljer aldrig arbetsyta genom ett fritt ID-fält.
9. **Sann status i gränssnittet.** En kanal, leveransadapter eller modell som inte är redo visas som otillgänglig med nästa faktiska steg — aldrig som en fungerande knapp.

## 3. Motorerna

| Motor | Ansvar | Viktig input → output | SAGA-regel |
| --- | --- | --- | --- |
| **A. Source Engine** | Hämtar och normaliserar godkända källor. | RSS/API/webbsökning/dokument → source items. | Källor kan tillåtas, viktas, begränsas eller blockeras per workspace. |
| **B. Signal Engine** | Deduplicerar, klustrar och prioriterar signaler. | Source items → signal clusters med momentum. | Liknande rubriker är inte bekräftelse; oberoende domäner räknas. |
| **C. Credibility Engine** | Bedömer bevisstyrka och stoppar svaga ämnen. | Cluster + policies → kvalificerad eller avvisad dossier. | Score är ett stöd; den hårda bekräftelsetröskeln kan inte rundas. |
| **D. Editorial Lens Engine** | Formar SAGA:s perspektiv utifrån mission, strategi, bransch och tonalitet. | Dossier + brand profile → editorial brief. | Perspektivet ska förklara konsekvens och möjlig handling, inte bara återberätta. |
| **E. Content Engine** | Skapar rubriker, strukturer, texter, CTA:er och varianter. | Editorial brief + recipe → content package. | AI-resultat är ett förslag tills det passerat QC och vald kontrollnivå. |
| **F. Media Engine** | Hittar, analyserar, anpassar och versionerar visuella tillgångar. | Bildbrief + egna filer/stockmaterial → kanalpassad media. | Stock först när lämpligt; AI förädlar, men får inte fabricera dokumentära fakta. |
| **G. Channel Adaptation Engine** | Gör ett budskap naturligt för varje destination. | Content package + destination → channel variants. | En destination innebär format-, längd-, tillgänglighets- och mediaregler automatiskt. |
| **H. Quality Control Engine** | Kontrollerar fakta, tonalitet, struktur, läsbarhet och channel fit. | Variant + dossier + policyversioner → QA report. | Ett misslyckat krav blockerar release och visar varför. |
| **I. Publishing Engine** | Schemalägger, godkänner, publicerar och sparar kvitton. | Godkänd variant → release receipt. | Idempotent, per destination och aldrig utan rätt behörighet. |
| **J. Learning Engine** | Lär av resultat och redaktionell feedback utan att skriva om varumärket i smyg. | Delivery/performance/feedback → rekommendationer. | Förändringar av policy eller tonalitet kräver mänsklig accept i V1. |

### Förklarbara signaler, inte magiska poäng

Varje cluster får ett tydligt signalblad. Följande dimensioner kan ge ett samlat prioriteringsvärde, men visas alltid separat:

- `source credibility` — viktning och kvalitet på varje källa;
- `mention count` och `independent domain count` — hur många oberoende bekräftelser som finns;
- `cross-source confirmation` — om centrala påståenden verkligen överlappar;
- `topical relevance` — matchning mot bevakade ämnen och målgrupper;
- `mission alignment` — om organisationen har ett legitimt perspektiv;
- `trend momentum` — acceleration över tid, inte bara volym;
- `channel suitability` — om det finns en rimlig, användbar kanalform.

Ett högt värde kan höja prioritet i kön. Det kan aldrig ensamt tillåta publicering.

## 4. Editorial Lens — SAGA:s "our take"

Onboardingen ska bygga ett redaktionellt minne som användaren kan läsa, ändra och stänga av. Den består av:

- mission och önskad förändring;
- erbjudande, branschlogik och kärnproblem som verksamheten löser;
- målgrupper, geografier och kunskapsnivå;
- återkommande teman, tillåtna vinklar och förbjudna ämnen;
- värderingar, konstruktivitet, optimismnivå och tonalitet;
- egna källor, referenser, exempeltexter och visuella preferenser;
- faktadensitet, citeringsgrad, formalitetsgrad och CTA-principer.

För varje kvalificerad signal ska Lens Engine skapa en kort, granskningsbar brief:

```text
Vad har hänt?
Vad är säkert och vad är ännu osäkert?
Varför spelar detta roll för vår målgrupp?
Vilket är vårt trovärdiga perspektiv?
Vilken konstruktiv insikt eller handling kan vi erbjuda?
Vilken kanal och vilket format passar bäst — och varför?
```

Detta är separationen mellan research och publicistik. SAGA får inte blanda ihop källornas faktapåståenden med organisationens tolkning.

## 5. Kontrollägen

| Läge | SAGA gör | Människan gör | Får publicera? |
| --- | --- | --- | --- |
| **Draft only** | Research, dossier och innehållsutkast. | Väljer om något ska användas. | Nej. |
| **Review mode** | Färdiga kanalvarianter med QA-rapport. | Godkänner varje release. | Endast efter individuellt godkännande. |
| **Scheduled approval** | Förbereder och lägger i kalenderns attestkö. | Godkänner före publiceringstid. | Nej utan attest. |
| **Guarded autopilot** | Schemalägger och kan publicera inom en strikt, förgodkänd regel. | Sätter ramar, kan pausa och får revisionsspår. | Ja, endast för specifika destinationsregler och fullt godkända QA-gates. |
| **Full autopilot** | Bevakar, producerar, QA:ar och publicerar inom en dokumenterad policy. | Äger policy, larm och undantag. | Ja, men aldrig för blockerade ämnen, osäker evidence eller nya destinations-/policyversioner. |

Default för en ny workspace är **Draft only**. Varje höjning av autonomi kräver att användaren aktivt väljer läge, destination och godkänd policyversion.

## 6. Vercel/Neon-referensarkitektur

SAGA körs Vercel-first. Neon är den transaktionella arbetsytedatabasen som ansluts genom Vercel Marketplace; Vercel Blob håller privata originalfiler; Vercel AI Gateway är den enda modellgatewayen.

```text
SAGA UI (Next.js)
  ├─ Kontrollplan: onboarding, källor, lens, recept, automationer, kalender
  ├─ Redaktionsyta: dossier → utkast → media → QA → release
  └─ Insyn: versionshistorik, körningar, kvitton och lärande

Vercel server routes / workflows
  ├─ autentiserar Vercel-session och härleder workspace
  ├─ läser/skriv Neon med workspace-skopade operationer
  ├─ anropar AI Gateway med serverägd modellpolicy
  ├─ läser privata Blob-objekt via auktoriserad app-rutt
  └─ anropar externa källor och kanaler via serverägda adapters

Vercel Cron
  └─ väcker små, idempotenta arbeten; den är inte jobbdatabasen

Neon
  ├─ konfiguration, signaler, dossiers, utkast och kanoniska versioner
  ├─ jobb, leases, retries, godkännanden och publish receipts
  └─ feedback och analyser per workspace

Vercel Blob
  └─ privata original, härledda kanalformat och versionsmetadata i Neon
```

### Datakontrakt

Det befintliga Studio-schemat täcker arbetsytor, mallar, utkast, automationer, jobb, media, kanalkopplingar, mottagarlistor och Content Engine-konfiguration. SAGA utökar det med en **signal ledger** i Neon, aldrig med temporär klientlagring:

```text
saga_source_policies       godkända/avvisade källor, vikt och ämnesregler
saga_source_items          normaliserade, deduplicerade inhämtningar
saga_signal_clusters       ämneskluster, styrka, status och tidsfönster
saga_evidence              källpåstående, ursprung, stöd/motsägelse och datum
saga_dossiers              vad som är känt, osäkert och otillåtet att hävda
saga_editorial_lenses      mission/strategi/ton och deras versionshistorik
saga_editorial_briefs      "our take", målgrupp och rekommenderad vinkel
saga_content_packages      kanonisk redaktionell huvudversion
saga_channel_variants      kanaltext, mediareferenser och tillgänglighetsfält
saga_quality_reports       gate-resultat och blockeringar
saga_release_requests      attest, schema, policy- och behörighetsbeslut
saga_release_receipts      idempotenta publiceringskvitton och providerutfall
saga_learning_events       utfall, feedback och accepterade rekommendationer
```

Alla rader har `workspace_id`, tidsstämplar och versions-/proveniensfält. Referenser mellan tabeller ska använda sammansatta workspace-FK:er så att data inte kan korsas mellan tenants. En release pekar alltid tillbaka till exakt variant, QA-rapport, dossier och policyversion.

### Säkerhet och drift

- Browsern får aldrig skicka ett fritt `workspaceId`, modell-ID med hemlighet eller provider-token.
- Alla hemligheter ligger i Vercels servermiljö och får aldrig ha `NEXT_PUBLIC_`-prefix.
- Originalmedia är privat i Blob; en publiceringsvariant skapas server-side och knyts till ett workspace- och release-ID.
- Källfetcher ska ha URL-validering, DNS/IP-skydd, timeout, storleksgräns och tillåten connector-typ.
- Cron/Workflow-arbete använder idempotensnyckel, lease, timeoutbudget, retryklassning och beständigt receipt.
- En extern publicering skrivs som `attempted` före provideranrop och avslutas med exakt providerresultat. Retry får aldrig skapa dubbelpost.
- Alla API- och RSS-utflöden blir workspace-skopade, läser endast uttryckligt publicerat material och använder återkallningsbara läsnycklar.

## 7. Befintliga byggstenar → SAGA-motorer

Det här är en ärlig karta över kodbasens byggstenar. Den visar vad som ska användas, vad som behöver förenas och vad som först måste få en Vercel/Neon-adapter innan det räknas som produktfunktion.

| SAGA-område | Befintliga routes/moduler | Användning i målbilden | Nästa konkreta steg |
| --- | --- | --- | --- |
| **Onboarding och mission** | `app/onboarding`, `components/profile-context-form.tsx`, `app/settings`, `components/product-settings-hub.tsx` | Skapar arbetsytans redaktionella grund i stället för generiska prompts. | Ersätt fria profilfält med versionerad Editorial Lens-form: mission, målgrupp, teman, gränser, tone of voice och visuella preferenser. |
| **Editorial Lens + modellpolicy** | `app/studio/engine`, `components/content-engine-workspace.tsx`, `app/api/content-engine`, `lib/domain/content-engine.ts`, `lib/neon/content-engine-repository.ts` | SAGA:s kontrollplan för brand profiles, källor, recept, destinationsregler och AI Gateway-policy. | Lägg till lens-version och explicit association från varje dossier/content package till profile, recipe och policyversion. |
| **AI-labb** | `app/api/content/ai-lab/generate`, `lib/services/ai-gateway-content-lab.ts` | Jämför temporära utkast från tillåtna Gateway-modeller innan något sparas. | Gör labbets val till en explicit "promote to content package"-handling med provenance, aldrig implicit sparning. |
| **Research- och signaldesign** | `app/studio/research`, `components/media-engine-workspace.tsx`, `lib/domain/media-engine.ts`, `lib/domain/media-engine-pipeline.ts`, `app/api/media-engine/*` | Innehåller bra koncept för tenants, RSS/API/webbsökning, oberoende domäner, clusters och dossiers. | Bygg om detta kontrakt mot Neon och Vercel-session innan det kopplas till Studio eller automation. Det ska vara en stödd SAGA-kedja, inte en separat sidoväg. |
| **Källpolicy** | `components/source-catalog.tsx`, `lib/domain/source-policy.ts`, Content Engine sources | Ursprung för allow/block, källklassning och verifieringsregler. | En enda policyresurs för Source + Credibility Engine; bind den till signaler och QA, inte bara konfigurering. |
| **Skapande, mallar och utkast** | `components/content-studio.tsx`, `app/studio/templates`, `app/api/content/templates`, `app/api/content/drafts/*` | Editor för huvudutkast, mallar, kalenderkort och kanalval. | Inför canonical content package och variants så ett tema kan redigeras centralt men formatanpassas per destination. |
| **Media** | `components/media-engine-workspace.tsx`, `app/api/content/drafts/[draftId]/media/*`, `app/api/content/media/[mediaId]/adapt`, `lib/vercel/blob-media.ts`, `lib/services/media-adaptation.ts` | Privat uppladdning, bildbrief och säkra kanalversioner. | Lägg till stock-sökadapter, asset provenance, alt-text, bild-QA och tydlig separation mellan original och AI-förädlad variant. |
| **Automation och kalender** | `app/studio/automations`, `app/studio/calendar`, `app/api/content/automations/*`, `app/api/content/calendar`, `lib/neon/studio-automation-worker.ts`, `app/api/cron/tick` | Hållbar kö för draft-generation, kalender och receipts. | Utöka jobbkedjan stegvis från `research → dossier → content package → review/release`; nuvarande automationsjobb fortsätter först skapa privata utkast. |
| **Kanaler och målgrupper** | `app/studio/channels`, `app/api/social/connections/*`, `app/api/content/newsletter-audiences/*`, `lib/neon/social-connections-repository.ts` | Verifierade destinationsobjekt för Meta, Instagram Professional, LinkedIn och nyhetsbrev. | Gör destinationens faktiska kapabiliteter synliga: text, bild, video, utkast, schemaläggning och publicering. |
| **Publicering** | `lib/neon/social-publisher.ts`, `db/migrations/202608230005_neon_social_publish_attempts.sql`, Studio automation receipts | Grund för idempotens och audit trail. | Bygg en separat Release Engine med explicit godkännande, kanalspecifika providers och retry. Ingen autopublicering förrän QA, media och receipt-kedjan är klar. |
| **Lärande** | `lib/domain/feedback-learning.ts`, `app/api/feedback` | Utgångspunkt för redaktionell feedback. | Lägg till release- och variantkopplade feedback events, effektmått samt ett rekommendationsflöde som kräver accept innan policy ändras. |
| **Externt läsflöde** | `app/api/v1/feed`, `app/api/v1/rss`, `app/api/v1/stream` | Målet är ett säkert publicerat SAGA-flöde, RSS och SSE. | Bygg workspace-skopade Neon-baserade read adapters först; exponera aldrig research, utkast eller privat media. |

## 8. UX: en enkel yta för en komplex motor

SAGA ska kännas som ett redaktionellt kontrollrum, inte som en samling tekniska konfigurationssidor. Huvudnavigeringen bör vara:

1. **Översikt** — vad väntar på beslut, vilka automationer arbetar och vad har publicerats.
2. **Signals** — källor, clusters, dossier och "varför nu?".
3. **Create** — editorial brief, content package, varianter och media i samma flöde.
4. **Calendar** — väntande, granskning, planerat, publicerat och misslyckat; varje kort öppnar det kompletta objektet.
5. **Automations** — visuellt regelbygge: trigger → gates → lens → format → media → destination → kontrolläge.
6. **Library** — röst, referenser, mallar, media och återanvändbara kampanjmönster.
7. **Settings** — arbetsyta, medlemmar, godkännanden, kanaler, API/RSS-läsnycklar och retention.

### Onboarding som skapar en användbar motor

En ny kund ska inte börja med en tom prompt. Den ska få ett kort flöde:

1. Beskriv verksamhet, mission och den positiva förändring ni vill driva.
2. Välj målgrupper, geografier, teman och sådant som aldrig ska bevakas.
3. Lägg till egna källor och välj vilka källkategorier som räknas som seriösa.
4. Välj editorial ton och ge 2–5 textexempel som definierar den.
5. Ladda upp media och välj visuell riktning.
6. Koppla destinationer och välj kontrollläge per destination.
7. Kör ett prov: signal → dossier → tre innehållsvarianter → ett valt kalenderutkast.

## 9. Fasad implementation — konkret byggordning

### P0 — Gör dagens Studio till en ärlig SAGA-grund

**Mål:** Inga återvändsgränder och ingen funktion som ser publicerbar ut innan den är det.

- Behåll Vercel/Neon Studio som beständigt hem för workspace, utkast, mallar, automationer, kalender och privat media.
- Se till att alla Studio-knappar leder till fungerande route eller visar en konkret, sann status.
- Behåll automationer som `draft-only` tills Release Engine finns.
- Synliggör i UI vilka modeller, kanaler, mediafunktioner och leveransfunktioner som faktiskt är aktiverade.

**Klart när:** ett team kan skapa, testa, spara, öppna, redigera och schemalägga ett privat utkast utan en död knapp eller teknisk setup-sida i arbetsflödet.

### P1 — Signal Ledger i Neon

**Mål:** En trovärdig research-loop som kan styras helt via UI.

- Lägg till migration och repository för `saga_source_policies`, `saga_source_items`, `saga_signal_clusters`, `saga_evidence` och `saga_dossiers`.
- Flytta Source/Signal/Credibility-kontraktet till workspace-skopade Neon-operationer.
- Bygg `/studio/research` som en riktig Signals-yta: källor, kvalitetsvikt, ämnen, trösklar, clusterdetalj och dossier.
- Behåll default: två oberoende domäner, två seriösa omnämnanden och manuellt godkännande av en-källsundantag.
- Implementera deterministisk deduplicering, idempotenta importer och tydlig avvisningsorsak.

**Klart när:** en användare kan lägga till en RSS- eller publik API-källa, köra en check, se en signal med förklarbar beviskedja och skapa ett privat editorial brief — men inte publicera.

### P2 — Editorial Lens och Content Package

**Mål:** SAGA producerar ett eget, transparent perspektiv i stället för att referera nyheter generiskt.

- Inför versionerad `editorial_lens` och `editorial_brief` kopplad till workspace, dossier, brand profile och recipe.
- Skapa Quality Control-regler för mission alignment, konstruktiv framing, påståendestöd, tonalitet, disposition och läsbarhet.
- Låt AI-labbet jämföra modeller via Gateway och kräva explicit val innan en variant blir beständig.
- Gör huvudutkastet till ett `content package` med kanalvarianter i stället för fristående, duplicerad text.

**Klart när:** användaren kan öppna ett dossier, se SAGA:s föreslagna vinkel med faktagränser, välja en AI-variant och granska en sparad provenance-kedja.

### P3 — Media och kanalintelligens

**Mål:** Varje innehållspaket blir visuellt och kanalredaktionellt rätt utan manuellt formatkaos.

- Lägg till godkänd stock-adapter, upload-analys och asset provenance.
- Skapa media-QA: motivmatchning, rätt bildförhållande, alt-text, text-säker zon, varumärkespassning och tydlig AI-förädlingshistorik.
- Implementera destination-regler för Facebook, Instagram, LinkedIn, nyhetsbrev och egen webb/RSS.
- Skapa varianter från ett kanoniskt content package, aldrig genom att försöka återställa text ur en publicerad kanalpost.

**Klart när:** en användare kan välja en destination och få en redigerbar, korrekt text- och bildvariant med vad SAGA har anpassat förklarat i UI.

### P4 — Governed Publishing

**Mål:** Publicering är lika pålitlig och spårbar som ett ekonomiskt arbetsflöde.

- Inför release request, approval, publish attempt, receipt och retry som egna Neon-objekt.
- Bygg per-provider adapters för sociala destinationer och en Vercel-ägd nyhetsbrevsleveransadapter med consent, unsubscribe, leveransstatus och retry.
- Låt Vercel Cron väcka begränsade jobb; använd Vercel Workflow för längre, återupptagbara flöden.
- Stöd `review`, `scheduled approval` och `guarded autopilot` först. Full autopilot kräver en separat policygranskning och larmbild.

**Klart när:** ett godkänt, schemalagt objekt kan publiceras exakt en gång, få ett revisionskvitto, återförsökas säkert och öppnas från kalendern med komplett historik.

### P5 — Learning och externa läsflöden

**Mål:** SAGA förbättrar nästa beslut utan att bli en svart låda.

- Spara variant- och releasekopplad redaktionell feedback, leveransresultat och aggregerade resultatmått.
- Visa rekommendationer som "den här typen av vinkel fungerar bättre för den här kanalen" med underlag och confidence — inte dolda autoändringar.
- Bygg workspace-skopade, återkallningsbara read-only API-, RSS- och SSE-flöden för **publicerat** material.
- Lägg till retention, export och revisionsvyer för enterprise-kunder.

**Klart när:** användaren kan se vilken policy- eller variantsignal som lett till en rekommendation och välja att acceptera eller avvisa den.

## 10. Definition of Done för varje ny SAGA-funktion

En ny motor, källa, AI-modell, kanal eller automation är inte klar förrän den har:

- en workspace-skopad datamodell och serverautorisering;
- tydliga UI-tillstånd för redo, väntar på underlag, blockerad och misslyckad;
- idempotens och beständig historik där jobbet kan skapa extern effekt;
- policy-, versions- och provenancekopplingar;
- testfall för otillåten cross-tenant access, saknad konfiguration och retry;
- ett mänskligt förklarbart svar på varför systemet gjorde eller inte gjorde något;
- ingen dold publiceringsväg och ingen tekniktext mitt i den kreativa arbetsytan.

## 11. Beslut som låser v1

- SAGA är **Vercel-first med Neon via Vercel Marketplace** för beständig data och Vercel Blob för privata mediaobjekt.
- Vercel AI Gateway är modellgateway; OpenAI, Claude, Gemini och Grok väljs av serverägda, versionerade modellpolicyer.
- Standardautomation skapar och förbereder säkra utkast. Publicering introduceras först med Release Engine och explicita kontrollägen.
- Första godkända researchkällor är RSS, publika API:er och kontrollerad webbsökning. Autentiserade tredjepartskällor kräver en senare, serverägd credential-broker.
- Första destinationer är Facebook-sida, Instagram Professional, LinkedIn, nyhetsbrev och en SAGA-ägd webb/RSS-adapter.

Med dessa beslut är SAGA enkel på ytan: användaren väljer vad organisationen står för, vad som är värt att bevaka och hur mycket kontroll som ska finnas kvar. Under ytan är varje steg förklarbart, versionerat och redo att styras.
