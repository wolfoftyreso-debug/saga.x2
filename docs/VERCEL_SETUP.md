# Vercel: enklaste seriösa driftsättning

Brief körs som en Vercel-first produkt. Det betyder ingen Supabase:

```text
Vercel
  ├─ Next.js, API-rutter och Cron
  ├─ Neon via Vercel Marketplace — transaktionell data och arbetsytor
  ├─ Vercel Blob — privat originalmedia
  ├─ Sign in with Vercel — användaridentitet
  └─ AI Gateway — AI-anrop och observability
```

Neon är en Vercel Marketplace Native Integration: den kopplas, konfigureras
och faktureras från Vercel-projektet. Vercel har inte längre en egen
förstapartsversion av Postgres, så en Blob-fil är inte ett seriöst alternativ
för automationer, kalender eller research-leases.

## Få riktiga utkast att fungera först

SAGA använder ingen lokal demodatabas och faller aldrig tillbaka till
Supabase. Ett vanligt textutkast kan därför sparas först när dessa fyra steg är
klara, i denna ordning:

1. Anslut **Neon** via Vercel Marketplace så att `DATABASE_URL` finns i den
   aktuella miljön.
2. För en ny databas: kör **samtliga aktuella** filer i `db/migrations/` i
   namnordning mot just den Neon-databasen, innan första inloggningen eller
   första sparningen. För en befintlig databas: säkerhetskopiera först och kör
   endast ännu inte tillämpade migrationer. Återkör inte gamla migrationer.
3. Konfigurera **Sign in with Vercel** och logga in. Första inloggningen
   skapar användaren och den privata arbetsytan där utkastet sparas.
4. Slutför varumärkesonboardingen och välj varumärket när utkastet skapas.
   Valet verifieras av servern och låses på det sparade utkastet. En tom
   arbetsyta eller en ofärdig onboarding ger inte rätt att starta AI-jobb.

`BLOB_READ_WRITE_TOKEN` behövs först när ett utkast får en fil. `CRON_SECRET`
behövs först för schemalagda körningar. För den aktuella Production-versionen
behövs en dedikerad, budgeterad `AI_GATEWAY_API_KEY` för verkliga AI-anrop;
den ligger endast server-side i Vercel. Vercel OIDC är nästa steg efter en
runtime-smoke enligt `docs/SAGA_AI_GATEWAY_RUNBOOK.md`, inte en anledning att
lägga in en direkt modellnyckel. Ingen av dem ska användas som ersättning för
Neon eller inloggning.

## En gång i Vercel

1. Importera Git-repot och välj **Next.js**. Build command är `npm run build`.
2. Under **Storage → Browse Marketplace**, anslut **Neon** till projektet.
   Vercel lägger in `DATABASE_URL` automatiskt.
3. Skapa en **private Vercel Blob store** och koppla den till projektet.
   Vercel lägger in `BLOB_READ_WRITE_TOKEN` automatiskt.
4. I **Team Settings → Apps**, skapa en **Sign in with Vercel**-app.
   Aktivera `openid`, `email`, `profile` och `offline_access`. Lägg in:

   ```text
   https://din-domän/api/auth/callback
   ```

   som callback. Lägg motsvarande localhost-URL i appen för lokal utveckling.
5. Under **Project → Settings → Environment Variables**, lägg in:

   ```text
   NEXT_PUBLIC_VERCEL_APP_CLIENT_ID=<från Sign in with Vercel>
   VERCEL_APP_CLIENT_SECRET=<från Sign in with Vercel>
   CRON_SECRET=<slumpmässig hemlighet, minst 16 tecken>
   ```

   Om Guardian Open Platform uttryckligen är licensierad för den aktuella
   kommersiella/AI-drivna användningen lägger du dessutom in **båda**:

   ```text
   GUARDIAN_OPEN_PLATFORM_API_KEY=<server-only Guardian-nyckel>
   SAGA_NEWS_GUARDIAN_COMMERCIAL_LICENSED=true
   ```

   Utan den dokumenterade licensen ska ingen av dessa variabler sättas och
   Guardian-connectorn förblir avstängd. De får aldrig använda
   `NEXT_PUBLIC_`-prefix.

   Lägg dessutom in en **separat, budgeterad** `AI_GATEWAY_API_KEY` i
   Production för den första releasen, och en annan låg-budgetnyckel i
   `.env.local` vid lokal AI-utveckling. Lämna Preview utan verklig AI tills
   den behöver en egen testnyckel. Sätt aldrig en `OPENAI_API_KEY` som genväg
   för Studio. Function-runtime OIDC-bron är implementerad och testad mot
   request-kontext, men Production får använda Vercels kortlivade OIDC först
   när den live-smoke som beskrivs i `docs/SAGA_AI_GATEWAY_RUNBOOK.md` har
   passerat.
