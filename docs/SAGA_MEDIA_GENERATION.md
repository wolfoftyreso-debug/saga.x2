# SAGA: privat AI-mediagenerering

`lib/services/saga-media-generation.ts` är den smala Vercel-native seamen för
en senare produktions- eller Cron-worker. Den är inte en publik API-rutt och
den publicerar inte någonting.

```text
durable run i Neon
  -> SAGA Creative Safety
  -> Vercel AI Gateway (OpenAI-compatible Images API)
  -> privat Vercel Blob
  -> { pathname, contentType, byteSize } till den ägda media-/draft-raden
```

## Kontrakt

Worker-anropet kräver ett server-resolverat `workspaceId`, `draftId` och ett
beständigt `runId`; den tar aldrig en Blob-URL, arbetsyta eller modell från
webbläsaren. Resultatet innehåller bara den opaque privata `pathname`, typ,
storlek, alt-text och modellmetadata. Blob-URL:n lämnar aldrig modulen.

Bildprompten byggs från SAGA Creative Safety:s **ändliga, säkra metafor**, inte
från fri text, pris, hook eller CTA. Därför kan ett osäkert fallande-hjul-/
folksamling-koncept inte nå bildmodellen, och fri copy kan inte bli en
prompt-injektion eller en oavsiktlig text-overlay i bilden.

Den högre Content/Ad Quality-grinden äger fortfarande frågan om ett komplett
utkast får in i kalendern. Media-seamen säkerställer bara att den visuella
delen är säker nog för ett privat underlag.

## Vercel-konfiguration

Krävs i den miljö som kör arbetaren:

- en privat Blob-store med `BLOB_READ_WRITE_TOKEN`;
- `AI_GATEWAY_API_KEY` lokalt, eller Vercels produktions-OIDC i den betrodda
  Function-requestkontexten (SAGA läser den via `@vercel/oidc`);
- valfritt `SAGA_IMAGE_GATEWAY_MODEL`, som måste vara `openai/gpt-image-...`.
  Standard är `openai/gpt-image-1.5`.

All saknad eller ogiltig konfiguration ger en fail-closed `503` **innan** ett
modell- eller Blob-anrop. Modellen används genom den OpenAI-kompatibla
Vercel AI Gateway-klienten på `https://ai-gateway.vercel.sh/v1`; ingen direkt
OpenAI-nyckel är ett möjligt fallback-spår.

## Retry och fallhöjd

Varje körning skapar högst ett Gateway-anrop och ett Blob-uppladdningsförsök.
Det finns medvetet ingen dold retry eftersom bildgenerering är kostnadsbärande.

- Gateway- eller Blob-fel blir `502` med `retryable: true`; en beständig worker
  kan lägga nästa försök enligt sin egen lease/idempotensregel.
- Om Blob fallerar efter en lyckad bildgenerering är ingen bild sparad och
  nästa workerförsök genererar på nytt. Arbetsflödet måste därför spara den
  framgångsrika privata sökvägen i Neon innan det går vidare till kalendern.
- Säkerhets- och indatafel är `422`/`400` och får aldrig retrieras automatiskt.
- Modulen innehåller ingen stockkälla, publik Blob-länk, social delivery eller
  publiceringskod.

## Teststatus

`tests/saga-media-generation.test.ts` kör det här kontraktet med mockad
Gateway och Blob: lyckad skyddad resultatform, saknad AI/Blob-konfiguration,
osäker scen, ogiltig modell/PNG samt explicit Blob-retry. Det är ett
deterministiskt kontraktstest; det är **inte** ett live-anrop mot Gateway eller
Blob.

För liveacceptans efter Vercel-deploy krävs en riktig privat Blob-store,
Gateway-kredit/behörighet och en server-worker som skriver resultatet till en
ägd Neon-mediepost. Bekräfta då i Vercel Logs att endast privata objekt skapas
och att inga sociala eller e-postanrop sker.
