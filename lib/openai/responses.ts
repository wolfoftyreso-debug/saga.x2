import type { ResponseFormatTextJSONSchemaConfig } from "openai/resources/responses/responses";
import { discoveryResultSchema, editorialResultSchema, type DiscoveryResult, type EditorialResult } from "@/lib/domain/types";
import { getAllowedDomains, getOpenAIClient, getOpenAIModel } from "@/lib/openai/client";
import { discoveryResponseFormat, editorialResponseFormat } from "@/lib/openai/schemas";

export type ModelCallMetadata = {
  responseId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  webSearchCalls: number;
  /** URLs actually returned by the web-search tool, never model-invented URLs. */
  webCitationUrls: string[];
};

async function callStructured(
  instructions: string,
  input: string,
  format: ResponseFormatTextJSONSchemaConfig,
  allowedDomains?: string[],
): Promise<{ payload: unknown; metadata: ModelCallMetadata }> {
  const client = getOpenAIClient();
  const response = await client.responses.create({
    model: getOpenAIModel(),
    store: false,
    instructions,
    input,
    max_output_tokens: 18_000,
    // A structured discovery/editorial answer without a web search has no
    // verifiable provenance and is therefore not a valid publication input.
    tool_choice: "required",
    tools: [
      {
        type: "web_search",
        search_context_size: "high",
        filters: { allowed_domains: allowedDomains ?? getAllowedDomains() },
        user_location: { type: "approximate", country: "SE", timezone: "Europe/Stockholm" },
      },
    ],
    text: { format },
  });

  if (response.status !== "completed" || !response.output_text) {
    throw new Error(`Modellsvar kunde inte slutföras (${response.status ?? "okänt status"}).`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.output_text);
  } catch {
    throw new Error("Modellen returnerade inte giltig JSON trots strikt schema.");
  }

  const usage = response.usage;
  return {
    payload,
    metadata: {
      responseId: response.id,
      model: response.model,
      inputTokens: usage?.input_tokens ?? null,
      outputTokens: usage?.output_tokens ?? null,
      cachedTokens: usage?.input_tokens_details?.cached_tokens ?? null,
      webSearchCalls: response.output.filter((item) => item.type === "web_search_call").length,
      webCitationUrls: extractWebCitationUrls(response.output as unknown[]),
    },
  };
}

function extractWebCitationUrls(output: unknown[]): string[] {
  const results = new Set<string>();
  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text" || !Array.isArray(content.annotations)) continue;
      for (const annotation of content.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation" || typeof annotation.url !== "string") continue;
        const normalized = normalizeWebCitationUrl(annotation.url);
        if (normalized) results.add(normalized);
      }
    }
  }
  return [...results];
}

export function normalizeWebCitationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    const normalized = url.toString();
    return normalized.endsWith("/") && url.pathname === "/" && !url.search ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function runDiscovery(instructions: string, allowedDomains?: string[]): Promise<{ result: DiscoveryResult; metadata: ModelCallMetadata }> {
  const response = await callStructured(instructions, "Sök nu brett och returnera kandidater enligt schemat.", discoveryResponseFormat, allowedDomains);
  return { result: discoveryResultSchema.parse(response.payload), metadata: response.metadata };
}

export async function runEditorial(input: {
  instructions: string;
  candidatesJson: string;
  allowedDomains?: string[];
}): Promise<{ result: EditorialResult; metadata: ModelCallMetadata }> {
  const response = await callStructured(input.instructions, input.candidatesJson, editorialResponseFormat, input.allowedDomains);
  return { result: editorialResultSchema.parse(response.payload), metadata: response.metadata };
}
