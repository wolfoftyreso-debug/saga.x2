import type { CandidateEvent, ProfileSettings, StrategicRadar, WorldPulse } from "@/lib/domain/types";

/** Only durable brief/update references are exposed to the editorial model. */
export type WeeklyRecapSelectionContext = {
  periodStart: string;
  periodEnd: string;
  items: Array<{
    eventId: string;
    eventUpdateId: string;
    date: string;
    title: string;
    whatChanged: string;
    whyItMatters: string;
    relevanceScore: number;
  }>;
};

const eventStatusGuide = `
Statusvärden (använd exakt ett):
rumor = obekräftat rykte; reported = rapporterat men inte bekräftat; proposed = föreslaget;
negotiating = under förhandling; announced = officiellt annonserat; signed = undertecknat;
adopted = antaget; effective = i kraft; implemented = implementerat; changed = villkor eller faktisk innebörd ändrad; reversed = upphävt eller återkallat.
Ett föreslag eller en förhandling är aldrig signed eller adopted.`;

const directSwedishBriefPolicy = `
RAK SVENSK BRIEFPOLICY (BINDANDE)
Skriv som beslutsstöd, inte som nyhetsartikel, politisk kommentar eller konsultpresentation. Varje publicerad förklaring ska följa denna ordning: 1) verifierat faktum, 2) konkret betydelse för användaren, 3) exakt handling eller uttryckligen ingen handling.

- Börja med vem som gjorde vad, vad som faktiskt ändrades och vilket datum/villkor som gäller när det är relevant. Skriv i aktiv form med konkreta substantiv och verb.
- Förklara bara en direkt, synlig koppling till användarens profil, marknad, leverantör, avtal, kostnad, dataflöde, tidplan eller risk. Gissa aldrig en privat exponering.
- Ge antingen en exakt nästa handling med verb + objekt + tidsgräns/utlösare när den är känd, eller skriv "Ingen åtgärd behövs nu." Skriv aldrig tomma råd som "se över", "beakta", "hålla koll på", "säkerställ" eller "vara uppmärksam" utan att säga vad, varför och när.
- Använd ordet "kan" endast när det finns verklig, kvarvarande osäkerhet i underlaget. Namnge då villkoret: "Det kan påverka [X] om [konkret villkor]." Använd inte "kan" som allmän försiktighetsfras när den direkta följden redan är verifierad.
- Om något är osäkert, säg exakt vad som inte är bekräftat, vilket beslut eller datum som saknas, eller vilken källa som ännu inte räcker. Dölja aldrig osäkerhet med vag prosa.
- Skriv inte om retorik, politiska utspel, opinionsläge, motiv, stämning eller vem som "vinner" kommunikationen. Rapportera endast beslut, regler, villkor, händelser och observerbara följder.
- Förbjudna utfyllnadsfraser: "i ett förhöjt läge", "ur ett helhetsperspektiv", "en rad faktorer", "potentiellt", "i linje med", "förändrat landskap", "noterbart", "strategiskt", "marknaden är orolig" och "det återstår att se".
- En mening ska normalt ha en huvudpoäng. Skriv kort, vardaglig svenska. Upprepa inte status, källa eller samma faktum i flera fält.
`;

const discoverySwedishFactPolicy = `
SPRÅK I DISCOVERY
Skriv kandidatens title, whatChanged och termsSummary som råa, korta fakta — aldrig som rubrikretorik. title ska beskriva själva förändringen. whatChanged ska säga vem som gjorde vad och vad som nu gäller. termsSummary ska beskriva villkoren neutralt. Använd "kan" endast för en namngiven, faktisk osäkerhet; annars skriv vad källan bekräftar. Lägg aldrig rekommendation, personlig betydelse, politisk tolkning eller konsultspråk i dessa fält.`;

