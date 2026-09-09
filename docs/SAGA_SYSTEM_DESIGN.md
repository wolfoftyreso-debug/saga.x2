# SAGA System Design v1

SAGA är ett produktionssystem för innehåll, inte ett galleri av AI-funktioner.
Gränssnittet ska göra ett fåtal sanningar synliga: vad som arbetas på, vilken
kontroll som saknas, var ett objekt befinner sig och vad som händer härnäst.

## En gemensam arbetsmodell

```text
Varumärkesgrund + årsram/budget
        ↓
13-veckorsplan
        ↓
Referens och riktning
        ↓
Utkast + material
        ↓
Kvalitetsgranskning
        ↓
Godkännande
        ↓
Tid i SAGA-kalendern
        ↓
Separat leveranskvittens (när en leveransadapter finns)
```

Varje steg har ett tydligt ägt objekt och ett synligt tillstånd. Ett nytt
varumärke passerar alltid onboarding innan det kan bli aktivt. `Planerad` är
inte `publicerad`; en tid i SAGA är inte ett leveransförsök; `Format granskat`
är inte `levererad`; en lokal testplan är inte sparad data.

Om en arbetsyta har fler än ett aktivt, slutfört varumärke får inget
workspace-skopat AI- eller kunskapsflöde gissa ägare. Personen väljer först
varumärke; tills full brand-scope finns i datamodellen svarar äldre gemensamma
API:er med ett kontrollerat `brand_selection_required` utan att läsa underlag
eller skapa en körning.

## Fyra arbetsytor

| Arbetsyta | Frågan den besvarar | Primärt objekt |
| --- | --- | --- |
| Studio | Vad ska vi skapa eller förädla nu? | Brief, utkast, Serie, privat annonsmaterial |
| Kalender | När och i vilken kanal ska ett godkänt objekt användas? | Kalenderpost |
| Automationer | Vilket flöde körs och vad hände i varje körning? | Automationsregel, körningskvitto |
| Inställningar | Vilken säker kapacitet är tillgänglig? | Arbetsyta, källor, konton, API:er |

Specialiserade ytor — exempelvis Editorial Lens, bildreferenser, Annonsstudio
och Series — är kontextuella steg under Studio eller Automationer, inte lika
viktiga toppnivåer.

## Tre skikt på stora skärmar

1. **Systemnav** — smal, konsekvent rail med fyra primära destinationer.
2. **Arbetsyta** — en primär canvas: text, kalender, flödesbyggare eller
   formatmaterial.
3. **Inspektör** — metadata, status, kontroller och nästa tillåtna handling.

Vid minskad faktisk arbetsbredd blir inspektören en drawer. Mobil visar en
aktiv yta i taget; den staplar aldrig ett helt planeringssystem ovanpå en
förhandsvisning.

## Visuella regler

- Canvasen är huvudpersonen. Kort används endast för avgränsade objekt eller
  val — aldrig som standardbakgrund för varje textstycke.
- Status är saklig text med en liten indikator, inte färgglada dekorativa
  chips. Färg används främst för tillstånd och fokus.
- Ett objekt har en tydlig rubrik, typ, status och nästa handling. Undvik att
  säga samma ”lokal/demo/inte publicerad”-sak på fem ställen.
- Standardtext är minst 16/24; kontroller minst 14/20; metadata minst 12/16.
  Klickytor är minst 44×44 px på mobil.
- Gränssnittet använder neutral vit/grafit som arbetsyta och SAGA-grönt bara
  för aktivt läge, bekräftelse och primär handling.

## Automationsmodell

Flödesbyggaren visar ett begränsat, begripligt förlopp:

```text
Start → Källor/riktning → Skapa → Kvalitet → Mänsklig kontroll → Kalender → Leverans
```

Den fria canvasen får aldrig dölja drift. Varje automation har därför en egen
körningsvy med starttid, varaktighet, indata-/konfigurationsrevision,
resultat, försök, felorsak och säkra åtgärder: `Öppna utkast`, `Försök igen`
eller `Stoppa`.

Huvudcronens parallella workers koordineras av en tidsbegränsad, token-fencad
Neon-lease. Ett överlappande väckningsanrop gör inget nytt arbete och en
gammal körning får inte skriva över en senare körningsstatus.

## Säkerhetsgräns

AI producerar förslag. En människa granskar och sparar materialet. Extern
leverans kräver en separat, verklig kanalanslutning och kvittens. SAGA får
aldrig göra en knapp eller ett statusord mer kraftfullt än den faktiska
infrastrukturen bakom den.
