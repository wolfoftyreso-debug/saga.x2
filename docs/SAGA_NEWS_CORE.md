# SAGA News Core

SAGA News Core är den säkra ingången för **externa signaler**, inte en
webbskrapare och inte en publiceringsmotor. Den gör ett begränsat antal
server-side hämtningar, normaliserar dem till samma kandidatformat och lämnar
sedan över dem till den Vercel/Neon-ägda signal- och trovärdighetsloopen.

```text
RSS / Atom / GDELT / Guardian
        ↓
Säker connector (HTTPS, DNS-pinning, gränser)
        ↓
Normaliserad kandidat — metadata + kort utdrag, aldrig artikelkropp
        ↓
Signal-, evidens- och Editorial Lens-motor
        ↓
Utkast → mänsklig granskning → styrd publicering
```

Det här lagret skriver inte till Neon, anropar ingen modell, hämtar inga
artikelkroppar, skickar inget och publicerar aldrig något. En kandidat är bara
underlag som sedan måste passera SAGA:s oberoende evidens- och
missionskontroller.

## Källor som finns nu

| Connector | Användning | Nyckel | Begränsning |
| --- | --- | --- | --- |
| RSS/Atom | Myndigheter, pressrum, branschorganisationer och redaktionella flöden | Nej | Endast serverkonfigurerad slutlig HTTPS-feed utan query-parametrar. |
| GDELT DOC 2.0 | Bred, nyckelfri internationell nyhetssignalering | Nej | Endast `artlist` + JSON, max 75 träffar och minst fem sekunder mellan lokala anrop. |
| Guardian Open Platform | Metadata-only discovery från Guardian | Ja, valfri | Ingen textkropp eller bild hämtas. En kommersiell/AI-kompatibel rättighet krävs före produktionsbruk. |

Ett officiellt myndighets- eller pressflöde behöver ingen specialconnector:
det läggs in som RSS/Atom med en explicit, serverägd `allowedHosts`-lista.

## Säkerhetskontrakt

Alla connectors kör i Node på servern och använder samma utgående
säkerhetsgrind:

- endast HTTPS, utan användarnamn, lösenord eller egen port;
- varje endpoint måste matcha sin fördefinierade tillåtna domänlista;
- DNS slås upp före anslutning och anslutningen pinnas till den verifierade
  publika IP-adressen; loopback, privata, link-local, multicast och direkta
  IP-adresser avvisas;
- redirectar avvisas. Konfigurera den slutliga HTTPS-adressen, inte en
  redirector;
- 15 sekunders timeout, högst 1 MB svar, `Accept-Encoding: identity` och
  strikt XML/JSON-innehållstyp;
- generiska RSS/Atom-adresser får **inga** query-parametrar. Därmed kan de
  inte bära token, API-nyckel eller signerade länkar;
- GDELTs filterparametrar byggs enbart från validerat indata och en hårdkodad
  endpoint. Guardians dokumenterade `api-key` läggs enbart till i den
  server-only connectorn från miljövariabeln — aldrig via UI/source-config,
  aldrig i loggar, kandidatresultat eller råmetadata;
- länkar i källsvar normaliseras till HTTPS och får alla query-parametrar och
  fragment borttagna innan de kan lagras, visas eller skickas till en modell;
- flödes-HTML reduceras till ren, begränsad text. `content:encoded` och alla
  fulla artikelkroppar ignoreras uttryckligen.

En connector får alltså aldrig behandla en fri webbadress från webbläsaren som
en fetch-adress. Källadministrationen ska skapa servervaliderade
connector-konfigurationer och passera dem till en Cron/Workflow-körning.

## Konfiguration i Vercel

RSS/Atom och GDELT behöver inga hemligheter. Guardian är helt avstängd tills
den här **server-only** Vercel-konfigurationen är tillagd för en uttryckligt
licensierad kommersiell/AI-driven användning:

```text
GUARDIAN_OPEN_PLATFORM_API_KEY=<kommersiell Guardian Open Platform-nyckel>
SAGA_NEWS_GUARDIAN_COMMERCIAL_LICENSED=true
```

Sätt inte dessa variabler utan den dokumenterade licensen. Använd aldrig
`NEXT_PUBLIC_` för dem, och lägg aldrig nyckeln i en
källkonfiguration, databasrad, URL, logg eller AI-prompt.

