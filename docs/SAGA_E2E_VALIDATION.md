# SAGA: ärlig validering av automationskedjan

Senast kontrollerad: 2026-08-25

Det här dokumentet skiljer **kod som har körts lokalt med kontrollerade
beroenden** från en riktig körning mot Vercel, Neon, Blob, AI Gateway och
externa kanaler. En grön lokal testsvit är inte ett påstående om att en
extern publicering eller en deploy har utförts.

## Verifierad lokal kedja

| Led | Verifierat kontrakt | Testbevis | Resultat |
| --- | --- | --- | --- |
| Källhämtning | RSS/Atom, GDELT och den licensskyddade Guardian-adaptern normaliserar bara metadata, med SSRF-/DNS-/storleksgränser. | `tests/saga-news-core.test.ts` | Godkänd |
| Signal | Två aktuella, oberoende publisher-domäner med minst två substantiella överlappande termer krävs före signal. Signalen märks `qualified` och `requiresHumanReview`. | `tests/saga-news-runner.test.ts`, `tests/saga-news-cron-runner.test.ts` | Godkänd |
| News Cron | En claim → ett intake-kvitto → persist → signalreconciliation → slutförd lease. Fel registreras eller leaset släpps; en dubbelkörning återanvänder kvittot. | `tests/saga-news-cron-runner.test.ts`, `tests/saga-news-neon-core.test.ts` | Godkänd |
| Signal → granskningsutkast | Endast en uttryckligt aktiverad workspace-policy får materialisera en kvalificerad signal. En leased receipt går via kvalitetsgrind till högst ett privat `in_review`-utkast. Ändrad/pausad policy, inaktiverad signal eller gammal claim-token stoppar den sista draft-skrivningen. | `tests/saga-signal-production-worker.test.ts`, `tests/neon-saga-signal-production-repository.test.ts`, `tests/saga-signal-production-routes.test.ts` | Godkänd |
| Textproduktion | Ett leasat Studio-jobb går från en verifierad regel till ett strukturerat AI-utkast och ett privat Neon-draft. Det blir aldrig en publicering. | `tests/neon-studio-automation-worker.test.ts` | Godkänd |
| Produktionskvalitet | En fristående, deterministisk kvalitetsagent ger poäng och förklarbara findings för struktur, ton, belägg, läsbarhet, bildriktning och leverans. Blockerad kvalitet skapar inget utkast; varningar blir ett privat, oschemalagt granskningsutkast. | `tests/saga-production-quality.test.ts`, `tests/neon-studio-automation-worker.test.ts`, `tests/saga-signal-production-worker.test.ts` | Godkänd |
| Retry/falldown | AI-/infrastrukturfel blir retrybara med claim-token. Ogiltig automation blir ett terminalt fel. Stale lease kan inte skriva över en nyare ägare. | `tests/neon-studio-automation-worker.test.ts`, `tests/ad-automation-worker.test.ts` | Godkänd |
| Annonsautomation | Ett schemalagt annonsflöde skapar ett idempotent, leveranslåst privat kreativt underlag; det kan inte få kanal, tid eller publicering via generisk draft-API. | `tests/ad-automation-worker.test.ts`, `tests/neon-calendar-scheduling.test.ts` | Godkänd |
| Privat media | Bilduppladdning använder workspace-/draft-skopad privat Vercel Blob. En server-only Gateway → privat Blob-seam validerar bildbriefen före ett eventuellt modell-anrop och lämnar aldrig ut en Blob-URL. Kalendern får bara en same-origin asset-route. | `tests/vercel-blob-media.test.ts`, `tests/saga-media-generation.test.ts`, `tests/neon-calendar-scheduling.test.ts` | Godkänd (mockad Gateway/Blob) |
| Kalender | Ett explicit schemalagt utkast hamnar med lokal tid, thumbnail och revision. Flytt är atomisk och stoppar stale writes samt publicerade/låsta objekt. | `tests/neon-calendar-scheduling.test.ts` | Godkänd |
| Cron-grind | `/api/cron/tick` kräver Vercels `Bearer $CRON_SECRET`, returnerar `no-store`, fail-closed vid saknad Neon och markerar alla utfall `noPublication: true`. | `tests/vercel-cron-tick.test.ts` | Godkänd |
| Ingen dubblettpublicering | Den interna social-seamen kräver uttryckligt godkännande och idempotency-receipt. Den spärrar Blob-media och Instagram tills en säker publiceringsvariant finns. Cron anropar den inte. | `tests/neon-social-publisher.test.ts` | Godkänd |

