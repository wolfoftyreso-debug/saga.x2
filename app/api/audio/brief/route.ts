import { APIConnectionError, AuthenticationError, InternalServerError, RateLimitError } from "openai";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOpenAIClient, MissingOpenAIConfigurationError } from "@/lib/openai/client";
import { isSupabasePublicConfigured, MissingSupabaseConfigurationError } from "@/lib/supabase/config";
import { getAuthenticatedUserId } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BRIEF_TEXT_LENGTH = 4_000;
const TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "marin";
const SUPPORTED_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

const briefSpeechSchema = z
  .object({
    text: z.string().trim().min(1).max(MAX_BRIEF_TEXT_LENGTH),
  })
  .strict();

const SWEDISH_EDITORIAL_INSTRUCTIONS =
  "Du läser en svensk personlig morgonbrief för en företagsledare. Tala varmt, lugnt och precist, som en erfaren redaktör. " +
  "Använd ett naturligt, måttligt tempo, tydlig artikulation och korta pauser mellan avsnitt. " +
  "Betona försiktigt det som kräver handling. Var aldrig dramatisk, säljande eller överdrivet munter. " +
  "Läs exakt den givna texten och lägg inte till en hälsning, förklaring eller avslutning.";

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

function isTextTooLong(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("text" in value)) return false;
  return typeof value.text === "string" && value.text.trim().length > MAX_BRIEF_TEXT_LENGTH;
}

function getConfiguredVoice(): (typeof SUPPORTED_VOICES)[number] | null {
  const voice = process.env.OPENAI_TTS_VOICE?.trim() || DEFAULT_VOICE;
  return SUPPORTED_VOICES.includes(voice as (typeof SUPPORTED_VOICES)[number])
    ? (voice as (typeof SUPPORTED_VOICES)[number])
    : null;
}

export async function POST(request: NextRequest) {
  // A public endpoint with an API key would allow anyone to incur TTS costs.
  if (!isSupabasePublicConfigured()) {
    return errorResponse("Röstbriefen är inte konfigurerad ännu. Försök igen när tjänsten är klar.", 503);
  }

  try {
    const userId = await getAuthenticatedUserId();
    if (!userId) return errorResponse("Logga in för att lyssna på briefen.", 401);
  } catch (error) {
    if (error instanceof MissingSupabaseConfigurationError) {
      return errorResponse("Röstbriefen är inte konfigurerad ännu. Försök igen när tjänsten är klar.", 503);
    }

    return errorResponse("Inloggningen kunde inte verifieras just nu. Försök igen senare.", 503);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Brieftexten måste skickas som giltig JSON.", 400);
  }

  const parsed = briefSpeechSchema.safeParse(body);
  if (!parsed.success) {
    if (isTextTooLong(body)) {
      return errorResponse(`Brieftexten får vara högst ${MAX_BRIEF_TEXT_LENGTH} tecken.`, 413);
    }

    return errorResponse("Brieftexten saknas eller är inte giltig.", 400);
  }

  // Validate every local prerequisite before any paid request is made.
  if (!process.env.OPENAI_API_KEY?.trim()) {
    return errorResponse("Röstbriefen är inte konfigurerad ännu. Försök igen när tjänsten är klar.", 503);
  }

  const voice = getConfiguredVoice();
  if (!voice) {
    return errorResponse("Röstbriefen är felkonfigurerad. Försök igen senare.", 503);
  }

  try {
    const speech = await getOpenAIClient().audio.speech.create({
      model: TTS_MODEL,
      voice,
      input: parsed.data.text,
      instructions: SWEDISH_EDITORIAL_INSTRUCTIONS,
      response_format: "mp3",
    });
    const audio = await speech.arrayBuffer();

    if (!audio.byteLength) {
      return errorResponse("Röstbriefen kunde inte skapas just nu. Försök igen senare.", 502);
    }

    return new Response(audio, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "Content-Length": String(audio.byteLength),
        "Content-Type": "audio/mpeg",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MissingOpenAIConfigurationError || error instanceof AuthenticationError) {
      return errorResponse("Röstbriefen är inte konfigurerad ännu. Försök igen när tjänsten är klar.", 503);
    }

    if (error instanceof RateLimitError) {
      return errorResponse("Rösttjänsten är tillfälligt hårt belastad. Försök igen om en stund.", 429);
    }

    if (error instanceof APIConnectionError || error instanceof InternalServerError) {
      return errorResponse("Rösttjänsten är tillfälligt otillgänglig. Försök igen senare.", 503);
    }

    return errorResponse("Röstbriefen kunde inte skapas just nu. Försök igen senare.", 502);
  }
}
