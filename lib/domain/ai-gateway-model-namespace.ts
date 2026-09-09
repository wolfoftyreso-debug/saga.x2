import type { AiGatewayLabProvider } from "@/lib/domain/ai-gateway-content-lab";

/** Gateway namespaces are transport identifiers, not SAGA's persisted providers. */
const GATEWAY_PROVIDER_NAMESPACES: Record<AiGatewayLabProvider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  xai: "spacexai",
};

export function aiGatewayProviderNamespace(provider: AiGatewayLabProvider): string {
  return GATEWAY_PROVIDER_NAMESPACES[provider];
}

/** Keep existing xai/Grok profiles usable without changing their saved identity. */
export function normalizeAiGatewayModelNamespace(provider: string, modelId: string): string {
  return provider === "xai" && modelId.startsWith("xai/")
    ? `spacexai/${modelId.slice("xai/".length)}`
    : modelId;
}

export function isAiGatewayModelForProvider(provider: string, modelId: string): boolean {
  if (!Object.hasOwn(GATEWAY_PROVIDER_NAMESPACES, provider)) return false;
  const canonical = normalizeAiGatewayModelNamespace(provider, modelId);
  return /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._:-]{0,260}$/.test(canonical)
    && canonical.startsWith(`${GATEWAY_PROVIDER_NAMESPACES[provider as AiGatewayLabProvider]}/`);
}