6. Deploya till Production och öppna `/settings`. Där ska du se en konkret
   Vercel-checklista, aldrig ett formulär som ber om hemligheter.

## Preflight före deploy

Koden har en lokal kontroll för Vercel-konfigurationen. Den läser miljön men
skriver aldrig ut ett hemlighetsvärde och anropar varken Neon,
Blob, AI Gateway eller en extern kanal.

`check:vercel` använder Next.js egen `@next/env`-laddare. Befintliga
processvariabler har företräde, följt av `.env.production.local`, `.env.local`,
`.env.production` och `.env`. `production` är standard; ett uttryckligt
`NODE_ENV=development` eller `NODE_ENV=test` följer Next.js motsvarande
laddningsordning. Testläget läser inte `.env.local`. Den statiska kontrollen
läser inga miljöfiler. Ett laddningsfel stoppar kontrollen utan att skriva ut
filinnehåll eller felobjekt som kan innehålla hemligheter.

```bash
# Kan köras i ett rent checkout och ska alltid vara grön.
npm run check:vercel:static

# Körs i den miljö som faktiskt ska deployas. Den stoppar vid saknad Neon,
# Blob, Vercel-inloggning eller Cron-hemlighet.
npm run check:vercel

npm run lint
npm test
npm run build
```

`check:vercel` redovisar bara variabelnamn och säker konfigurationsform, aldrig
nycklar eller databasadresser. Den ser att en Gateway-credential finns, men är
inte ett bevis på att OIDC fungerar inne i en Function-request. Koden läser nu
den betrodda runtime-tokenen via `@vercel/oidc`; behåll ändå en dedikerad
Production-nyckel tills runtime OIDC-smoken i
`docs/SAGA_AI_GATEWAY_RUNBOOK.md` är grön. För lokal provkörning av verklig
AI-generering behövs en separat `AI_GATEWAY_API_KEY` i `.env.local`.

Om du provar den produktionslika fail-closed-grinden lokalt kan du tillfälligt
sätta `VERCEL_ONLY=1`. Vercel sätter `VERCEL` själv; lägg inte in den variabeln
manuellt i Production.

## Vad som är klart i Vercel-läget

| Del | Status i Vercel/Neon |
| --- | --- |
| Studio-kärna | Klar: arbetsytor, sessioner, utkast, mallar, automationer, kalender och jobb. |
| Media | Klar som privat granskningskedja: uppladdning och säker läsning via appen, plus en separat AI Gateway → private Blob → Neon-kvitto-worker för kvalitetspassade automationsutkast. Huvudcron skriver bara kvitton; en dedikerad Cron kör högst en bildlease åt gången. Ingen del publicerar eller skapar en publik Blob-adress. |
| Sociala konton | Klar: Meta/Instagram Professional och LinkedIn kan anslutas via OAuth när leverantörsvariablerna är satta. Token stannar server-side i Neon. |
| Social publicering | Endast en server-side, manuell publiceringsseam med revisionskvitto finns. Den har ingen publik API-rutt, ingen Studio-knapp och körs aldrig automatiskt av Cron. |
| Nyhetsbrevsmålgrupper | Klar: skapa, ändra och ta bort listor samt kontakter i arbetsytan. Prenumeranter kräver dokumenterat samtycke. |
| Nyhetsbrevsutskick | Medvetet avstängt: ingen e-postleverantör, leveranskö eller avregistreringsväg körs i Vercel-läget ännu. |
| Content Engine | Klar som Vercel/Neon-kontrollplan: varumärkesprofiler, tillåtna referenskällor, AI Gateway-modellpolicyer, innehållsrecept och destinationsregler. Den konfigurerar alltid innan den levererar. |
| SAGA Editorial Lens | Klar som en arbetsyteskopad redaktionell doktrin ovanpå Content Engine: uppdrag, målgrupp, teman, ton, beläggskrav och granskningsläge. Den skapar eller levererar inget innehåll själv. |
| Brief, RSS/API och Media Engine | Äldre Supabase-funktioner. De är inte aktiva i en ren Vercel-installation. |

## Schema och media

