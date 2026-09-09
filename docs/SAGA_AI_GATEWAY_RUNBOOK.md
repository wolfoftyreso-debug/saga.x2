# SAGA: säker start med Vercel AI Gateway

Det här är den avsedda vägen för att slå på verkliga AI-anrop i SAGA utan att
lägga leverantörsnycklar i kod, webbläsare eller ett publikt API. Den är
avsiktligt uppdelad i en säker start och en nyckelfri OIDC-slutpunkt.

## Vad som redan finns

SAGA har redan en server-only Gateway-gräns i `lib/vercel/ai-gateway.ts`.

- AI-labbet (`POST /api/content/ai-lab/generate`) kräver inloggad arbetsyta,
  returnerar endast osparade testvarianter och kan inte publicera.
- Den separata mediearbetaren anropar Gateway för en privat bild först efter
  att ett begränsat, idempotent jobb har leasats. Den körs från
  `/api/cron/media-generation` och får aldrig publicera.
- Saknad credential eller misslyckad modell blir ett ärligt fel; ett utkast,
  en bild eller ett publiceringskvitto fabriceras aldrig.
- `vercel.json` har två minutjobb. Vercel kör dem bara i Production och
  minutprecision kräver Pro eller Enterprise.

## Viktig OIDC-observation

Vercels generella OIDC-referens beskriver att Function-runtime får
OIDC-tokenen i request-headern `x-vercel-oidc-token`; miljövarianten är
avsedd för build och lokal utveckling. SAGA läser nu den betrodda
request-kontexten via Vercels officiella `@vercel/oidc`-hjälpare och har ett
test som bevisar att den vägen används utan en runtime-miljövariabel.

Det är en kodverifiering, inte ett bevis på den aktuella Vercel-installationen.
Den säkra utrullningen är därför fortfarande:

1. Starta med en dedikerad, budgeterad AI Gateway-nyckel, endast som en
   server-hemlighet i Production.
2. Deploya OIDC-klara koden och kör den begränsade live-smoken i Fas D.
3. Först när Gateway-loggen bekräftar en lyckad OIDC-autentiserad
   Production-request tas den statiska nyckeln bort.

Detta undviker både en blockerad första lansering och ett tyst byte till en
direkt modellnyckel.

## Fas A: aktivera Gateway säkert i dag

### 1. Sätt hårda kontroller i Vercel Team

I **AI Gateway → API Keys** skapar ägaren en dedikerad nyckel, exempelvis
`saga-production-server`.

- Slå på en Spend Quota med den lilla dagliga eller veckovisa gräns som
  ägaren godkänner för första veckan. En nyckelbudget stoppar efterföljande
  anrop när taket har passerats; räkna med att anropet som passerar gränsen
  kan hinna slutföras.
- Sätt även team-/projektbudget och bevakning. SAGA:s första AI-labbkörning
  jämför normalt tre modeller parallellt, med högst 2 600 output-tokens per
  modell. Välj därför en sparad tvåmodells-policy för första manuella testet
  om kostnaden ska vara extra snävt avgränsad.
- Aktivera Provider Allowlist först när de tillåtna leverantörerna är
  beslutade. Standardlabbet använder OpenAI, Anthropic och Google; den
  privata bildarbetaren använder OpenAI. En påslagen allowlist ska innehålla
  exakt de leverantörer som SAGA:s modeller faktiskt behöver. xAI ska inte
  tillåtas förrän en policy använder det.
- För profilinformation, privata referensbilder eller intern strategi: besluta
  om team-wide Zero Data Retention innan sådant material skickas. ZDR är en
  gatewayregel, inte anonymisering; den kan filtrera bort leverantörer och
  därmed göra ett modellval otillgängligt. Utvärdera modellernas aktuella
  ZDR-stöd först.

Använd inte BYOK i första steget om det inte finns ett dokumenterat krav på
ett befintligt leverantörsavtal. Det skulle återinföra fler långlivade
leverantörshemligheter utan att SAGA behöver dem för första lanseringen.

### 2. Lägg bara serverhemligheten i Production

I **Project → Settings → Environment Variables** lägger ägaren in:

```text
AI_GATEWAY_API_KEY=<dedikerad-saga-production-key>
```

Välj endast **Production** i första läget. Variabeln får aldrig ha
`NEXT_PUBLIC_`-prefix, ligga i `vercel.json`, skrivas i dokumentation med
sitt värde eller kopieras till klientkod.

Låt Preview sakna riktig AI i början. Då kan en PR aldrig konsumera
produktionsbudget av misstag. Om teamet senare behöver AI i Preview skapas
en **separat** låg-budgetnyckel och en separat Preview-scope.

För lokal utveckling används en egen låg-budgetnyckel i `.env.local`:

```text
AI_GATEWAY_API_KEY=<lokal-utvecklingsnyckel>
```

`.env.local` är redan ignorerad. Kör `vercel link` och `vercel env pull` bara
för den Vercel-miljö som utvecklaren uttryckligen ska använda; skriv aldrig
ut eller committa det hämtade värdet.

Ställ inte in `OPENAI_API_KEY` för nya Vercel-surfacer. SAGA:s nya Studio- och
automationsgränser faller inte tillbaka till den för att komma runt Gateway.

### 3. Behåll modellvalet som policy, inte browserinput

SAGA accepterar endast provider-kvalificerade modell-ID:n som är sparade i
Content Engine, till exempel `openai/...` eller `anthropic/...`. Lämna
miljövariablerna `AI_GATEWAY_LAB_*_MODEL`,
`SAGA_IMAGE_GATEWAY_MODEL` och `SAGA_BRAND_ADVISOR_GATEWAY_MODEL` tomma tills de modeller som finns i Gateway har
granskats. Webbläsaren får aldrig skicka en egen modellsträng eller credential.

