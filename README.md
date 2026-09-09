# saga.x2 — SAGA Studio

Källkodskopia av SAGA Studio med redigerare, kalender, AI-arbetsflöden,
migrationer och automatiska tester. Databasinnehåll, användarbilder, hemligheter
och den ursprungliga installationens driftrapporter ingår inte.
Läs [konfiguration av klonen](docs/CLONE_SETUP.md) innan du ansluter tjänster.

SAGA Studio är en mänskligt styrd AI-redaktion för varumärkens planering och produktion. Den verkliga produktkedjan är:

```text
Varumärke → årsram och budget → 13-veckorsplan → källunderlag och riktning
→ privata utkast → mänsklig granskning → tid i SAGA-kalendern
```

SAGA skapar och organiserar privata, redigerbara utkast. Den aktuella
Vercel/Neon-produkten publicerar inte automatiskt i sociala kanaler, skickar
inte nyhetsbrev och köper inte annonser. Det är en medveten kontrollgräns,
inte en funktion som saknas i gränssnittet.

> Det finns historisk kod för en personlig, konversationsbaserad Brief-produkt
> i repot. Den är inte SAGA Studios Vercel/Neon-produkt och ska inte användas
> som produktidentitet eller driftsätt. Den faktiska statusen står under
> [Driftsätt enkelt med Vercel](#driftsätt-enkelt-med-vercel) och
> [Studio: skapa och planera](#studio-skapa-och-planera).

## Historisk Brief-funktionalitet (inte Vercel-läget)

- Chat är startsidan. En materialiserad brief blir ett beständigt assistentmeddelande med kompakta händelsekort. När `only_when_changed` är på skapar en tyst körning varken en beständig brief eller en ny chattpost; chatten visar i stället att kontrollen är gjord och den lugna bedömningen.
- När modulen Världsläge är på har huvudbriefen en kort daglig lägesbild för värld/konflikt och säkerhet, ekonomi samt användarens kända exponering. Den publiceras också på en lugn dag, men bara när samtliga tre linser har komplett, källverifierat underlag; ett partiellt underlag kan aldrig se ut som ett lugnt all-clear. Specialbriefar behåller i V1 sitt vanliga `only_when_changed`-beteende och får ingen automatisk lägesbild.
- När Veckan hittills är på har huvudbriefen en kort del med högst fem redan verifierade förändringar från den aktuella veckan. Den återanvänder den sparade händelsen och källkedjan; den kan inte hitta på en ny veckonyhet.
- När Marknadsläge är på kan briefen visa en separat marknadsöversikt med OMXS30, S&P 500, Nasdaq Composite, STOXX Europe 600 samt USD/SEK och EUR/SEK. När Bolag du följer också är på visas Tesla, Alphabet och Investor AB separat när en verifierad kurs finns. SpaceX följs som bolag, men får aldrig en syntetisk kurs. Kurser hämtas server-side från en konfigurerad marknadsdatakälla, sparas med tidsstämpel och visas som senaste tillgängliga referens — aldrig som köp- eller säljsignal eller som en händelse i registret.
- När AI och affärslägen är på har huvudbriefen en källstyrkt strategisk radar: officiellt annonserade AI-modellfunktioner, konkreta affärslägen och relevanta konferenser, deadlines eller digitala sammanhang. Varje post säger vad som är verifierat, varför det berör dig och nästa konkreta steg. Rykten, investeringscase och generella trendspaningar faller bort.
- Briefar har egna uppdrag, frekvens, tid, tidszon, tröskel och leveranshistorik. Samma händelse kan därför rapporteras i exempelvis Teknik och Företag utan att den ena briefen tystar den andra.
- Bevakningar är sparade, explicita regler. Eventbundna och enkla ämnesbevakningar utvärderas efter verifierade registeruppdateringar och har en unik leveransnyckel, så en statusändring inte skickas två gånger.
- Direktnotiser är ett separat, retrybart leveransflöde. En post över briefens direktnotiströskel blir ett proaktivt chattmeddelande med en idempotent kvittens per användare och registeruppdatering — aldrig en extra notis vid cron-retry. De kan stängas av helt eller hållas under egna tysta timmar; ett systemiskt undantag kan valfritt släppas igenom.
- Varje händelse har dessutom en egen dialogtråd, så en följdfråga eller en statusstyrd bevakning stannar vid just den fråga den gäller.
- Källpolicyn är verklig: en blockerad domän tas bort både från Responses API:s tillåtna webbsökning och från den serverstyrda publiceringskedjan.
- Källor kan styras globalt eller per brief med aktiv/blockerad status, roll, prioritet, ämnesfilter, frekvens och verifieringskrav.
- `/settings` är en samlad kontrollcentral: briefdefinitioner, relevansprofil, moduler, trösklar, notisnivå, tysta timmar, globala/per-brief-källor samt skapande och pausning av bevakningar sparas som riktiga regler.
- `/settings` kan också skapa privata, återkallningsbara API-nycklar. De ger bara läsrätt till redan publicerade och källpolicyfiltrerade briefposter: JSON (`/api/v1/feed`), hela briefar (`/api/v1/briefs`), RSS (`/api/v1/rss`) och liveflöde via Server-Sent Events (`/api/v1/stream`). RSS- och SSE-länkar kan bära en nyckel i `?token=` eftersom många klienter saknar headerstöd; behandla därför länken som ett lösenord.
- Onboardingen skapar en synlig och redigerbar relevansprofil; den används som urvalsunderlag, inte som dolt samtalsminne. En snabbstart lägger till Tesla, SpaceX, Investor, Alphabet samt fokus på AI-roadmap, affärslägen och relevanta sammanhang.
- Alla Responses API-körningar använder `store: false`. Den Vercel-klara Studio-kärnan — arbetsytor, utkast, mallar, automationer, kalender och privata media — bor i Neon som är kopplat direkt till Vercel-projektet. Social OAuth-kontoanslutning samt mottagarlistor/kontakter med samtycke är också Neon-klara. Social publicering finns endast som en intern, manuell server-side seam utan route, UI eller Cron-anrop. Nyhetsbrevsutskick och avregistrering är medvetet avstängda. Äldre Brief-, RSS/API- och researchflöden är inte en del av en ren Vercel-installation.
- Marknadsdata hämtas aldrig i webbläsaren och modelleras aldrig av språkmodellen. En okänd, gammal eller misslyckad kurs visas som otillgänglig, inte som aktuell.

## Starta lokalt

1. Följ [Vercel-setupen](docs/VERCEL_SETUP.md): anslut Neon i Vercel Marketplace, skapa en privat Vercel Blob-store och skapa en Sign in with Vercel-app.
2. Kör migrationerna i `db/migrations/` mot den anslutna Neon-databasen.
3. Kopiera `.env.example` till `.env.local` och fyll i `DATABASE_URL`, Vercel-inloggning och AI-nyckel. `FMP_API_KEY` hör till den äldre Brief-marknadsöversikten och aktiverar inte den i en ren Vercel-installation.
4. Installera och starta:

   ```bash
   npm install
   npm run check:vercel:static
   npm run dev
   ```

5. Logga in via `/login`. Första inloggningen skapar din privata arbetsyta. Cron körs först efter deploy i Vercel.

## Driftsätt enkelt med Vercel

Kör allt från **Vercel**: Next.js, API-rutter, Cron, Neon-integrationen,
Blob-media, Vercel-inloggning och AI Gateway. Det enda externa datalagret är
Neon, som ansluts och administreras från Vercel Marketplace — inte Supabase.

Den konkreta checklistan finns i [docs/VERCEL_SETUP.md](docs/VERCEL_SETUP.md).
Den kräver Vercel Pro om du vill ha minutprecision för automationer. Hobby
räcker inte för förutsägbara körningar. Cron skapar bara privata
AI-utkast i Neon; den publicerar inte socialt och skickar inte nyhetsbrev.

Före deploy kör du `npm run check:vercel`. Den är en hemlighetsfri preflight
som verifierar Neon, privat Blob, Vercel-inloggning, Cron-skydd och att inga
Supabase-variabler har smugit sig in. Se
[Vercel-setupen](docs/VERCEL_SETUP.md#preflight-före-deploy) för den kompletta
produktionsproven.

## Externt API, RSS och liveflöde

API-nycklar, JSON-flöde, RSS och SSE hör fortfarande till den historiska
Supabase-baserade Brief-motorn. De är **inte aktiva i Vercel/Neon-läget** och
ska inte konfigureras eller exponeras där. En framtida Neon-adapter får lägga
till dem igen med workspace-skopad autentisering, men tills dess är det
korrekta svaret att funktionen saknas — inte att en gammal Supabase-rutt körs.

`/api/cron/tick` är Vercel-lägets enda schemalagda rutt och körs varje minut
enligt `vercel.json`. Den arbetar enbart med begränsade Neon-jobb: privata
utkast, SAGA News- och Daily Knowledge-kvitton, signalunderlag och privata
mediekvitton. En token-fencad Neon-lease tillåter bara en huvudkörning åt
gången; ett överlapp gör inget nytt arbete. Den kör inte den historiska
Brief-motorn, extern social publicering eller nyhetsbrev.

## Studio: skapa och planera

`/studio` är en separat arbetsyta för innehåll, inte ett generellt nyhetsflöde. Där kan du skapa utkast, välja mall, skriva eller låta AI skapa ett första förslag, lägga in egna bilder och välja kanal samt tid i SAGA-kalendern. Originalbilden sparas privat i Vercel Blob. AI-bildanpassning och publiceringsvarianter är inte klara i Vercel-läget, så de ska inte presenteras som färdiga.

- **Kalender:** `/studio/calendar` visar både utkast med en tid i SAGA och kommande automationsjobb. Klicka på en händelse för att läsa hela utkastet. **Redigera** öppnar text, bild, kanal och tid i samma vy. En tid i kalendern är inte ett leverans- eller publiceringskvitto.
- **Automationer:** `/studio/automations` skapar återkommande regler, till exempel tre Instagramutkast per vecka. En regel har veckodagar, lokal tid, ämnesprompt, ton, längd, bildriktning och om godkännande krävs. Den skapar ett sparat utkast vid nästa cron-vakning; den publicerar inte förbi godkännande.
- **Kanaler:** `/studio/channels` kopplar Facebook-sidor, Instagram Professional-konton och LinkedIn via OAuth. Personliga Facebook- eller Instagram-konton stöds inte. Anslutningen lagrar krypterade server-side-token; gränssnittet får aldrig tokenvärden. Att ett konto är anslutet betyder inte att Studio kan publicera ännu: den enda publiceraren är en intern, manuell server-side seam utan route, UI eller Cron-anrop.
- **Nyhetsbrev:** välj och hantera mottagarlistor på utkastet. Kontakter kräver dokumenterat samtycke och ligger workspace-skopat i Neon. Vercel-läget skickar dock inga brev, skapar inga leveranskvitton och har ingen aktiv avregistreringslänk förrän en separat Vercel-ägd leveransadapter är byggd.

I Vercel-installationen ligger Studio-data i Neon och filer i privat Blob.
Sociala kontoanslutningar använder en Vercel/Neon-skopad OAuth-väg; de
nedanstående variablerna aktiverar den vägen. Den interna publiceringsseamen
kräver dessutom ett uttryckligt, godkänt textutkast och skapar ett revisionskvitto
före ett provideranrop. Den är inte exponerad som API-rutt och används inte av
Cron. Lägg aldrig in variabler för att försöka återuppliva gamla
Supabase-rutter.

```text
# Meta: /api/social/connections/facebook_page/callback
#       /api/social/connections/instagram_professional/callback
SOCIAL_OAUTH_BASE_URL=https://din-domän
SOCIAL_TOKEN_ENCRYPTION_KEY=<base64-32-byte-key>
META_APP_ID=...
META_APP_SECRET=...

# LinkedIn: /api/social/connections/linkedin/callback
LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...

```

Resend- och `NEWSLETTER_*`-variablerna hör till den gamla Supabase-baserade
leveransvägen och aktiverar inte utskick i Vercel-läget. Använd dem inte som
en genväg: status, retry och unsubscribe ska fortsätta vara tydligt
otillgängliga tills leveransadaptern är Neon-ägd.

Vercel Cron kör Studio-kön varje minut på Pro, med ett litet begränsat antal
jobb per vakning och en processvid, token-fencad Neon-lease. Schemalagda
automationer skapar privata utkast för granskning; de publicerar aldrig
automatiskt och försöker inte skicka brev.

## Media Engine: research till privat utkast

Media Engine är en separat, multi-tenant researchmotor för Studio. En regel kan bevaka RSS, JSON/API eller inbyggd webbsökning. När minst det valda antalet omnämnanden från **unika källdomäner** handlar om samma sak skapas ett researchkluster. Motorn sparar källkedjan, vad som är känt, vad som saknas, osäkerheter och eventuella motsägelser innan den lägger ett privat utkastunderlag i innehållskön.

- En tenant har rollerna `owner`, `admin`, `editor` och `viewer`. En befintlig profil får automatiskt en deterministisk standardarbetsyta vid första anropet; ingen klientside-mock används.
- Källor och regler styrs via `/api/media-engine/tenants`, `/api/media-engine/sources` och `/api/media-engine/rules`. V1 stöder endast källor som motorn faktiskt läser: `rss`, publikt `api` och `web_search`.
- För en API-källa lägger du URL, query-parameter och annan icke-hemlig konfiguration i `configPublic`. Media Engine V1 använder endast publika API-endpoints: en tenant kan aldrig välja eller skicka en serverhemlighet till en egen URL. Autentiserade källor kräver en framtida serverägd credential-broker med fast leverantörs- och originbindning.
- En researchkörning, ett dossier och en handoff är alla tenant-scope:ade. Ett handoff kan skapa ett **privat** Studio-utkast, men kan aldrig schemalägga eller publicera något på egen hand.

Media Engine flyttas till samma Neon-arbetsyta och följer samma server-scope.
Den äldre implementationen har ännu inte en Neon-adapter, så den är avsiktligt
spärrad i en ny Vercel-installation i stället för att starta med en dold
Supabase-beroende. När adaptern är klar kräver research AI Gateway eller
`OPENAI_API_KEY`; publika RSS/API-källor kräver aldrig en klienthemlighet.

## Produktregler som är serverstyrda

- En publicerad händelse kräver en primärkälla eller två oberoende, trovärdiga sekundärkällor.
- Händelsestatus kan inte hoppa från exempelvis förslag till undertecknat utan en tillåten livscykelövergång.
- Ett underlag med blockerat domännamn kan inte återkomma som synlig källa efter modellen har svarat.
- Alla händelser är permanenta; samma verklighet skapar inte en ny händelse för varje artikel.
- Deduplikering bygger på status, datum, säkerhet och en normaliserad strukturerad faktavektor — inte på hur samma konsekvens råkar formuleras i två briefar.
- En brief fylls aldrig ut till fem poster och ger inga köp- eller säljrekommendationer.
- En konflikt-/säkerhetsbedömning som beskriver operativa utfall (territorium, militära resultat eller skadesiffror) kräver två oberoende etablerade redaktionella källor; en parts uttalande räcker endast för att styrka den partens egen policy.

## Konversation som kontrollpanel

Följande instruktioner sparas och bekräftas i chatten utan att behöva en modellerad gissning:

- “CNN ska inte användas som källa för mig.”
- “Lägg tillbaka CNN.”
- “Bevaka detta och säg till när status ändras.” (från ett händelsekort)
- “Följ EU:s cybersäkerhetsregler och säg till när något börjar gälla.”
- “Visa mindre amerikansk börsdata.”
- “Skapa en veckobrief om restauranger och öl.”
- “Lägg till https://exempel.se som källa.”

Fria analysfrågor går via Responses API med ett begränsat utdrag av den egna konversationen och eventuell vald händelse. Om API-nyckeln saknas svarar API:t tydligt i stället för att låtsas ge ett svar.

## Medvetna V1-gränser

- Creator-, podcast- och videoingest saknar ännu egen transkriptpipeline och är därför inte valbara som Media Engine-källor i V1.
- Operativsystemspush kräver separat VAPID/push-konfiguration. V1 skapar i stället proaktiva chattmeddelanden.
- `BRIEF_ALLOWED_DOMAINS` är en frivillig, ytterligare servergräns. När den anges kan den endast begränsa — aldrig runda — användarens källblockeringar.
- Händelseregistret är avsiktligt globalt i single-user V1. Innan en riktig multi-user-driftsättning behöver det delas upp i offentliga fakta och användarägda registerposter.

## Verifiering

```bash
npm run lint
npm run build
npm test
```

Testerna täcker bland annat lugn körning, deduplicering, livscykelstatus, källkrav, relevansreglage, systemiskt undantag, datumseparation och att en blockerad källa inte når vare sig sökning eller publicerad källkedja.
