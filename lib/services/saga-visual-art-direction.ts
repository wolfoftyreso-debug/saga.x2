import "server-only";

import type { SagaSafeVisualMetaphor } from "@/lib/services/saga-creative-safety";

/**
 * SAGA's image art direction is deliberately finite and server-owned. It
 * gives generated media a recognisable, editorial character without letting
 * a free-form user prompt turn into an uncontrolled image instruction.
 *
 * The system asks for a documentary *feeling*, never for a false claim that
 * an invented image records a real event.
 */
export const SAGA_VISUAL_ART_DIRECTION_VERSION = "saga-visual-art-direction/v1" as const;

export const SAGA_DOCUMENTARY_RENDERING = {
  visualCharacter: "documentary_restraint",
  light: "Mjukt naturligt dagsljus eller dämpat befintligt kvällsljus; inga hårda studioblixtar.",
  colour: "Återhållen, naturlig färg och varm-neutral vitbalans utan överdriven HDR eller mättnad.",
  texture: "Synlig, vardaglig materialkänsla och mycket lätt analogt korn; lämna små naturliga ojämnheter intakta.",
  finishing: "Diskret toning och korn kan användas, men aldrig hudretusch, omformning, skönhetsreklam-estetik eller syntetisk perfektion.",
} as const;

export type SagaDocumentaryRendering = typeof SAGA_DOCUMENTARY_RENDERING;

type SagaVisualConceptDirection = {
  label: string;
  /** Nature is the first visual layer. Category/product cues come second. */
  natureScene: string;
  /** A small non-verbal cue that may allude to the post's concept. */
  physicalNarrativeDetail: string;
};

/**
 * The mapping is intentionally closed. A concept can receive a tiny physical
 * detail, but it cannot ask a model to render a slogan, a branded mark, or a
 * literal claim in sand, wood, frost, etc.
 */
export const SAGA_NATURE_FIRST_CONCEPT_DIRECTIONS = {
  calendar_turn: {
    label: "Årstidsskifte",
    natureScene: "Första morgonfrosten över gräs, löv och en enkel träyta vid en lugn skogskant eller stig.",
    physicalNarrativeDetail: "En liten, avbruten cirkel eller båge dragen i frosten på omålat trä — abstrakt, diskret och utan bokstäver eller siffror.",
  },
  day_to_evening: {
    label: "Tid som glider mot kväll",
    natureScene: "En stilla naturstig eller strandkant där eftermiddagsljus övergår till mjuk kvällston.",
    physicalNarrativeDetail: "En kort, handdragen slinga i fuktig sand som fångar sidoljuset — ett abstrakt tidsstreck, aldrig läsbar skrift.",
  },
  tread_transition: {
    label: "Säsongens skifte",
    natureScene: "Fuktig naturmark med sand, småsten och löv där årstidens skifte märks i material och ljus.",
    physicalNarrativeDetail: "Två grunda, oregelbundna spår i sanden som övergår mjukt i naturens egen yta; inga varumärken, bokstäver eller perfekta mönster.",
  },
  prepared_shelf: {
    label: "Lugn och ordning",
    natureScene: "En väderbiten träyta nära ett öppet förråd eller en stilla gård med mjuk grönska i bakgrunden.",
    physicalNarrativeDetail: "Ett litet, icke-läsbart hackmönster i väderbitet trä som antyder ordning och förberedelse utan att bli en symbol eller text.",
  },
} as const satisfies Record<SagaSafeVisualMetaphor, SagaVisualConceptDirection>;

export type SagaVisualArtDirectionPolicy = {
  version: typeof SAGA_VISUAL_ART_DIRECTION_VERSION;
  /** The finite, editorial concept selected by Creative Safety. */
  concept: SagaSafeVisualMetaphor;
  naturePriority: "nature_first";
  rendering: SagaDocumentaryRendering;
  conceptDirection: Readonly<SagaVisualConceptDirection>;
  restrictions: readonly string[];
  /** Provider-ready instruction text containing only server-owned directions. */
  instructions: string;
};

