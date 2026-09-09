# SAGA kvartalsplan: privat produktion med mänsklig kontroll

Den här vertikalen planerar en full 13-veckorshorisont, skapar riktiga privata Studio-utkast i batchar om högst tio och kräver mänsklig granskning innan nästa batch. Den schemalägger, publicerar, skickar eller köper aldrig något.

## Förutsättningar

- Neon-migrationerna `022` (Brand Onboarding) och `023` måste vara applicerade i ordning.
- Varumärkesprofilen måste tillhöra den signerade arbetsytan, vara aktiv och ha en slutförd onboarding. Klientens `workspaceId` används aldrig.
- V1 materialiserar bara `facebook_page`, `instagram`, `linkedin` och `newsletter`. `website` kan planeras i annan årsplanering, men är inte ett batchmål eftersom Studio saknar ett säkert privat utkastskontrakt för den.
- AI-utkast kräver Vercel AI Gateway. Om den saknas blir batchen ärligt `failed` med noll skapade utkast; den får aldrig ersättas av en påhittad demo.

## Data och tidssemantik

En plan sparar explicit:

- `horizonStartDate`: en måndag som användaren väljer;
- IANA-tidszon, kanalernas veckovisa eller månatliga frekvens, lokala dagar och tider;
- godkända teman, intention, innehållsriktning, CTA och bildriktning.

Servern härleder alltid exakt 13 veckor. Varje slot har `plannedAt`, `plannedLocalDate`, `plannedLocalTime` och `timezone`. Det är en önskad aktivitetstid, inte en publiceringstid.

När en batch skapar ett Studio-utkast är det alltid `status: in_review` och `studio_drafts.scheduled_at = NULL`. Utkastets metadata sparar dessutom en skrivskyddad `reviewPlannedAt`, `reviewPlannedLocalDate`, `reviewPlannedLocalTime` och `reviewTimezone` för granskning. Bildskapande är en separat manuell åtgärd i V1.

## API-kontrakt

Alla svar är `no-store`. UUID:n nedan är exempel; klienten skapar en ny UUID per ny kommandoavsikt.

### Plan

`GET /api/saga/quarterly-plans`

Ger aktörens små planöversikter.

`POST /api/saga/quarterly-plans`

```json
{
  "createIdempotencyKey": "uuid",
  "brandProfileId": "uuid",
  "plan": {
    "name": "Rullande 13-veckorsplan",
    "horizonStartDate": "2026-08-24",
    "timezone": "Europe/Stockholm",
    "channelPlans": [
      {
        "id": "linkedin-plan",
        "channel": "linkedin",
        "contentType": "social_post",
        "objective": "Ett tydligt redaktionellt mål med minst 12 tecken.",
        "cadence": { "unit": "weekly", "count": 1, "weekdayIds": [1], "localTimes": ["09:30"] },
        "themes": [{ "id": "system", "title": "System som frigör tid", "intent": "…", "contentDirection": "…", "approved": true }],
        "desiredCallToAction": "…",
        "imageDirection": "…",
        "targetLength": "medium"
      }
    ]
  }
}
```

`GET /api/saga/quarterly-plans/:brandProfileId`

Ger den kanoniska detaljvyn:

```ts
{
  plan: {
    id, brandProfileId, brandName, onboardingId, revision,
    plan, horizonWeeks: 13,
    slots: [{ id, channelPlanId, weekIndex, plannedAt, plannedLocalDate, plannedLocalTime,
      timezone, channel, contentType, theme, objective, contentDirection,
      desiredCallToAction, imageDirection, targetLength, planningLabel,
      state, revision, draftId, draftHref }],
    canRequestBatch, nextBatchReason, createdAt, updatedAt
  },
  batches: [{ id, planRevision, requestedCount, state, revision,
    canMaterialize, canRetry, canAbandon, retryExhausted,
    canRequestNextBatch, failureMessage, abandonedAt, items: [...] }]
}
```

`PATCH /api/saga/quarterly-plans/:brandProfileId`

```json
{ "expectedRevision": 7, "plan": { "…": "samma kompletta planform som ovan" } }
```

Detta är den explicita **rulla/utöka**-åtgärden. Välj en ny måndag som `horizonStartDate` för att fylla nästa kompletta 13 veckor. Den avvisas när en batch är öppen, så gamla riktiga utkast och slots aldrig skrivs över i smyg.

### Batch och privat AI-produktion

`POST /api/saga/quarterly-plans/:brandProfileId/batches`

```json
{ "idempotencyKey": "uuid", "expectedPlanRevision": 7, "planItemIds": ["slot-uuid"] }
```

Servern accepterar 1–10 unika slots och låser nästa batch atomärt. Ett nyss skapat batchobjekt är `queued` och innehåller ännu inget låtsasutkast.

`POST /api/saga/quarterly-plans/:brandProfileId/batches/:batchId/materialize`

```json
{
  "idempotencyKey": "uuid",
  "expectedPlanRevision": 7,
  "expectedBatchRevision": 1,
  "retryFailed": false
}
```

Svaret innehåller `{ batch, receipt, worker, noPublication: true, media: "manual_action_required" }`. `receipt` är ett varaktigt kvitto:

```ts
{ id, state: "running" | "completed" | "failed" | "stale", jobCount, failureMessage, reused }
```

En manuell körning bearbetar högst ett jobb för att hålla Vercel-funktionen inom Gateway-timeout. Vercel Cron fortsätter bara redan reserverade `running`-kvitton; den skapar aldrig en batch på egen hand.

**Återupptagning efter nätverks- eller browserförlust:** ett `queued` batch kan alltid startas senare med en ny UUID i `materialize` och samma aktuella revisioner. Det kräver ingen `sessionStorage` eller tidigare klientnyckel. När ett receipt redan är `running` ska samma idempotency key användas för att återläsa och fortsätta det receiptet; en annan samtidig nyckel får konflikt.