Neon-databasen får appens egna migrationer under `db/migrations/`. Kör dem i
namnordning från Neon-integreringens SQL-editor eller med den migrationsrutin
som projektet dokumenterar. De gamla filerna under `supabase/migrations/` är
inte kompatibla rakt av: de innehåller Supabase Auth, RLS, Storage och
service-role-specifika delar.

Klonen innehåller en checksumstyrd migrationsrunner med projektskydd och
transaktionell ledger. Följ [konfiguration av klonen](./CLONE_SETUP.md) och
lås runnern till ditt verifierade projekt före användning. Blanda inte manuella
SQL-editor-körningar med runnern. En okänd befintlig databas får inte automatiskt
märkas som migrerad.

Den Vercel-klara Studio-kärnan — arbetsytor, sessioner, utkast, mallar,
automationer, kalender, körningar och mediametadata — ligger i Neon. Vercel
Blob används enbart för bild-, video- och dokumentfiler. Originalmedia är
privat och skickas tillbaka till webbläsaren via en arbetsyteauktoriserad
app-rutt; Blob-URL:er exponeras inte som fria tillgångar.

Kör migrationerna i den här ordningen:

1. `202608230001_neon_studio_core.sql`
2. `202608230002_neon_studio_job_receipts.sql`
3. `202608230003_neon_social_connections.sql`
4. `202608230004_neon_newsletter_audiences.sql`
5. `202608230005_neon_social_publish_attempts.sql`
6. `202608240006_neon_content_engine.sql`
7. `202608240007_neon_saga_editorial_lens.sql`
8. `202608240008_neon_saga_news_core.sql`
9. `202608250009_neon_ad_automations.sql`
10. `202608250010_neon_ad_automation_scheduler.sql`
11. `202608250011_neon_ad_automation_scheduler_upgrade.sql`
12. `202608250012_neon_ad_automation_create_idempotency.sql`
13. `202608250013_neon_ad_automation_scheduler_cursor.sql`
14. `202608250014_neon_saga_signal_production.sql`
15. `202608250015_neon_saga_avatar_references.sql`
16. `202608250016_neon_saga_series_references.sql`
17. `202608250017_neon_saga_automation_media_jobs.sql`
18. `202608260018_neon_saga_persona_context.sql`
19. `202608260019_neon_saga_persona_sensitive_storage_consent.sql`
20. `202608260020_neon_saga_outgoing_content_apis.sql`
21. `202608260021_neon_saga_ad_creative_projects.sql`
22. `202608260022_neon_saga_brand_onboarding.sql`
23. `202608260023_neon_saga_quarterly_activity_plans.sql`
24. `202608260024_neon_saga_daily_knowledge.sql`
25. `202608260025_neon_saga_adobe_authoring_runs.sql`
26. `202608260026_neon_saga_adobe_authoring_generation_commands.sql`
27. `202608280027_neon_saga_cron_tick_lease.sql`
28. `202609080028_neon_saga_authoring_brand_scope.sql`
29. `202609080029_neon_saga_knowledge_brand_scope.sql`
30. `202609080030_neon_studio_automation_brand_scope.sql`
31. `202609080031_neon_saga_authoring_runtime_repairs.sql`
32. `202609090032_neon_grok_gateway_namespace.sql`

