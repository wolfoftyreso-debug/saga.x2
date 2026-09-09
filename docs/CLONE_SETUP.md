# Konfigurera saga.x2

Det här är en fristående källkodskopia, inte en kopia av en aktiv installation.
Den ursprungliga appens arbetsmapp och deployment påverkas inte av detta repo.

## Ingår och ingår inte

Appkod, publika demoillustrationer, beroendelåsfil, 32 Neon-migrationer,
historiska Supabase-migrationer, produktdokumentation och tester ingår.
Privata foton, databasposter, sessionscookies, API-nycklar, `.env.local`,
`.vercel` och miljöspecifika driftrapporter ingår inte. `.env.example` innehåller
tomma credentialfält och publika standardvärden.

Ett lokalt redaktionellt voice-pack med tio opublicerade originalutkast och
dess dokumentberoende test ingår inte i den publika kopian. Appen använder inte
den filen i runtime. Originaldokumentet och testet finns kvar i ursprungsmappen.

## Lokal kontroll

Använd Node 24.x och kör:

```sh
npm ci
npm run check:vercel:static
npm test
npm run build
```

För att använda den inloggade produkten krävs en egen korrekt konfiguration av
databas, privat media, inloggning och AI Gateway. Följ [Vercel-setupen](./VERCEL_SETUP.md).
Hemligheter ska ligga i lokala miljöfiler eller plattformens miljöhantering,
aldrig i Git. Publicera inte personliga driftrapporter eller privata testbilder.

## Migrationsskydd

`scripts/neon-migrate.mjs` har ett avsiktligt platshållarvärde i `SAGA_PROJECT_ID`.
Byt det till klonens verifierade Vercel-projekt-ID först efter att projekt och
isolerad testdatabas har valts. Behåll den fasta projektkontrollen; ta inte bort
den för att få ett kommando att passera. `.vercel/project.json` måste peka på
samma projekt och den direkta Neon-hosten måste bekräftas med `--expected-host`.

Runnerns standardläge är read-only. `--apply` är ett separat uttryckligt val.
Kör aldrig historiska migrationer på nytt i en redan registrerad installation.
Ingen databas kopplades eller migrerades när denna källkodskopia skapades.

## Driftstatus

Att pusha kod är inte en deployment eller ett godkännande av automatisk
publicering. `vercel.json` innehåller cron-definitioner; granska dem och rätt
miljö uttryckligen före en framtida Production-deployment. Ingen Vercel- eller
GitHub Actions-koppling skapades som del av kopieringen.

Kvarstående produktgräns: kvartalsbatchens separata genereringsväg måste få
obligatorisk, versionsbunden koppling till ett godkänt referensinlägg innan
den betraktas som automationsklar. Inloggade live-flöden och integrationer
måste verifieras i klonens egen miljö; tidigare tester bevisar inte dess drift.
