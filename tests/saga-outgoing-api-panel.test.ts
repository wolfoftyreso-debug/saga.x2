import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  safeSagaOutgoingEndpoint,
  sagaOutgoingApiCreatedFromPayload,
  sagaOutgoingApiMessage,
  sagaOutgoingApisFromPayload,
} from "@/lib/client/saga-outgoing-api";
import { SagaOutgoingApiPanel, sagaOutgoingApiCurlCommand } from "@/components/saga-outgoing-api-panel";

const createdAt = "2026-08-26T12:00:00.000Z";

function exportPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Automationsserver",
    contentTypes: ["social_post", "article"],
    visibility: "published_only",
    keyPrefix: "saga_out_live_AbCdEf",
    status: "active",
    expiresAt: null,
    lastUsedAt: null,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

describe("SAGA outgoing content API settings", () => {
  it("keeps endpoint data credential-free before it reaches the browser UI", () => {
    expect(safeSagaOutgoingEndpoint("/api/saga/outgoing-content")).toBe("/api/saga/outgoing-content");
    expect(safeSagaOutgoingEndpoint("https://saga.example/api/saga/outgoing-content")).toBe("https://saga.example/api/saga/outgoing-content");
    expect(safeSagaOutgoingEndpoint("/api/saga/outgoing-content?token=secret")).toBeNull();
    expect(safeSagaOutgoingEndpoint("https://user:secret@saga.example/api")).toBeNull();
    expect(sagaOutgoingApiMessage({ code: "configuration_required", missing: ["DATABASE_URL"] }, "fallback")).toBe(
      "API-exporter kan användas när arbetsytans säkra datalager är redo i Vercel.",
    );
  });

  it("accepts the one-time bearer response while discarding unknown server fields", () => {
    const created = sagaOutgoingApiCreatedFromPayload({
      export: exportPayload({ workspaceId: "must-not-reach-ui" }),
      secret: "saga_out_test_secret",
      endpoint: "/api/saga/outgoing-content",
      databaseUrl: "must-not-reach-ui",
    });
    expect(created).toMatchObject({ api: { name: "Automationsserver", visibility: "published_only" }, bearerToken: "saga_out_test_secret" });
    expect(JSON.stringify(created)).not.toContain("workspaceId");
    expect(JSON.stringify(created)).not.toContain("databaseUrl");
  });

  it("reads only explicit content API records and refuses malformed rows", () => {
    const exports = sagaOutgoingApisFromPayload({
      exports: [exportPayload({ contentTypes: "all" }), exportPayload({ id: "" })],
    });
    expect(exports).toHaveLength(1);
    expect(exports?.[0]?.contentTypes).toEqual(["social_post", "newsletter", "article"]);
  });

  it("creates a copyable bearer cURL command without accidental patch characters", () => {
    const command = sagaOutgoingApiCurlCommand("https://saga.example/api/saga/outgoing-content", "saga_out_live_test");
    expect(command).toContain("Authorization: Bearer saga_out_live_test");
    expect(command).toContain("'https://saga.example/api/saga/outgoing-content'");
    expect(command).not.toContain("+");
  });

  it("renders a read-only export workflow, never legacy feeds or local persistence", () => {
    const html = renderToStaticMarkup(createElement(SagaOutgoingApiPanel));
    const page = readFileSync(resolve(process.cwd(), "app/settings/api/page.tsx"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "components/saga-outgoing-api-panel.tsx"), "utf8");
    const clientAdapter = readFileSync(resolve(process.cwd(), "lib/client/saga-outgoing-api.ts"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "components/saga-outgoing-api-panel.module.css"), "utf8");

    expect(html).toContain("Läsning, aldrig publicering");
    expect(html).toContain("Allt godkänt innehåll");
    expect(html).toContain("Bara publicerat");
    expect(html).toContain("Bearer-nyckeln visas en gång");
    expect(html).toContain("SAGA skickar inga inlägg, mejl eller webhooks");
    expect(page).toContain("SagaOutgoingApiPanel");
    expect(source).toContain('apiPath = "/api/saga/outgoing-apis"');
    expect(source).toContain("Rotera nyckel");
    expect(clientAdapter).toContain("/rotate");
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("/api/v1/");
    expect(source).not.toContain("ApiAccessPanel");
    expect(css).not.toMatch(/font-size:\s*\.(?:[0-6]\d|7[0-4])rem/);
    expect(css).toContain(".dismissButton, .copyValue button, .exportActions button, .loadError button { display: inline-flex; width: fit-content; min-height: 44px;");
    expect(css).toContain(".primaryAction { display: inline-flex; width: fit-content; min-height: 44px;");
  });
});