Migration 005 stöder bara den interna, manuella sociala
publiceringsseamen. Migration 006 lägger till Content Engines egna profiler,
källor, recept, modellpolicyer och destinationsregler. Migration 007 lägger
till en enda redaktionell Lens per arbetsyta och återanvänder 006:s profiler
och tillåtna källor i stället för att kopiera dem. Migration 008 lägger till
SAGA News Cores workspace-skopade källor, begränsade hämtningskvitton,
fingerprintad provenance, signalbevis och korta Cron-leases i Neon.
Migrationerna 009–013 lägger till den idempotenta, köade annonsautomationen;
014 kopplar kvalificerade signaler till privata produktionsutkast; 015 lägger
till privata avatarreferenser; 016 lägger till SAGA Series frysta
referensinlägg och revisionshistorik; 017 lägger till den separata,
idempotenta privata mediekön för kvalitetspassade automationsutkast; 018
lägger till en ägar-skopad, privat, självbeskriven närvaroprofil med
revisionshistorik; och 019 kräver en uttrycklig ägarbekräftelse per revision
som innehåller politiskt/religiöst innehåll, ursprung eller födelseland. Ingen
av migrationerna aktiverar en publiceringsrutt eller automatisk publicering.
Migration 020 lägger till ägaradministrerade, hashade och återkallningsbara
**Utgående innehålls-API**-utgåvor. De kan bara läsas med en Bearer-hemlighet
i HTTP-huvudet och exporterar en fast, mediafri projektion av publicerat eller
uttryckligen publiceringsklart Studio-innehåll. De är inte webhooks, skickar
inget utåt och exponerar aldrig Blob-adresser, prompts, metadata eller privata
briefar.
Migration 021 lägger till **Annonsstudio**: privata, revisionsskyddade
masterbriefar och formatvarianter för sociala medier, Google, e-post,
postutskick, tidningsmoduler, affischer och egna mått. Den lagrar inget
annonskonto, ingen budget, ingen Blob-adress och ingen publiceringsinstruktion.
Ett format är alltid arbetsmaterial tills dess att den aktuella kanalen,
tryckeriet eller mediet har kontrollerats separat.
Migration 023 lägger till den privata, revisionsstyrda kvartalsplaneringen
som endast materialiserar granskningsbara Studio-utkast. Migration 024 lägger
till **SAGA Daily Knowledge**: ett uttryckligt opt-in, arbetsyteskopplat och
metadata-only kunskapsunderlag från godkända News Core-källor. Den körs med
Neon-leases via Vercel Cron, har ingen modell-, utkast-, media- eller
publiceringsväg och gallrar underlag enligt arbetsytans sparade retention.
Migration 025 lägger till **SAGA Adobe-simple authoring**: en sparad
referensversion kan bli högst tio privata, oföränderliga textkandidater efter
en serverägd Gateway- och kvalitetskontroll. Migration 026 lägger till
kommando-leaser och idempotensnycklar för varje uttrycklig produktionsslice,
så att en dubbelklickning eller förlorad HTTP-respons inte kan skapa nästa
kandidat. GET och Cron kan aldrig fortsätta den kedjan; användaren gör det
uttryckligen från den privata arbetsytan. Ingen av dem schemalägger,
publicerar eller levererar något.
Migration 027 lägger till en enda, processvid **SAGA Cron-tick-lease** i
Neon. Den förhindrar att överlappande minutkörningar startar samma sju
workers, är token-fencad vid avslut och sparar endast aggregerad tids- och
kapacitetsstatus. Den innehåller inga prompts, källor, draft-id:n eller
personuppgifter.
Migration 029 ger varje varumärke en egen kunskapspolicy och avgränsar dess
körningar och underlag via policyn. Den gamla arbetsytepolicyn kopplas bara
automatiskt när arbetsytan har exakt en varumärkesprofil totalt och den är
aktiv med slutförd onboarding. Tvetydiga äldre policyer och deras historik
bevaras, men pausas och används inte av AI eller Cron. Skapa då en uttrycklig
policy för varje valt varumärke; äldre underlag flyttas aldrig mellan märken.
Efter uppgraderingen går en policys varumärke inte att byta. Kör migrationerna
innan den här kodversionen tas i drift — saknat schema ska ge ett tydligt fel,
inte en delad eller lokal reservpolicy.
Migration 030 låser vanliga Studio-automationer till ett verifierat varumärke.
Varje jobb är bundet till sin oföränderliga automation, och AI hämtar profilen
från den kopplingen. Äldre automationer får bara en automatisk koppling i
arbetsytor med exakt en färdigställd, aktiv varumärkesprofil totalt; övriga
bevaras pausade och deras väntande jobb avbryts. Skapa en ny automation under
rätt varumärke i dessa fall. Även manuella körningar kontrollerar varumärke
och aktuell jobbtoken i samma skrivning som skapar det privata utkastet.
Nyhetsbrevsmålgrupper och kontakter är däremot en fungerande Neon-adapter.
Utskick, leveranskvitton och avregistrering är medvetet avstängda tills de har en egen Vercel-ägd
leveransadapter.

### Privat närvaroprofil

Den privata närvaroprofilen under `/studio/avatar` kräver **både migration 018
och 019**, i den ordningen, samt en inloggad arbetsyteägare. Den använder aldrig
en lokal fallback eller en Supabase-tabell. Politiskt/religiöst innehåll,
ursprung och födelseland kan bara lagras när ägaren för varje sådan sparning
bekräftar den privata lagringen. Bekräftelsen blir ett tidsstämplat,
revisionsbundet Neon-kvitto och används inte av AI, Cron eller publicering.
Rensa profilen via dess explicita raderingsval: det tar bort hela
revisionshistoriken och dessa kvitton via databasens cascade, medan privata
bildreferenser ligger kvar tills de tas bort i sin egen vy.