export function discoveryInstructions(input: {
  profile: ProfileSettings;
  coverageFrom: string;
  now: string;
  feedback?: unknown;
  explicitWatches?: string[];
  briefInstructions?: string;
  personalContext?: unknown;
  sourcePolicyGuidance?: string;
  runPurpose?: "brief" | "watch";
  includeWorldPulse?: boolean;
  includeStrategicRadar?: boolean;
}): string {
  const purpose = input.runPurpose === "watch" ? "Detta är ett återkommande bevakningspass: prioritera uttryckliga bevakningar och nya materiella statusförändringar; skapa ingen utfyllnad." : "Detta är en schemalagd brief: prioritera endast verkliga förändringar som klarar en hög relevanströskel.";
  const worldPulseInstruction = input.includeWorldPulse
    ? `
DAGLIG LÄGESBILD
Gör dessutom en mycket kort, separat worldPulseScan för samma täckningsperiod. Den är en orientering ovanför beslutshändelserna, inte ett sätt att skapa extra kandidater eller materialChange. Returnera exakt tre linser: conflictSecurity, economy och personalExposure.

- conflictSecurity: kontrollera krig, konflikt, cyber- och säkerhetsläge endast för bekräftade förändringar med internationell spillover, sanktioner, energi/logistik eller tydlig påverkan på användarens regioner. Skriv aldrig en daglig slagfältsrapport. Ett uttalande från en part kan bara styrka den partens egen policy; det styrker aldrig territorium, militära resultat eller skadesiffror. För sådana operativa utfall krävs neutral institution eller två oberoende etablerade redaktionella källor.
- economy: kontrollera ränte-/kreditregim, valuta, energi, handel och finansiell infrastruktur. Vanliga marknadsrörelser och allmänt marknadssentiment är inte en förändring.
- personalExposure: härled enbart från synlig profil, basregion och faktiska kandidatförändringar. Om underlaget om personlig exponering är tunt ska det framgå; anta aldrig privata innehav, resor eller verksamheter.

Varje lins har status changed, stable, uncertain eller unavailable. stable betyder endast "ingen verifierad materiell förändring hittades i det granskade underlaget sedan ${input.coverageFrom}" — aldrig att inget hände i världen. changed kräver en konkret, verifierad förändring. uncertain används vid motstridigt eller otillräckligt men delvis granskat underlag; unavailable när linsen inte gick att kontrollera och ska då ha tom sources-lista. En tillgänglig lins måste ha minst en källa. Länka bara changed-linser till relevanta canonicalKey från kandidater; stable får aldrig länka en händelse. Sätt coverage=complete endast om alla tre linser har tillräckligt verifierat underlag; annars partial eller unavailable. overallStatus=calm kräver complete täckning och tre stable-linser. Använd asOf=${input.now}. Skriv headline som ett enkelt svar på vad som är läget, summary med högst en kort förklarande mening och implication med högst en kort mening i direkt "för dig"-språk.`
    : "\nFör denna smala bevakningskörning ska worldPulseScan vara null.";
  const strategicRadarInstruction = input.includeStrategicRadar
    ? `
STRATEGISK RADAR
Returnera dessutom strategicRadarScan. Det är tre små, separata sektioner för sådant användaren kan förbereda sig för eller delta i. Det är inte ett nyhetsflöde, inte en aktielista och inte en fjärde händelselista. Sök först utifrån personalContext.interests och personalContext.opportunities; de är uttryckliga söksignaler och väger före generella ämnen. Ta högst tre poster i varje sektion. En äldre officiell annonsering får tas med endast om dess framtida lansering, öppna ansökan, deadline eller datum fortfarande är relevant nu.

- aiRoadmap: Ta bara med kommande AI-modellförmågor som leverantören själv har officiellt annonserat eller satt på en offentlig roadmap. Varje post måste ha minst en primärkälla från leverantören. Rykten, läckor, analytikerprognoser och vaga uttalanden är förbjudna. kind=ai_roadmap och status är exakt officially_announced eller official_roadmap.
- businessOpportunities: Ta bara med konkreta, öppna eller officiellt annonserade upphandlingar, partnerskap, program, marknadsöppningar eller ansökningsfönster där användaren faktiskt kan ta nästa steg. Varje post måste säga vem som öppnat möjligheten, vad som är öppet och nästa konkreta steg. Generella trender, investeringscase och säljpitchar är förbjudna. kind=business_opportunity och status är announced, open eller deadline.
- contexts: Ta bara med verifierade konferenser, deadlines, möten eller digitala sammanhang som matchar profilens intressen eller möjligheter. Varje post måste ha datum och location; använd exakt "Digitalt" för ett online-sammanhang. kind=context och status är upcoming, registration_open eller deadline.

Varje post har källor med publiceringsdatum och händelsedatum när de skiljer sig. Om en sektion inte har någon post som når kraven, använd status=none_relevant, items=[] och summary exakt "Ingen relevant post." Om den inte kan kontrolleras, använd status=unavailable, items=[] och en kort förklaring. Använd aldrig köp-, sälj- eller värderingsråd. Skriv kort och rakt: verifierat faktum, varför det berör användaren, nästa steg.`
    : "\nFör denna smala bevaknings- eller specialbriefkörning ska strategicRadarScan vara null.";
  return `Du är discovery-steget i ett privat beslutsstöd, inte en nyhetsredaktör. Sök på webben efter verkliga, verifierbara tillståndsförändringar sedan ${input.coverageFrom} fram till ${input.now}. ${purpose}

Utgå först från den synliga personliga exponeringsprofilen och den här briefens särskilda uppdrag. personalContext.interests och personalContext.opportunities är uttryckliga prioriteringar för sökning och urval; använd dem före generella kategorier när de finns. De är auktoritativa för vad som är relevant. Anta aldrig ett visst namn, yrke, land, bransch eller intresse som inte står där. Om profilen är tunn, använd en konservativ standard: officiella beslut, större ekonomiska/regulatoriska förändringar och verifierade förmågeskiften – aldrig ett allmänt nyhetsflöde.

Prioritera faktiska tillståndsförändringar: undertecknade eller antagna beslut/avtal, sanktioner/tullar/exportrestriktioner, ränte- och skattebeslut, reglering, bekräftade produkt- eller kapacitetsförändringar, leverantörsvillkor, energi/logistik/säkerhet samt uttryckliga personliga eller lokala intressen när profilen ber om dem. Uteslut politiskt teater, opinioner, obekräftade rykten, normala börsrörelser, små uppdateringar och generella marknadskommentarer.

En kandidat måste beskriva en faktisk förändring, inte samma händelse i en ny artikel. canonicalKey ska vara stabil och beskriva den verkliga händelsen utan statusord. Fältet termsSummary ska vara en kort, neutral redogörelse för villkoren. materialFacts är däremot den stabila, strukturerade faktavektorn för deduplicering: varje rad anger dimension, förändringsriktning, vad som faktiskt berörs och ett konkret värde eller null. Använd bara observerbara fakta såsom bindande krav, omfattning, datum, tröskel, pris/kostnad, åtkomst, kapacitet, risk, leverans eller kapitalvillkor. Lägg aldrig personlig relevans eller briefprosa i materialFacts; använd samma faktarader för samma verklighet även om texten formuleras annorlunda. Ta med primärkällor före sekundärkällor och håll isär publiceringsdatum och händelsedatum. Ta aldrig med köp- eller säljråd.
Återkopplingsmönster från användaren (använd för att förstå varför något är relevant, men sänk aldrig käll- eller materialitetskraven): ${JSON.stringify(input.feedback ?? [])}
Uttryckliga bevakningsfrågor (de är extra söksignaler, men berättiga aldrig en osäker eller oväsentlig post): ${JSON.stringify(input.explicitWatches ?? [])}
Den här briefens särskilda uppdrag: ${input.briefInstructions?.trim() || "Använd användarens övergripande profil."}
Synlig personlig exponeringsprofil (använd för relevans och förklaringen “varför det berör dig”, aldrig för att sänka beviskraven): ${JSON.stringify(input.personalContext ?? {})}
Aktiva källregler för denna körning (prioritet, ämnesfilter, frekvens och roller är bindande; använd endast tillåtna domäner och skilj på verifiering och citering): ${input.sourcePolicyGuidance ?? "[]"}
${eventStatusGuide}
${discoverySwedishFactPolicy}
${worldPulseInstruction}
${strategicRadarInstruction}

Returnera högst 60 kandidater, eller en tom lista om ingen källa når kraven. Skriv all fri text på tydlig svenska.`;
}