Guardian uppger att Developer-nivån är för icke-kommersiella användningar och
att kommersiella användningar behöver en kommersiell nyckel. Deras villkor har
också AI-/text- och data-mining-begränsningar. Därför är connectorn
metadata-only och ska inte aktiveras i en kommersiell AI-arbetsgång förrän
rättighetsläget har kontrollerats och godkänts för den aktuella användningen.

## Säker källkonfiguration

Källadministrationen skickar ett begränsat formulär från den inloggade
arbetsytan till en servervaliderad route. Den routen väljer den tillåtna
connectorn och avvisar fria headers, credentials, query-parametrar och
arbetsyte-id:n från klienten. En webbläsare kan alltså aldrig skapa en fri
fetch-konfiguration.

```ts
import { fetchSagaRssAtomCandidates } from "@/lib/news-core";

const result = await fetchSagaRssAtomCandidates({
  sourceId: "11111111-1111-4111-8111-111111111111", // källpostens UUID
  name: "Regeringens pressrum",
  feedUrl: "https://www.regeringen.se/press/rss.xml",
  allowedHosts: ["regeringen.se"],
  language: "sv",
  kind: "official",
});
```

GDELT är medvetet ännu stramare: endpoint, format, sortering och maxgräns är
hårdkodade; anroparen får bara välja ett begränsat sökuttryck, tidsfönster och
antal resultat.

```ts
import { fetchSagaGdeltDocCandidates } from "@/lib/news-core";

const result = await fetchSagaGdeltDocCandidates({
  sourceId: "11111111-1111-4111-8111-111111111111",
  query: '"electric vehicle" OR elbil',
  timespan: "1week",
  maxRecords: 30,
});
```

GDELTs publika tjänst kräver begränsad trafik. Connectorns lokala pacer
avvisar en ny förfrågan inom fem sekunder. När News Core kopplas till Vercel
Cron/Workflow ska den beständiga körningsleasen i Neon dessutom samordna detta
över samtidiga Vercel-instanser. Den får inte "lösa" rate limit genom en tät
retry-loop.

## Exakt adaptergränssnitt mot News Core-schema

Connectorerna känner inte till Neon-tabeller. En serverägd source-dispatcher
skickar en strikt `SagaNewsConnectorConfig` till
`runSagaNewsConnector(config)`. Det finns medvetet ingen generisk `url`,
`headers`, `apiKey` eller fetch-metod i unionen. Connectorerna returnerar
`SagaNewsConnectorResult`; repository-adaptern får ett färdigt
`SagaNewsIngestionBatch` genom `toSagaNewsIngestionBatch(result)`.

```ts
type SagaNewsConnectorConfig =
  | { connectorKey: "rss_atom"; input: SagaRssAtomSourceConfig }
  | { connectorKey: "gdelt_doc_2"; input: SagaGdeltDocQuery }
  | { connectorKey: "guardian_open_platform"; input: SagaGuardianOpenPlatformQuery };

const result = await runSagaNewsConnector(config);
const batch = toSagaNewsIngestionBatch(result);
```

```ts
type SagaNewsIngestionBatch = {
  sourceId: string;
  connectorKey: "rss_atom" | "gdelt_doc_2" | "guardian_open_platform";
  sourceKind: "rss" | "api";
  fetchedAt: string;
  candidates: Array<{
    sourceId: string;
    provider: "rss_atom" | "gdelt_doc_2" | "guardian_open_platform";
    canonicalUrl: string;
    title: string;
    summary: string | null;
    publishedAt: string | null;
    language: string | null;
    sourceDomain: string;
    contentHash: string;
    raw: Record<string, string | number | boolean | null>;
    fetchedAt: string;
  }>;
};
```

Schemaadaptern ska mappa:

| Connectorfält | Beständig signalpost |
| --- | --- |
| `sourceId` | `SagaNewsSource.id` (UUID/ogenomskinligt server-id) |
| `connectorKey` | `SagaNewsSource.connectorKey` |
| `sourceKind` | connectorns ingestionsklass (`rss` eller `api`); den sparade källan använder den mer precisa typen `rss`, `news_api`, `public_api`, `website` eller `manual` |
| `provider` | postens provenance/connectorfält |
| `canonicalUrl` | canonical/evidence URL |
| `title`, `summary`, `publishedAt`, `language`, `sourceDomain` | motsvarande normaliserade signalfält |
| `contentHash` | deduplicering/versionering |
| `raw` | liten provider-metadata, aldrig body/nyckel/URL med query |
| *(alltid)* | `bodyText: ""` — en separat, rättighets- och säkerhetsgranskad extraktionsprocess krävs innan en artikelkropp någonsin får finnas |