/**
 * Build a provider-ready art-direction policy only from the already-approved
 * finite visual metaphor. Raw post copy and custom visual direction never
 * enter this function or its output.
 */
export function buildSagaVisualArtDirectionPolicy(
  concept: SagaSafeVisualMetaphor,
): SagaVisualArtDirectionPolicy {
  const conceptDirection = SAGA_NATURE_FIRST_CONCEPT_DIRECTIONS[concept];
  const restrictions = [
    "Ingen läsbar text, bokstäver, siffror, skyltar, rubriker eller handskrivna ord.",
    "Ingen logotyp, vattenstämpel, QR-kod, märkt produkt, varumärkesdetalj eller falsk skärmbild.",
    "Ingen CGI-, 3D-render-, beauty-ad-, stockpose-, hyperpolerad eller blank produktreklamsestetik.",
    "Utge aldrig bilden för att dokumentera en specifik verklig händelse, nyhet eller faktisk kundsituation.",
  ] as const;

  return {
    version: SAGA_VISUAL_ART_DIRECTION_VERSION,
    concept,
    naturePriority: "nature_first",
    rendering: SAGA_DOCUMENTARY_RENDERING,
    conceptDirection,
    restrictions,
    instructions: [
      `SAGA Visual Art Direction v1 — koncept: ${conceptDirection.label}.`,
      "Prioritera natur, väder, material och platskänsla som bildens huvudmotiv. Produkt- eller branschdetaljer får bara vara ett lågmält, sekundärt sammanhang när de behövs för konceptet.",
      `Naturmotiv: ${conceptDirection.natureScene}`,
      `Narrativ detalj: ${conceptDirection.physicalNarrativeDetail}`,
      `Bildkänsla: ${SAGA_DOCUMENTARY_RENDERING.light} ${SAGA_DOCUMENTARY_RENDERING.colour} ${SAGA_DOCUMENTARY_RENDERING.texture} ${SAGA_DOCUMENTARY_RENDERING.finishing}`,
      "Bilden är en illustrativ redaktionell tolkning, inte dokumentation av en specifik verklig händelse.",
      ...restrictions,
    ].join("\n"),
  };
}

/**
 * Small convenience seam for text-generation systems that need to prepare a
 * safe `imagePrompt` field. It intentionally returns only the finite,
 * server-owned doctrine — never the source article, custom copy or a CTA.
 */
export function sagaVisualDirectionForImagePrompt(
  concept: SagaSafeVisualMetaphor,
): string {
  return buildSagaVisualArtDirectionPolicy(concept).instructions;
}

/**
 * Use this when content generation has not yet selected a Creative Safety
 * metaphor. It holds the same visual doctrine but deliberately refuses to
 * invent a scene-specific sand, wood, frost or product detail.
 */
export function sagaDocumentaryImagePromptBaseline(): string {
  const restrictions = [
    "Ingen läsbar text, bokstäver, siffror, skyltar, rubriker eller handskrivna ord.",
    "Ingen logotyp, vattenstämpel, QR-kod, märkt produkt, varumärkesdetalj eller falsk skärmbild.",
    "Ingen CGI-, 3D-render-, beauty-ad-, stockpose-, hyperpolerad eller blank produktreklamsestetik.",
    "Utge aldrig bilden för att dokumentera en specifik verklig händelse, nyhet eller faktisk kundsituation.",
  ] as const;

  return [
    "SAGA Visual Art Direction v1 — generisk bildbaslinje.",
    "Prioritera natur, väder, material och platskänsla framför perfekta produkt- eller reklambilder.",
    `Bildkänsla: ${SAGA_DOCUMENTARY_RENDERING.light} ${SAGA_DOCUMENTARY_RENDERING.colour} ${SAGA_DOCUMENTARY_RENDERING.texture} ${SAGA_DOCUMENTARY_RENDERING.finishing}`,
    "Bilden är en illustrativ redaktionell tolkning, inte dokumentation av en specifik verklig händelse.",
    ...restrictions,
  ].join("\n");
}