export function editorialInstructions(input: {
  profile: ProfileSettings;
  existingEvents: Array<{
    id: string;
    canonicalKey: string;
    title: string;
    status: string;
    termsSummary: string | null;
    effectiveDate: string | null;
    confidence: string;
    shortTermImpact: string | null;
    longTermImpact: string | null;
  }>;
  coverageFrom: string;
  feedback?: unknown;
  briefInstructions?: string;
  personalContext?: unknown;
  sourcePolicyGuidance?: string;
  runPurpose?: "brief" | "watch";
  includeWorldPulse?: boolean;
  includeWeeklyRecap?: boolean;
  includeStrategicRadar?: boolean;
}): string {
  const profileSummary = {
    topics: {
      ekonomi: input.profile.economyWeight,
      teknik: input.profile.technologyWeight,
      reglering: input.profile.regulationWeight,
      geopolitik_handel: input.profile.geopoliticsWeight,
    },
    regions: {
      sverige_eu: input.profile.swedenEuWeight,
      usa: input.profile.usaWeight,
      gulf: input.profile.gulfWeight,
    },
    relevanceThreshold: input.profile.relevanceThreshold,
    maxItems: input.profile.maxItems,
    briefDepth: input.profile.briefDepth,
    baseRegion: input.profile.baseRegion,
  };

  const purpose = input.runPurpose === "watch"
    ? "Detta är ett bevakningspass. Rapportera bara en kandidat vars status eller materiella innebörd faktiskt har ändrats; ingen daglig brief ska fyllas här."
    : "Detta är en brief. Du får inte fylla den för att nå ett antal poster.";
  const worldPulseInstruction = input.includeWorldPulse
    ? `
DAGLIG LÄGESBILD
Granska discoverys worldPulseScan och returnera en slutlig worldPulse. Den är ett separat, kort lägeskort och får aldrig skapa en event update eller ersätta händelseregistret. Den måste ha exakt tre linser: conflictSecurity, economy och personalExposure. Kontrollera källorna själv med webbsökning; varje lins som inte är unavailable behöver minst en tillåten, verifierbar källa och slutsatsen måste vara proportionerlig mot den.

För konflikt/säkerhet: ta endast med bekräftade materiella förändringar i diplomati, sanktioner, humanitär/energi/logistik/cyber/säkerhetsexponering eller annan internationell spillover. Inga rutinmässiga slagfältsuppdateringar. En parts uttalande får bara styrka dess egen policy, aldrig ett operativt utfall som kontroll över territorium, militära resultat eller skadesiffror. För operativa eller blandade påståenden krävs neutral institution eller två oberoende etablerade redaktionella källor.

För economy: uttryck bara regler, räntor, kredit, valuta, energi, handel eller infrastruktur som faktiskt har ändrats. För personalExposure: härled bara från den synliga profilen och de verifierade fakta; säg att underlaget är tunt i stället för att gissa.

status=stable betyder endast att ingen verifierad materiell förändring hittades i det granskade underlaget sedan ${input.coverageFrom}; påstå aldrig att inget har hänt i världen. status=uncertain eller unavailable måste tydligt avgränsa underlaget. coverage=complete kräver att samtliga tre linser är verifierat täckta. overallStatus=calm kräver complete täckning och tre stable-linser. Sätt linkedEventKeys bara för changed-linser och endast till canonicalKey som faktiskt förekommer i discovery-underlaget. Använd källornas faktiska publicerings- och händelsedatum. Skriv headline som ett kort besked, summary med högst en kort mening och implication med högst en enkel "för dig"-mening.`
    : "\nFör detta bevaknings- eller specialbriefpass ska worldPulse vara null.";
  const weeklyRecapInstruction = input.includeWeeklyRecap
    ? `
VECKAN HITTILLS
Returnera weeklyRecap som ett objekt med eventUpdateIds. weeklyRecapContext innehåller endast tidigare sparade, verifierade briefposter för den angivna veckoperioden. Välj högst fem eventUpdateIds exakt som de står i underlaget. Välj bara det som hjälper användaren att förstå veckan hittills; välj aldrig samma id två gånger.

Du får inte skriva om, tolka eller lägga till fakta här: runnern återanvänder den sparade rubriken, förändringen, relevansförklaringen, datumet och källkedjan. Hitta inte på ett id. Om underlaget saknar poster ska weeklyRecap vara {"eventUpdateIds":[]}.`
    : "\nFör detta bevaknings- eller specialbriefpass ska weeklyRecap vara null.";
  const strategicRadarInstruction = input.includeStrategicRadar
    ? `
STRATEGISK RADAR
Granska discoverys strategicRadarScan och returnera en slutlig strategicRadar. Det är tre korta, källstyrkta sektioner vid sidan av händelseregistret. Prioritera personalContext.interests och personalContext.opportunities före generella ämnen. Varje sektion får ha noll till tre poster. En post får aldrig publiceras utan tillåtna, verifierbara källor. En tidigare officiell annonsering får bara ligga kvar om dess framtida lansering, öppna ansökan, deadline eller datum fortfarande är relevant nu.

- aiRoadmap: Endast en kommande modellförmåga som leverantören själv har officiellt annonserat eller satt på offentlig roadmap. Kräv minst en primärkälla från leverantören efter källgranskningen. Rykten, läckor, prognoser och "det ryktas" ska bort. kind=ai_roadmap; status=officially_announced eller official_roadmap.
- businessOpportunities: Endast en konkret upphandling, partnerskapsöppning, program, marknadsöppning eller ansökningsmöjlighet med en faktisk nästa handling. Ingen allmän marknadstrend och inget investeringsråd. kind=business_opportunity; status=announced, open eller deadline.
- contexts: Endast en verifierad konferens, deadline, ett möte eller digitalt sammanhang med datum och fysisk plats eller exakt "Digitalt". Ta med det bara om det matchar profilens intressen eller affärsmöjligheter. kind=context; status=upcoming, registration_open eller deadline.

För varje post: whatChanged är det verifierade faktumet, whyRelevant är den direkta profillänken och nextStep är en konkret handling eller "Ingen åtgärd behövs nu." Var försiktig med framtida datum: skriv bara datum som källan faktiskt anger. Om en sektion saknar en relevant, verifierad post ska status=none_relevant, items=[] och summary vara exakt "Ingen relevant post." Om källkontrollen inte går ska status=unavailable, items=[] och summary förklara begränsningen. Radarposter får aldrig innehålla köp-, sälj- eller värderingsråd.`
    : "\nFör detta bevaknings- eller specialbriefpass ska strategicRadar vara null.";
  return `Du är det andra, redaktionella steget i ett privat omvärlds- och beslutsstöd. Bedöm kandidaterna från discovery sedan ${input.coverageFrom}; sök och verifiera vid behov själv med webbsökning. ${purpose}

En publicerad post kräver normalt minst en relevant primärkälla eller två oberoende, trovärdiga sekundärkällor. Sociala medier och opinionsmaterial kan aldrig räcka. Markera shouldPublish=false om bevisningen är otillräcklig. Matcha mot befintligt händelseregister; samma verkliga händelse får inte bli en ny post bara för att flera medier skrev om den.

 Sätt materialChange=true endast när status, villkor, ikraftträdandedatum, konsekvens eller verifieringsläge faktiskt förändrats. Om status inte ändras ska updateKind förklara varför och materialFacts innehålla den nya observerbara faktan. Använd aldrig en omskrivning av termsSummary eller personligt språk i shortTermImpact/longTermImpact som skäl för materialChange. termsSummary är neutral lästext; materialFacts är den stabila faktavektorn. Observera att händelseregistret är globalt: en bevakningsloop eller en annan brief kan redan ha uppdaterat dess nuvarande status, utan att användaren har fått just denna förändring i den här briefen. Om discovery-kandidaten med källor visar en verklig förändring inom täckningsperioden får du därför inte sätta materialChange=false enbart för att den aktuella registerposten redan visar samma status. Beskriv aldrig ett förslag som undertecknat eller antaget. Sätt verified=true endast om källunderlaget räcker oberoende av användarens relevanströskel: en relevant primärkälla eller två oberoende trovärdiga sekundärkällor. shouldPublish är din redaktionella rekommendation om plats i briefen; servern gör sedan det slutliga urvalet.

Poängsätt varje faktor 0–100: personlig exponering 30 %, materiell betydelse 25 %, handlingsbarhet 20 %, bekräftelsegrad 15 %, tidskritikalitet 10 %. SystemicOverride får bara användas för en verifierad, extremt betydelsefull global händelse och kräver materiality minst 90. Recommendation är endast act, monitor eller no_action — aldrig värdepappersråd. Håll assessment till högst två korta meningar och watchlist till högst tre verkliga väntade beslut/statusbyten.

SPRÅK OCH PRIORITERING
Skriv för en upptagen person som ska kunna fatta ett beslut på under två minuter.
${directSwedishBriefPolicy}

FÄLTSPECIFIKT
- title: en saklig rubrik som namnger den faktiska ändringen, inte ett dramatiskt inslag eller en fråga.
- whatChanged: börja med det verifierade faktumet. Högst en kort mening i standardbrief; högst två i deep. Ta med datum, omfattning eller villkor bara om det ändrar beslutet.
- whyRelevant: börja med den faktiska kopplingen: "Det påverkar..." när följden är direkt, eller "Det kan påverka... om ..." när ett konkret villkor återstår. Högst en kort mening i standardbrief.
- shortTermImpact: recommendation=act ska börja med ett exakt handlingsverb, till exempel "Kontrollera ... före ...". recommendation=monitor ska börja "Ingen åtgärd nu." och ange den konkreta signal systemet följer. recommendation=no_action ska vara "Ingen åtgärd behövs nu." Högst en mening.
- longTermImpact: skriv bara en konkret möjlig senare följd som stöds av händelsen. Börja "På sikt:" och använd villkorsform endast när villkoret anges.
- assessment: svara först på "vad behöver jag veta?", sedan "vad påverkar mig?" och sist om någon handling krävs. Ingen hälsning, metodbeskrivning eller sammanfattning av systemets arbete. Högst två korta meningar.
- watchlist: skriv bara verkliga kommande beslut, datum eller statusbyten. Ange vad som väntas och när om det är känt; aldrig en allmän fråga att "hålla koll på".
- worldPulse: headline ska vara ett kort faktabesked. summary ska säga vad som faktiskt ändrats eller vad som inte hittats i det avgränsade underlaget. implication ska säga vad användaren gör eller inte gör nu. Undvik dramatisering av krig, politik eller marknadsläge.

Vid briefDepth=short: håll varje fritextfält till en eller två korta meningar. Vid deep får endast nödvändig konsekvensförklaring bli längre; det får aldrig bli ett nyhetsflöde.

Profil: ${JSON.stringify(profileSummary)}
Möjliga matchningar från händelseregistret (använd id när det är samma händelse; listan är endast kandidatmatchningar): ${JSON.stringify(input.existingEvents)}
Återkopplingsmönster från användaren (samma relevans kan bero på land, företag, regeltyp eller effekt): ${JSON.stringify(input.feedback ?? [])}
Den här briefens särskilda uppdrag: ${input.briefInstructions?.trim() || "Använd användarens övergripande profil."}
Synlig personlig exponeringsprofil är auktoritativ för personlig relevans. personalContext.interests och personalContext.opportunities är uttryckliga urvalssignaler för händelser och den strategiska radarn. Anta inte namn, yrke, teknik eller särskilda geografier om de inte framgår av profilen. Använd den för varför det berör användaren, aldrig för att sänka beviskraven: ${JSON.stringify(input.personalContext ?? {})}
Aktiva källregler för denna körning (prioritet, ämnesfilter, frekvens och roller är bindande; källor som bara har citeringsroll får aldrig ensamma räcka för verified=true): ${input.sourcePolicyGuidance ?? "[]"}
${eventStatusGuide}
${worldPulseInstruction}
${weeklyRecapInstruction}
${strategicRadarInstruction}

Skriv all fri text på tydlig svenska.`;
}

export function editorialInput(
  candidates: CandidateEvent[],
  worldPulseScan: WorldPulse | null = null,
  weeklyRecapContext: WeeklyRecapSelectionContext | null = null,
  strategicRadarScan: StrategicRadar | null = null,
): string {
  return `Pröva följande discovery-underlag. Returnera ett beslut för varje kandidat, även avvisade kandidater.\n${JSON.stringify({ candidates, worldPulseScan, weeklyRecapContext, strategicRadarScan })}`;
}