Det konkreta repository-kontraktet är:

```ts
const receipt = await beginSagaNewsIngestionRun(actor, {
  sourceId: batch.sourceId,
  idempotencyKey: crypto.randomUUID(),
  workerId: "manual-run",
});

const result = await persistSagaNewsConnectorBatch(actor, {
  runId: receipt.run.id,
  batch,
});

await completeSagaNewsIngestionRun(actor, {
  sourceId: batch.sourceId,
  runId: receipt.run.id,
});
```

Efter beständig deduplicering kan Signal Engine klustra på `sourceDomain`,
räkna oberoende bekräftelser och först därefter lämna ett faktaunderlag till
Editorial Lens. En ensam GDELT- eller Guardian-träff är inte publikationsgrund.

## Neon-kärna: beständig signal, bevis och Cron-leases

`202608240008_neon_saga_news_core.sql` gör handoffen beständig i Neon. Den
är en **kontroll- och bevismotor**, aldrig en publiceringsadapter.

| Del | Ansvar |
| --- | --- |
| `saga_news_sources` | Arbetsyteskopade, tillåtna RSS/API-källor med explicit domänallowlist/blocklist, viktning, intervall och item-gräns. |
| `saga_news_ingestion_runs` | Idempotenta hämtningskvitton per källa. Ett retry-id kan inte skapa en andra körning. |
| `saga_news_source_items` | Normaliserade, källspårbara items med source-scoped URL-identitet, content/story-fingerprints och begränsad provenance. |
| `saga_news_signal_candidates` + `saga_news_signal_evidence` | Kandidater med scores, oberoende evidens och en snapshot av källans trovärdighet/vikt vid utvärderingen. |

Källornas endpoint, JSON-policy och item-provenance avvisar credential-fält
och credentialliknande URL-parametrar i både Zod och Neon. Connectorn skickar
alltid `bodyText: ""`; en artikelkropp skrivs alltså inte av den här loopen.

Vercel Cron claima högst ett litet, begränsat antal förfallna källor via en
kort lease i Neon (`FOR UPDATE SKIP LOCKED`). Samma lease måste fortfarande
vara giltig när ett kvitto avslutas. Avslut och felhantering sätter nästa
hämtningspunkt och frigör leasen atomiskt, så en avbruten instans inte kan
hålla en källa låst för alltid.

Server-only repositoryflödet är:

```ts
const [claim] = await claimDueSagaNewsSources({
  workerId: "vercel-cron",
  limit: 2,
  leaseSeconds: 120,
});
if (claim) {
  const receipt = await beginClaimedSagaNewsIngestionRun(claim, {
    idempotencyKey: crypto.randomUUID(),
    workerId: "vercel-cron",
  });
  const result = await runSagaNewsConnector(configFor(claim.source));
  const batch = toSagaNewsIngestionBatch(result);
  if (batch.candidates.length > 0) {
    await persistClaimedSagaNewsConnectorBatch(claim, {
      runId: receipt.run.id,
      batch,
    });
  }
  await completeClaimedSagaNewsIngestionRun(claim, { runId: receipt.run.id });
}
```

Alla läsningar för Studio använder i stället en signerad `AppActor`:
`listSagaNewsSources`, `listSagaNewsIngestionRuns`,
`listSagaNewsSourceItems` och `listSagaNewsSignalCandidates`. Item-läsaren
väljer uttryckligen aldrig `body_text`; den returnerar bara titlar,
sammanfattning, canonical URL, publicistdomän, tid och begränsad provenance.
Lease-token är enbart servermaterial och lämnar aldrig dessa läsningar.

## Officiell dokumentation och användningsrätt

- [RSS 2.0 Specification](https://www.rssboard.org/rss-specification)
- [Atom Syndication Format, RFC 4287](https://www.rfc-editor.org/rfc/rfc4287)
- [GDELT DOC 2.0 API](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/)
- [GDELTs dokumenterade DOC 2.0/LLM-exempel](https://blog.gdeltproject.org/doc-2-0-api-llms-summarizing-headlines-turkish-investment-inflation-the-niger-coup/)
- [Guardian Open Platform — accessnivåer](https://open-platform.theguardian.com/access/)
- [Guardian Content API — `/search`-dokumentation](https://open-platform.theguardian.com/documentation/search)
- [Guardian Open Platform Terms](https://www.theguardian.com/open-platform/terms-and-conditions)