Batchtillstånd:

- `queued`: slots reserverade, ingen produktion startad;
- `generating`: en receipt har reserverat jobb;
- `ready_for_review`: alla verkliga privata utkast är länkade och kan öppnas;
- `rework_required`: ett utkast returnerades och måste redigeras/återinsändas;
- `resolved`: varje objekt är godkänt eller avvisat;
- `failed`: ett jobb misslyckades ärligt; inga osynliga retries;
- `stale`: en plan ändrades eller en människa avslutade ett permanent fel.

För ett `failed` batch är `canRetry` endast sant när varje misslyckat
durable jobb fortfarande har försök kvar. `retryExhausted: true` betyder att
en retry skulle avvisas av Neon; visa då `canAbandon` i stället. `canAbandon`
är aldrig ett automatiskt avslut och servern kontrollerar state, revision och
aktiv lease på nytt.

### Granskning och rework

`POST /api/saga/quarterly-plans/:brandProfileId/batches/:batchId/items/:itemId/review`

```json
{
  "idempotencyKey": "uuid",
  "expectedPlanRevision": 7,
  "expectedBatchRevision": 4,
  "expectedItemRevision": 3,
  "expectedDraftRevision": 1,
  "resolution": "approved",
  "note": ""
}
```

`resolution` är `approved`, `returned` eller `rejected`. Return kräver `note`. Granskning tillåts enbart när batchen är `ready_for_review` och draften fortfarande är privat/icke-schemalagd.

Vid `returned` sparar servern `returnedDraftRevision`. Användaren måste först redigera den riktiga Studio-draften så att dess revision blir **större än** detta värde.

`POST /api/saga/quarterly-plans/:brandProfileId/batches/:batchId/items/:itemId/resubmit`

```json
{
  "idempotencyKey": "uuid",
  "expectedPlanRevision": 7,
  "expectedBatchRevision": 5,
  "expectedItemRevision": 4,
  "expectedDraftRevision": 3
}
```

Det flyttar samma, redigerade privata draft tillbaka till `ready_for_review`; den genererar inte en ny text i smyg.

### Vanliga Studio-redigeringar av kvartalsutkast

`GET /api/content/drafts/:draftId` och andra Studio-svar exponerar en
serverhärledd flagga `quarterlyPrivateReview: boolean`. När den är `true` är
det ett batchbundet privat utkast. Klienten ska dölja vanliga
godkänn-/status-/schemaläggningskontroller tills batchobjektet har
`reviewResolution: "approved"`.

Servern är ändå auktoritativ: innan batchgodkännande tillåts endast vanlig
textredigering med `expectedRevision`; `status`, kanaler, innehållstyp,
tidszon, schema och approval-policy får inte ändras via `/api/content/drafts`.
Content Editors oskadliga standardvärde `status: "draft"` eller
`"in_review"` bevarar den serverägda statusen (`in_review` för returnerade,
`approved` efter batchgodkännande) så ett vanligt Spara aldrig nedgraderar
granskningsläget. Efter ett hållbart batchgodkännande är även innehållet låst
i den vanliga Studio-editorn; ett godkänt objekt kan senare placeras via den
befintliga kalenderns flytta-endpoint, men aldrig före den atomära
batchgranskningen.

Samma servergrind skyddar `/api/content/drafts/:draftId/media`: uppladdning,
metadata och borttagning av media nekas tills exakt batchobjekt är godkänt.
Returnerade, avvisade och `stale` batchar är skrivskyddade även om en klient
försöker anropa medieänden direkt.

### Permanent fel

Varje jobblease har maximalt tre försök. En utgången lease återtas säkert när försök återstår; när budgeten är slut blir batchen `failed` i stället för att fastna i `generating`.

`POST /api/saga/quarterly-plans/:brandProfileId/batches/:batchId/abandon`

```json
{
  "idempotencyKey": "uuid",
  "expectedPlanRevision": 7,
  "expectedBatchRevision": 8,
  "note": "AI Gateway behöver konfigureras innan vi försöker igen."
}
```

Endast en terminal `failed` batch kan avslutas. Servern avvisar den om en giltig workerlease fortfarande kör. Oavslutade jobb, batchobjekt och slots avbryts; verkliga redan skapade privata utkast behålls som revisionsunderlag. Batchen blir `stale`, vilket låser upp ny planrullning eller nästa batch. Inget publiceras.

## Kalender

`GET /api/content/calendar` innehåller nu både vanliga schemalagda Studio-utkast och en explicit `kind: "plan_slot"`-overlay. Plan-slot har `editable: false`, `calendarLabel: "Planerad aktivitet"`, `plannedLocalDate` och `plannedLocalTime`. Den går aldrig till kalenderns flytta/PATCH-kontrakt. Kalenderfönstret filtreras i den visade IANA-tidszonen, medan slotens ursprungliga planerade lokala tid bevaras. Den separata läsänden `/api/saga/quarterly-plans/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD&timezone=Europe/Stockholm` ger samma read-only plan-slots.

## Cron och drift

`/api/cron/tick` kör `runDueSagaQuarterlyActivityPlanWorker` med högst en receipt och ett AI-jobb per tick. Den resumerar bara handlingsbara receipts och rapporterar `noPublication: true`. `vercel.json` har redan minutcron för tick-routen.

Kör före deploy:

```bash
npx vitest run tests/saga-quarterly-planning-worker.test.ts tests/saga-quarterly-planning-contract.test.ts
npx tsc --noEmit --pretty false
npm run check:vercel:static
```

Ingen route i denna vertikal använder äldre `content-studio.ts`- eller `/api/content/automations`-vägar för att skapa dessa drafts.