## Fas B: deploy utan överraskningar

Följ ordningen nedan. Inget steg behöver en hemlighet i terminalutskrift.

1. Anslut Neon och private Blob till rätt Vercel-miljö, kör samtliga ännu inte
   installerade migrationer i `db/migrations/` i namnordning och konfigurera
   Sign in with Vercel. Klonens checksumstyrda runner måste först låsas till
   ditt verifierade projekt enligt [klonens setup](./CLONE_SETUP.md).
   Ingen tidigare installationsstatus följer med källkodskopian. Återkör inte redan
   installerade filer. Vercels första deployment klassas alltid Production;
   detta måste hanteras uttryckligen innan en ny miljö deployas.
2. Lägg en slumpmässig `CRON_SECRET` på minst 16 tecken i Production. Vercel
   skickar den som `Authorization: Bearer …` när den anropar cron-rutterna.
3. Kör följande från checkouten före deploy:

   ```bash
   npm run check:vercel:static
   npm run lint
   npm test
   npm run build
   ```

4. Kör `npm run check:vercel` i en miljö som faktiskt har de servervariabler
   som ska deployas. Kontrollen skriver endast namn och konfigurationsstatus,
   aldrig hemlighetsvärden.
5. Deploya först till Production. Vercel Cron registreras endast för
   Production-deploys, inte för Preview.

## Fas C: begränsad produktionssmoke

Gör endast en kontrollerad körning, i denna ordning.

1. Öppna `/api/health`. Den ska svara `ok: true` och `database: "ready"`.
2. Logga in, öppna `/studio/engine`, välj en godkänd referens och en sparad
   skrivpolicy med två tillåtna modeller, och kör ett enda AI-labbtest.
3. Kontrollera i AI Gateway-dashboarden att exakt de väntade modellerna,
   projektet, kostnaden och request-resultatet syns. Kontrollera samtidigt
   Vercel Functions/Observability för statuskod och varaktighet.
4. Bekräfta i Studio att testet fortfarande är ett osparat, opublicerbart
   förslag. Ingen kalenderpost, kanal eller extern leverans får ha skapats av
   detta test.
5. För mediekedjan: skapa ett enda avsett privat mediejobb, invänta nästa
   cron-körning och kontrollera dess kvitto. Bilden ska ligga privat i Blob
   och vara knuten till rätt arbetsyta; den ska inte ha en publik Blob-URL.

Verifiera dessutom att en obehörig anropare får `401` på båda cron-rutterna.
Kör inte ett manuellt curl-anrop med en riktig `CRON_SECRET` i delad terminal,
logg eller chatthistorik.

## Fel, stopp och rollback

| Händelse | Förväntat SAGA-beteende | Operatörens åtgärd |
| --- | --- | --- |
| Saknad Gateway-credential | AI-labbet svarar 503 och sparar/publicerar inget. | Stoppa här; lägg inte in en direkt OpenAI-nyckel som genväg. |
| Modell- eller nätverksfel | AI-test svarar 502 och sparar/publicerar inget. | Läs Gateway request-loggen och försök en ny, manuell körning först efter åtgärd. |
| Budget passerad | Gateway avvisar senare anrop; ingen falsk framgång skapas. | Pausa automationen, granska kostnad och höj aldrig taket utan beslut. |
| Privat bildjobb saknar Gateway eller Blob | Arbetaren skriver ett terminalt felkvitto i stället för att skapa en bild. | Åtgärda konfigurationen och skapa ett nytt explicit jobb. |
| Misstänkt läcka | Nyckeln kan återkallas i AI Gateway. | Återkalla nyckeln, ta bort Production-variabeln, deploya om och skapa en ny budgeterad nyckel först efter granskning. |

Vercels Cron-dokumentation varnar för att Instant Rollback inte automatiskt
uppdaterar aktiva cron-jobb. Vid rollback: öppna **Settings → Cron Jobs** och
inaktivera eller uppdatera jobben manuellt. Lita inte på rollbacken ensam.

## Fas D: flytta till nyckelfri OIDC

Följande är redan implementerat och testat i koden:

1. OIDC-token läses i Function-requestens betrodda runtime-kontext genom
   `@vercel/oidc`, inte enbart via `process.env`.
2. Gateway-klienten skapas från den kortlivade tokenen när en serverrequest
   gör ett AI-anrop. Tokenen lagras aldrig i Neon, Blob, loggar eller ett
   jobbpayload.
3. Test täcker request-runtime OIDC och att saknad credential fortsätter vara
   fail-closed utan direkt leverantörsfallback.

Det som återstår är operatörens live-verifiering:

4. Deploya, kör samma begränsade smoke ovan och bekräfta i Gateway-loggen att
   OIDC-autentiserade requestar lyckas.
5. Ta därefter bort `AI_GATEWAY_API_KEY` från Production och verifiera igen.

## Officiella källor

- [Vercel AI Gateway: översikt](https://vercel.com/docs/ai-gateway)
- [Autentisering, OIDC och BYOK](https://vercel.com/docs/ai-gateway/authentication-and-byok)
- [Vercel OIDC-referens](https://vercel.com/docs/oidc/reference)
- [AI Gateway API-nyckelbudgetar](https://vercel.com/changelog/budgets-for-api-keys-on-ai-gateway)
- [Provider Allowlist](https://vercel.com/changelog/team-wide-provider-allowlist-on-ai-gateway)
- [Zero Data Retention och no-prompt-training](https://vercel.com/changelog/zero-data-retention-no-prompt-training-on-ai-gateway)
- [Vercel Cron: skydd, precision och rollback](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
