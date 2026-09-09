# SAGA Annonsstudio: format och produktionsgräns

Annonsstudio skapar privata, redigerbara materialprojekt. Den köper inte
media, ansluter inga annonskonton, exporterar inte tryckfiler och publicerar
inget. En formatvariant är därför en tydlig produktionsspecifikation, inte ett
påstående om att en plattform eller ett tryckeri kommer att acceptera den.

## Standardformat i version 2026-08-v1

| Familj | Exempel |
| --- | --- |
| Meta och LinkedIn | 1:1, 4:5, 9:16 samt LinkedIn liggande/kvadrat/stående |
| Google | Responsiv display (1,91:1, 1:1, 9:16), vanliga uppladdade displayformat och textresurser för sök |
| E-post och direktutskick | 600 px planeringsyta, A6 och DL |
| Tryck | A4, A3, A2, A1 och 50×70 cm |
| Tidning | Utgivarstyrt format: ange den bekräftade modulen som eget format |
| Eget format | px, mm eller tum, med DPI, utfall och säker marginal där det behövs |

Google-formaten utgår från [Googles riktlinjer för assets](https://support.google.com/google-ads/answer/13676244), [responsiv display](https://support.google.com/google-ads/answer/9823397) och [uppladdad display](https://support.google.com/google-ads/answer/1722096). LinkedIn-formaten följer [LinkedIns vägledning för single-image-annonser](https://www.linkedin.com/help/linkedin/answer/a427596/). Meta-formatet 9:16 är en planeringsyta enligt [Meta Reels guidance](https://www.facebook.com/business/ads/facebook-instagram-reels-ads).

Krav kan ändras och kan bero på konto, placering, land, tryckeri och
annonsprodukt. Kontrollera alltid den aktuella leveransspecifikationen före
köp eller export. ISO A-format beskriver papperets geometriska serie, inte en
universell tidnings- eller tryckleveransspecifikation.

## Vad varje format sparar

Varje variant har ett versionsstyrt preset eller en uttrycklig custom-canvas,
egen copy, CTA, valfri måladress, produktionsriktning och granskningsläge.
Projektet sparas atomärt med en revision. En gammal flik får 409 i stället för
att tyst skriva över någon annans ändring.

`Format granskat` är endast ett internt granskningsläge. Det betyder inte att
en annons är godkänd av Google, Meta, LinkedIn, en tidning eller ett tryckeri —
och det startar aldrig en extern leverans.
