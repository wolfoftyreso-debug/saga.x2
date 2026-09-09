import { afterEach, describe, expect, it } from "vitest";
import { getOpenAIClient, getOpenAIModel, MissingOpenAIConfigurationError } from "@/lib/openai/client";
import { getAiGatewayCredential, isAiGatewayConfigured } from "@/lib/vercel/ai-gateway";

const relevantEnvironment = {
  VERCEL: process.env.VERCEL,
  VERCEL_ONLY: process.env.VERCEL_ONLY,
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY,
  VERCEL_OIDC_TOKEN: process.env.VERCEL_OIDC_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
};

const requestContextSymbol = Symbol.for("@vercel/request-context");
const originalRequestContext = (globalThis as Record<PropertyKey, unknown>)[requestContextSymbol];

afterEach(() => {
  for (const [key, value] of Object.entries(relevantEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (originalRequestContext === undefined) delete (globalThis as Record<PropertyKey, unknown>)[requestContextSymbol];
  else (globalThis as Record<PropertyKey, unknown>)[requestContextSymbol] = originalRequestContext;
});

describe("Vercel AI Gateway boundary", () => {
  it("never falls back to a direct provider key in Vercel-only mode", () => {
    process.env.VERCEL_ONLY = "1";
    delete process.env.VERCEL;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.OPENAI_API_KEY = "retired-direct-provider-key";

    expect(() => getOpenAIClient()).toThrow(MissingOpenAIConfigurationError);
  });

  it("uses the Vercel Function OIDC request context instead of requiring a runtime env value", () => {
    process.env.VERCEL = "1";
    delete process.env.VERCEL_ONLY;
    delete process.env.AI_GATEWAY_API_KEY;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.OPENAI_API_KEY;
    (globalThis as Record<PropertyKey, unknown>)[requestContextSymbol] = {
      get: () => ({ headers: { "x-vercel-oidc-token": "runtime-oidc-token" } }),
    };

    expect(isAiGatewayConfigured()).toBe(true);
    expect(getAiGatewayCredential()).toBe("runtime-oidc-token");
    expect(getOpenAIClient().baseURL).toBe("https://ai-gateway.vercel.sh/v1");
    expect(getOpenAIModel()).toBe("openai/gpt-5.4-mini");
  });
});