Den kompletta lokala regressionen den 2026-08-25 passerade **86 testfiler och
466 tester**:

```bash
npm test
```

Den fokuserade automationskörningen omfattar bland annat:

```bash
npx vitest run \
  tests/vercel-cron-tick.test.ts \
  tests/saga-news-core.test.ts \
  tests/saga-news-runner.test.ts \
  tests/saga-news-cron-runner.test.ts \
  tests/saga-signal-production-worker.test.ts \
  tests/neon-saga-signal-production-repository.test.ts \
  tests/saga-signal-production-routes.test.ts \
  tests/saga-production-quality.test.ts \
  tests/neon-studio-automation-worker.test.ts \
  tests/neon-calendar-scheduling.test.ts \
  tests/ad-automation-worker.test.ts \
  tests/neon-social-publisher.test.ts \
  tests/vercel-blob-media.test.ts \
  tests/saga-media-generation.test.ts \
  tests/vercel-readiness-script.test.ts
```

## Vad `/api/cron/tick` gör i dag

`vercel.json` väcker `/api/cron/tick` varje minut. Den kör begränsat och
parallellt:

```text
Studio schedule receipts → privata textutkast
Annonsautomation receipts → privata, leveranslåsta kreativa briefs
Förfallna News-källor → metadata → evidensbaserade signals
Opt-in kvalificerade signals → kvalitetsgrind → privata `in_review`-utkast
```

Varje del har egna leases, tidsbudgetar och beständiga kvitton. Om Studio- eller
annonsarbetaren är otillgänglig svarar Cron `503` i stället för att hävda
framgång. Om News-delen misslyckas syns det som `completed_with_failures` och
`noPublication: true`; den kan inte leda till extern leverans.

## Viktig systemgräns: vad som nu är sammankopplat — och vad som inte är det

Det finns nu en beständig, opt-in `qualified signal → production receipt →
quality gate → private review draft`-handoff. Policyn saknas och är avstängd
som standard; den måste sparas och aktiveras per workspace via
`/api/saga/news/production-policy`. Varje signal har en workspace-skopad
unik receipt, kort lease, retrybudget och en slutlig SQL-grind som åter
kontrollerar policyrevision, signalstatus och claim-token före draft-skrivning.

Standarden är alltid ett **oschemalagt** `in_review`-utkast. En policy kan
uttryckligen välja kalenderplacering i framtiden, men den används bara när
kvalitetsagenten ger `approved`. `review_required` skapar fortfarande ett
privat utkast men lämnar det utanför kalendern. `blocked` skapar inget utkast.
Ingen av dessa vägar anropar AI, bildtjänst, Blob eller extern publicering.

Studio-automationer kan fortfarande skapa privata AI-utkast från sina egna
schemaregler. Signal-handoffen använder medvetet ett deterministiskt,
evidensmärkt redaktionellt underlag i V1, inte News-signalen som en direkt
modellprompt. En framtida opt-in AI-variant behöver samma kvalitet-, lease- och
slutskrivningsgrind; den är inte aktiverad här.

Bildledet har nu en server-only **Vercel AI Gateway → privat Blob**-seam som
kräver en beständig körning, ett ägt draft-scope och en godkänd Creative Safety-
brief. Den har kontraktstestats med mockad Gateway och Blob, men är ännu inte
kopplad till en beständig produktionsworker eller Studio-UI och har därför inte
körts mot en riktig Gateway/store i denna miljö. Det finns fortfarande ingen
stock-sökning, AI-förädling eller publik kanalvariant.