Filerna under `supabase/`, gamla Brief-/RSS/API-rutter och den äldre
researchmotorn är inte en del av Vercel-läget. Sätt inte Supabase-variabler
för att försöka återaktivera dem: när `DATABASE_URL` finns ska Vercel-rutter
använda Neon eller svara tydligt att funktionen saknas.

### Utgående innehålls-API

Under `/settings/api` skapar arbetsytans ägare en **API-utgåva**. SAGA visar
dess Bearer-hemlighet en enda gång vid skapande eller explicit rotation. Spara
den i mottagarens secret manager — den kan inte hämtas igen från SAGA.

```text
GET /api/saga/outgoing-content?limit=10
Authorization: Bearer saga_out_live_…
```

Hemligheten får aldrig läggas i URL:en, ett webhook-mål eller klientkod.
Endast `limit` (1–10) och den tidigare returens `cursor` är tillåtna
query-parametrar. Svaret är `no-store`, har ingen wildcard-CORS och innehåller
aldrig originalmedia, Blob-URL:er/-paths, källunderlag, intern metadata eller
genereringsprompter. `published_only` är standard; `publication_ready` omfattar
enbart godkända, schemalagda eller redan publicerade poster — aldrig utkast,
granskning eller privata låsta briefar. En återkallelse slår igenom direkt;
slutna API-utgåvor kan inte återupplivas med samma hemlighet.

## Content Engine: företagsplugin utan hemligheter

`/api/content-engine` är en privat, Vercel/Neon-skopad kontrollplan för
företagets återanvändbara innehållsmotor. `GET` returnerar hela den inloggade
arbetsytans konfiguration. `POST` skapar eller upprepar säkert en resurs med
dess workspace-lokala `slug`; `PATCH` ersätter en bestämd resurs och `DELETE`
tar bort en bestämd resurs. Alla skrivningar härleder användare och arbetsyta
från den signerade sessionen. API:t accepterar aldrig `workspaceId` från
webbläsaren.

Konfigurationen omfattar:

- varumärkesprofil och skrivsätt, inklusive egna exempel och ord att undvika;
- tillåtna källor för research, inspiration, fakta eller stil;
- provider-kvalificerade AI Gateway-modeller och en ordnad fallbackpolicy;
- recept som kopplar ihop profil, källor, modellpolicy och bild-/layoutinstruktion;
- destinations- och distributionsregler.

API-nycklar, access-token, lösenord och andra credential-fält avvisas både i
applikationen och av Neon-schemat. Model-ID:n måste vara provider-kvalificerade
(till exempel `anthropic/...` eller `openai/...`), så en policy kan aldrig
skicka ett godtyckligt modellnamn till AI Gateway. En social destination kräver
ett aktivt, verifierat OAuth-konto i samma arbetsyta. En
nyhetsbrevsdestination kräver en aktiv mottagarlista. RSS- och
webbplatsdestinationer är endast konfiguration tills en separat,
Vercel-ägd leveransadapter finns; de får en säker intern route eller HTTPS-mål
men kan inte få en hemlighet från gränssnittet.

### SAGA Editorial Lens: doktrin före generering

`/api/content-engine/editorial-lens` är en separat, privat Vercel/Neon-rutt
för en komplett redaktionell doktrin per arbetsyta. `GET` returnerar Lens eller
`null`; `PUT` (och dess fullständiga `PATCH`-variant) ersätter hela
konfigurationen och `DELETE` återställer den. Endast arbetsytans ägare får
skriva. Klienten kan aldrig välja `workspaceId`.

Lens komponerar med Content Engine genom ett valfritt länkat varumärkesprofil-id
och en prioriterad lista av redan tillåtna, aktiva källor. Den lagrar uppdrag,
strategiskt perspektiv, bransch, målgrupp, teman och förbjudna teman samt
strukturerade regler för ton, textkonstruktion, belägg och kontrolläge.
`strict` kräver tillåtna källor och synliga belägg. Den innehåller inga
modellnycklar, OAuth-token eller leveransinställningar och anropar inga modeller
eller externa kanaler på egen hand.

### AI-labb: jämför innan något sparas

