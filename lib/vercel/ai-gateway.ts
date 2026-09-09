import "server-only";

import { getVercelOidcTokenSync } from "@vercel/oidc";
import OpenAI from "openai";
import type { AiGatewayLabProvider } from "@/lib/domain/ai-gateway-content-lab";
import { aiGatewayProviderNamespace, isAiGatewayModelForProvider, normalizeAiGatewayModelNamespace } from "@/lib/domain/ai-gateway-model-namespace";

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";
const SAGA_IMAGE_GATEWAY_MODEL_ENVIRONMENT_NAME = "SAGA_IMAGE_GATEWAY_MODEL";
const DEFAULT_SAGA_IMAGE_GATEWAY_MODEL = "openai/gpt-image-1.5";
const SAGA_BRAND_ADVISOR_GATEWAY_MODEL_ENVIRONMENT_NAME = "SAGA_BRAND_ADVISOR_GATEWAY_MODEL";
const DEFAULT_SAGA_BRAND_ADVISOR_GATEWAY_MODEL = "openai/gpt-5.4-mini";

const DEFAULT_MODELS: Record<AiGatewayLabProvider, string> = {
  openai: "openai/gpt-5.4",
  anthropic: "anthropic/claude-sonnet-4.6",
  google: "google/gemini-3-flash",
  xai: "spacexai/grok-4.1-fast-non-reasoning",
};

const MODEL_ENVIRONMENT_NAMES: Record<AiGatewayLabProvider, string> = {
  openai: "AI_GATEWAY_LAB_OPENAI_MODEL",
  anthropic: "AI_GATEWAY_LAB_ANTHROPIC_MODEL",
  google: "AI_GATEWAY_LAB_GOOGLE_MODEL",
  xai: "AI_GATEWAY_LAB_XAI_MODEL",
};

export class MissingAiGatewayConfigurationError extends Error {
  constructor() {
    super("AI Gateway är inte konfigurerad. Lokalt krävs AI_GATEWAY_API_KEY; i Vercel aktiverar du Secure Backend Access med OIDC.");
    this.name = "MissingAiGatewayConfigurationError";
  }
}

export class InvalidAiGatewayModelConfigurationError extends Error {
  constructor(provider: AiGatewayLabProvider) {
    super(`${MODEL_ENVIRONMENT_NAMES[provider]} måste vara en ${aiGatewayProviderNamespace(provider)}/-modell i Vercel AI Gateway.`);
    this.name = "InvalidAiGatewayModelConfigurationError";
  }
}

export class InvalidSagaImageGatewayModelConfigurationError extends Error {
  constructor() {
    super(`${SAGA_IMAGE_GATEWAY_MODEL_ENVIRONMENT_NAME} måste vara en openai/gpt-image-...-modell i Vercel AI Gateway.`);
    this.name = "InvalidSagaImageGatewayModelConfigurationError";
  }
}

export class InvalidSagaBrandAdvisorGatewayModelConfigurationError extends Error {
  constructor() {
    super(`${SAGA_BRAND_ADVISOR_GATEWAY_MODEL_ENVIRONMENT_NAME} måste vara en openai/-modell i Vercel AI Gateway.`);
    this.name = "InvalidSagaBrandAdvisorGatewayModelConfigurationError";
  }
}

/**
 * New Vercel surfaces never use a direct provider key as a fallback.
 *
 * `VERCEL_OIDC_TOKEN` is an environment value at build time and in local
 * development, but a Vercel Function receives it through request context as
 * `x-vercel-oidc-token`. The official helper covers both forms. It is called
 * only from an active server request/worker, never at module initialisation.
 */
export function getAiGatewayCredential(): string {
  const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
  if (apiKey) return apiKey;

  let oidcToken = "";
  try {
    oidcToken = getVercelOidcTokenSync().trim();
  } catch {
    // Do not expose request-context details or treat a direct provider key as
    // a Gateway credential. The public error below is deliberately generic.
  }

  const credential = oidcToken;
  if (!credential) throw new MissingAiGatewayConfigurationError();
  return credential;
}

export function isAiGatewayConfigured(): boolean {
  try {
    return Boolean(getAiGatewayCredential());
  } catch {
    return false;
  }
}

/** Names only. An API key is for local use; Production may instead use Vercel OIDC. */
export function missingAiGatewayConfiguration(): string[] {
  return isAiGatewayConfigured() ? [] : ["AI_GATEWAY_API_KEY eller VERCEL_OIDC_TOKEN"];
}

export function createAiGatewayClient(): OpenAI {
  return new OpenAI({
    apiKey: getAiGatewayCredential(),
    baseURL: GATEWAY_BASE_URL,
  });
}

/**
 * Only trusted deployment configuration can change a model. The prefix check
 * preserves the logical provider selected by the user and prevents a browser
 * caller from routing a Claude choice to an arbitrary model string.
 */
export function resolveAiGatewayLabModel(provider: AiGatewayLabProvider): string {
  const configured = process.env[MODEL_ENVIRONMENT_NAMES[provider]]?.trim();
  const model = normalizeAiGatewayModelNamespace(provider, configured || DEFAULT_MODELS[provider]);
  if (!isAiGatewayModelForProvider(provider, model) || model.length > 240) {
    throw new InvalidAiGatewayModelConfigurationError(provider);
  }
  return model;
}

/**
 * Image generation uses the OpenAI-compatible Images API through Vercel AI
 * Gateway. Keep the accepted family deliberately narrow: unlike text models,
 * the service below depends on a base64 image response and PNG output.
 */
export function resolveSagaImageGatewayModel(): string {
  const configured = process.env[SAGA_IMAGE_GATEWAY_MODEL_ENVIRONMENT_NAME]?.trim();
  const model = configured || DEFAULT_SAGA_IMAGE_GATEWAY_MODEL;
  if (!/^openai\/gpt-image-[a-z0-9.-]+$/iu.test(model) || model.length > 240 || /\s/u.test(model)) {
    throw new InvalidSagaImageGatewayModelConfigurationError();
  }
  return model;
}

/**
 * The onboarding adviser is a bounded, private text call. A browser cannot
 * choose this model; an explicit deployment setting may replace the default.
 */
export function resolveSagaBrandAdvisorGatewayModel(): string {
  const configured = process.env[SAGA_BRAND_ADVISOR_GATEWAY_MODEL_ENVIRONMENT_NAME]?.trim();
  const model = configured || DEFAULT_SAGA_BRAND_ADVISOR_GATEWAY_MODEL;
  if (!/^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,260}$/u.test(model) || model.length > 240 || /\s/u.test(model)) {
    throw new InvalidSagaBrandAdvisorGatewayModelConfigurationError();
  }
  return model;
}

export const sagaImageGatewayRuntimeMetadata = {
  gateway: "vercel-ai-gateway",
  api: "openai-images",
  defaultModel: DEFAULT_SAGA_IMAGE_GATEWAY_MODEL,
  stored: false,
} as const;

export const aiGatewayRuntimeMetadata = {
  gateway: "vercel-ai-gateway",
  api: "responses",
  stored: false,
} as const;
