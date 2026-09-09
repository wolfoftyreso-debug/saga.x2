import "server-only";

import OpenAI from "openai";
import { SOURCE_ALLOWLIST } from "@/lib/domain/source-policy";
import { isVercelOnlyMode } from "@/lib/runtime/vercel-only";
import {
  createAiGatewayClient,
  isAiGatewayConfigured,
  MissingAiGatewayConfigurationError,
} from "@/lib/vercel/ai-gateway";

export class MissingOpenAIConfigurationError extends Error {
  constructor() {
    super("AI Gateway saknas. Lokalt: AI_GATEWAY_API_KEY. I Vercel: aktivera Secure Backend Access med OIDC.");
    this.name = "MissingOpenAIConfigurationError";
  }
}

export function getOpenAIClient(): OpenAI {
  if (isAiGatewayConfigured() || isVercelOnlyMode()) {
    try {
      return createAiGatewayClient();
    } catch (error) {
      if (error instanceof MissingAiGatewayConfigurationError) throw new MissingOpenAIConfigurationError();
      throw error;
    }
  }

  // A Vercel deployment never quietly sidesteps the Gateway with a direct
  // provider key. Retired local Brief code may keep its compatibility path,
  // but the production Studio/automation surface must stay on Vercel.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new MissingOpenAIConfigurationError();
  // Direct OpenAI remains a narrow compatibility path while existing Brief
  // jobs move to AI Gateway. New Vercel deployments use the branch above.
  return new OpenAI({ apiKey });
}

export function getOpenAIModel(): string {
  // `isAiGatewayConfigured()` resolves the Vercel Function request-context
  // token as well as the local environment value, so production model IDs
  // retain the required `provider/model` prefix.
  if (isAiGatewayConfigured() || isVercelOnlyMode()) {
    return process.env.AI_GATEWAY_MODEL || "openai/gpt-5.4-mini";
  }
  return process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

export function getAllowedDomains(): string[] {
  const configured = process.env.BRIEF_ALLOWED_DOMAINS
    ?.split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);

  return (configured?.length ? configured : SOURCE_ALLOWLIST).slice(0, 100);
}