`POST /api/content/ai-lab/generate` är en separat provbänk. Den läser bara
det valda, arbetsyteskopade Content Engine-receptet, dess tillåtna
referensunderlag och skrivpersonan. Den kan jämföra två eller tre av
OpenAI, Claude, Gemini och Grok via Vercel AI Gateway. Det exakta
provider-kvalificerade modell-ID:t kommer enbart från Vercel-miljövariabler;
webbläsaren kan aldrig skicka ett godtyckligt modellnamn eller en modellnyckel.

Varje svar är märkt som ett temporärt test (`saved: false`,
`publishable: false`). Testet skriver inte till Neon eller Blob, lägger inte
något i kalendern och kan inte skicka eller publicera. Lokalt används
`AI_GATEWAY_API_KEY`. För den aktuella Production-releasen används en
dedikerad, budgeterad servernyckel; efter den dokumenterade runtime OIDC-smoken
kan den ersättas av Vercels kortlivade OIDC-token.

## Automationer

Vercel Cron är en väckarklocka, inte databasen. Den enda schemalagda rutten,
`/api/cron/tick`, läser förfallna Studio-jobb ur Neon, claima dem atomiskt och
skapar privata AI-utkast med beständiga kvitton. Den anropar aldrig en social
plattform, skickar aldrig ett nyhetsbrev och faller aldrig tillbaka till
Supabase. Långa flöden som research → utkast → granskning → publicering ska
köras via Vercel Workflow när den delen är inkopplad.

Välj **Vercel Pro** för minutprecision. Hobby kör cron högst en gång per dag
och kan förskjuta jobbet upp till 59 minuter. Cron kör endast på Production och
Vercel skickar `Authorization: Bearer $CRON_SECRET` till varje cron-rutt.

## Externa kanaler

Meta- och LinkedIn-konton kan anslutas via den Vercel/Neon-skopade OAuth-vägen
när respektive leverantör är konfigurerad. Studio visar aldrig en död knapp:
utan giltig leverantörskonfiguration visas de exakta saknade variabelnamnen.
En intern server-side publiceringsseam finns för ett uttryckligt, godkänt
textutkast och sparar ett idempotent revisionskvitto före provideranropet. Den
har ännu ingen publik API-rutt, Studio-kontroll eller Cron-anrop. Vercel Blob
är privat, så bildpublicering är också spärrad tills en säker
publiceringsvariant finns.

Nyhetsbrevsmålgrupper och kontakter hanteras i Neon, men Resend eller annan
e-postleverantör är inte inkopplad i Vercel-läget. Status, leveranshistorik,
retry och avregistreringslänkar svarar därför tydligt att leverans saknas i
stället för att använda gamla Supabase-tabeller. Alla serverhemligheter ligger
i Vercel som Production-variabler, får aldrig prefixet `NEXT_PUBLIC_` och
visas aldrig i Studio.

## Kontroll efter deploy

1. Öppna `https://din-domän/api/health`. Den ska svara `200` med
   `database: "ready"`; den visar aldrig en databasadress eller hemlighet.
2. Logga in med Vercel. Första inloggningen ska skapa en privat arbetsyta.
3. I Studio: skapa ett utkast, spara det, lägg till en bild och välj en tid i
   framtiden. Bilden ska gå till privat Blob och sedan visas genom appens
   auktoriserade asset-route — aldrig via en fri Blob-URL.
4. Öppna `/studio/calendar`. Det sparade inlägget ska synas på rätt dag och
   klockslag med thumbnail. Flytta det via kalendern och kontrollera att ny
   tid står kvar efter omladdning. Ett ej godkänt eller publicerat utkast ska
   inte kunna rundas via drag-and-drop.
5. I AI-labbet: kör en temporär modelljämförelse. Resultatet ska vara märkt som
   osparat och får varken hamna i kalendern, skickas eller publiceras.
6. Kontrollera Cron i Vercel Logs efter en minut. Den får bara skapa privata
   utkast och research-underlag; den får aldrig publicera socialt eller skicka
   nyhetsbrev.
7. Nyhetsbrevskortet ska tydligt säga att leverans saknas. Det ska inte gå att
   skicka eller avregistrera via en äldre väg.

## Källor

- [Vercel Postgres / Marketplace](https://vercel.com/docs/postgres)
- [Neon på Vercel Marketplace](https://vercel.com/marketplace/neon)
- [Vercel Blob](https://vercel.com/docs/vercel-blob)
- [Sign in with Vercel](https://vercel.com/docs/sign-in-with-vercel/getting-started)
- [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
