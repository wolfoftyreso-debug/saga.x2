# SAGA: privata avatarreferenser

SAGA kan i en senare version använda flera privata referensbilder för att göra ett återkommande visuellt uttryck mer personligt. Det är inte ett profilfotoverktyg och det ska inte skapa en fullt synlig eller identifierbar personbild.

## Produktkontrakt

- Referensbilder får bara laddas upp av den som har rätt att använda dem och som aktivt samtycker till den privata avatarfunktionen.
- Råbilder lagras som privata filer i Vercel Blob. De får inte returneras som publika URL:er, återges i kalendern eller skickas till webbläsaren som vanliga förhandsbilder.
- Det enda utdataformatet är anonymiserat: noir, silhuett, bakifrån, beskuren sidoprofil eller motsvarande med ansiktet skymt.
- En prompt är inte en bildgranskning. Varje utdata är privat och har status `review_required` tills en bildverifierare eller behörig människa har fastställt att ansiktet är skymt och identitetsläckagerisken är låg.
- Även ett privat godkänt resultat ger **inte** behörighet att lägga inlägget i kalendern, publicera det eller använda ett externt konto. Dessa beslut ligger i separata redaktionella och OAuth-baserade flöden.

## Per-körning, inte en dold överföring

Vercel AI Gateway kan använda modeller med högfidelitets-bildinmatning och bildredigering. Vercels aktuella dokumentation för GPT Image 2 säger dock att Zero Data Retention inte är tillgängligt för den modellen. Därför får SAGA aldrig skicka en privat ansiktsreferens till en bildleverantör bara för att en profil en gång är uppladdad.

Före varje körning måste användaren aktivt:

1. välja att privata referenser får skickas för just den körningen,
2. se den valda modellens/leverantörens datavillkor och göra ett uttryckligt val, och
3. bekräfta att underlaget är deras eget eller att de har rätt att använda det.

Om något av detta saknas stannar bilden i privat Vercel Blob och ingen modellkörning startas. Se [Vercels GPT Image 2 FAQ](https://vercel.com/ai-gateway/models/gpt-image-2/faq) och [modellöversikten](https://vercel.com/ai-gateway/models/gpt-image-2) för den aktuella kapaciteten och retentionsinformationen.

## Framtida serverseam för bildreferens

`lib/services/saga-avatar-privacy.ts` är bara policy- och granskningslagret. En kommande, serverägd worker ska följa denna ordning:

1. Autentisera användaren och kontrollera att `avatarProfileId` och varje `referenceImageId` tillhör den aktuella arbetsytan och har aktivt samtycke.
2. Bygg `SagaAvatarGenerationPolicy`. Om `assertSagaAvatarGenerationCanStart` kastar ska worker sluta innan Blob läses.
3. Hämta privata Blob-objekt server till server, utan signerad publik URL och utan att föra Blob-sökväg eller råbytes till klienten.
4. Med den uttryckliga per-körningsbekräftelsen: skicka endast de redan auktoriserade bytesen till en uttryckligen tillåten AI Gateway-bildmodell. Lägg aldrig till ett generellt model-fallback som kan skicka bilder till en annan leverantör.
5. Spara resultatet som privat Blob-media med en skyddad, arbetsyteverifierad asset-route. Markera resultatet `review_required`.
6. Kör en faktisk pixelgranskning med ansikts-/identitetskontroll eller en behörig mänsklig granskare. Endast `faceVisibility: "obscured"`, `fullIdentifiableFaceDetected: false` och `identityLeakRisk: "low"` blir `private_approved`.
7. Behåll separat redaktionell kvalitetsgrind och separat, användarinitierad OAuth-anslutning för kalender/publicering. Avatarlagret kan aldrig "ta över" privata konton.

För att hålla detta korrekt får implementationen inte påstå att prompttext ensam garanterar dolda ansiktsdrag, och den får inte återanvända referensbilder automatiskt vid framtida körningar.