Produktionskvalitetsagenten är nu en blockerande gate mellan produktion och
draft-materialisering. Saknade belägg, opassande ton, bristande struktur eller
kanal-/bildbrister lämnar ett tydligt felkvitto och startar aldrig ett release-
eller publiceringsförsök. Den ersätter inte den mänskliga granskningsspärren.

## Deploy-status i denna arbetsmiljö

Den statiska Vercel-preflighten passerar:

```bash
npm run check:vercel:static
# Klar: 0 fel, 0 varningar.
```

En riktig deploy-provning kunde **inte** utföras i denna miljö. Följande saknas
här och får inte fabriceras eller ersättas med testvärden i Production:

- `DATABASE_URL` från Neon-integrationen
- `BLOB_READ_WRITE_TOKEN` från en privat Vercel Blob-store
- `NEXT_PUBLIC_VERCEL_APP_CLIENT_ID` och `VERCEL_APP_CLIENT_SECRET`
- `CRON_SECRET`
- Vercel-projekt/behörighet (`VERCEL_PROJECT_ID`/Vercel-token); Vercel CLI finns
  inte installerad i miljön
- en lokal `AI_GATEWAY_API_KEY` eller produktions-OIDC för ett verkligt AI-anrop

Den verkliga preflighten är därför korrekt röd med fyra konfigurationsfel
(Neon, Blob, Vercel-inloggning och Cron) samt en AI-Gateway-varning. Det är ett
förväntat fail-closed resultat, inte ett testfel.

## Produktionsprov efter att Vercel är anslutet

1. Anslut Neon via Vercel Marketplace och kör samtliga filer i
   `db/migrations/` i namnordning.
2. Anslut en **private** Blob-store, konfigurera Sign in with Vercel och sätt
   en slumpmässig `CRON_SECRET` på minst 16 tecken.
3. Sätt `AI_GATEWAY_API_KEY` lokalt eller använd Vercel OIDC i Production.
4. Kör i den faktiska target-miljön:

   ```bash
   npm run check:vercel
   npm run lint
   npm test
   npm run build
   ```

5. Deploya. Kontrollera `/api/health`, logga in, skapa ett manuellt draft,
   ladda upp en bild och verifiera att kalendern visar samma tid och thumbnail.
6. Spara först en avstängd signalproduktionspolicy, bekräfta att en kvalificerad
   signal inte skapar något, och aktivera den därefter i en icke-produktionsmiljö.
   Kontrollera efter en Cron-vakning att exakt ett privat `in_review`-utkast
   skapas med kvalitetssvar och källevidens. Pausa policyn mellan claim och
   materialisering och bekräfta att jobbet blir `cancelled`, inte ett draft.
7. Skapa en draft-only automation och kontrollera efter en Cron-vakning i
   Vercel Logs att endast ett privat draft/receipt skapades. Huvudcron ska
   därefter enbart skapa ett separat `media_generation`-kvitto; den dedikerade
   `/api/cron/media-generation`-körningen får claima högst en bild i taget.
   Bekräfta att den skapar en privat Blob-post med samma jobbkvitto och aldrig
   en publik URL eller publicering. Ändra utkastet mellan claim och bifogning:
   jobbet ska bli `cancelled` med `draft_revised`, inte bifoga en gammal bild.
   Sakna tillfälligt AI Gateway eller Blob i en icke-produktionsmiljö: jobbet
   ska få ett tydligt terminalt konfigurationsfel; ett tillfälligt Blob-fel ska
   bli retrybart och aldrig skapa en fejkad mediepost.
8. Slå inte på en extern kanal eller nyhetsbrev som ett test av Cron. Dagens
   Cron är uttryckligen draft-only.

För den fulla produktvisionen behövs därefter en opt-in AI-variant av
signalutkastet, release engine och en separat publiceringsadapter. De ska
byggas som beständiga Neon-jobb med idempotens, inte som en implicit sidokedja
i Cron.
