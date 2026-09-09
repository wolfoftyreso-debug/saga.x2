import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  adAutomationFormFromSaved,
  adAutomationPayload,
  adAutomationsFromPayload,
  builderValidationMessage,
  clearPendingAdAutomationIdempotencyKey,
  OFFER_VERIFICATION_STATUS,
  pendingAdAutomationIdempotencyKey,
  SagaAdAutomationBuilder,
  serializeCreativeValue,
  splitCreativeValue,
  type AdAutomationForm,
} from "@/components/saga-ad-automation-builder";

const form: AdAutomationForm = {
  id: null,
  revision: null,
  name: "Sätra – provkörningsannons",
  active: false,
  trigger: "schedule",
  sourceSummary: "Sparat kampanjunderlag och erbjudande från Sätra Elbilshus.",
  objective: "leads",
  hook: "Redo när det är dags?",
  creativeValue: "Gör nästa steg enkelt och konkret.",
  offerCopy: "Boka en provkörning i Sätra före helgen.",
  offerTerms: "Med reservation för lediga tider.",
  offerSourceReference: "Sparat kampanjunderlag",
  format: "paid_social",
  mediaSource: "mixed",
  callToAction: "Boka en provkörning",
  visualMetaphor: "prepared_shelf",
  customVisualDirection: "Varm verkstadsmiljö med riktiga människor.",
  variantCount: 3,
  weekday: 3,
  localTime: "09:00",
  timezone: "Europe/Stockholm",
  destinationProviders: ["meta_ads", "linkedin_ads"],
  campaignName: "Provkör Sätra",
  destinationUrl: "https://example.test/provkorn",
};

describe("SagaAdAutomationBuilder", () => {
  it("maps the simple canvas into the dedicated durable ad-automation contract", () => {
    const payload = adAutomationPayload(form);

    expect(payload).toMatchObject({
      name: "Sätra – provkörningsannons",
      active: false,
      workflow: {
        trigger: { kind: "schedule" },
        creative: {
          objective: "leads",
          mediaSource: "mixed",
          creativeBrief: {
            format: "paid_social",
            hook: "Redo när det är dags?",
            offer: {
              copy: "Boka en provkörning i Sätra före helgen.",
              verification: { status: "unverified", sourceReference: "Sparat kampanjunderlag" },
            },
            callToAction: "Boka en provkörning",
            visualMetaphor: "prepared_shelf",
          },
        },
        review: { required: true },
        schedule: {
          mode: "weekly_count",
          weeklyCount: 1,
          weekdays: [3],
          localTimes: ["09:00"],
          cronExpression: null,
        },
      },
    });
    expect(payload.workflow.destinations.map((destination) => destination.provider)).toEqual(["meta_ads", "linkedin_ads"]);
    expect(payload.workflow.creative.creativeBrief.value).toContain("Skapa 3 tydligt skilda kreativa annonsvarianter.");
    expect(payload.workflow.creative.creativeBrief.customVisualDirection).toBeUndefined();
    expect(adAutomationPayload({ ...form, trigger: "manual" }).workflow.creative.creativeBrief.customVisualDirection).toBe("Varm verkstadsmiljö med riktiga människor.");
  });

  it("keeps variation count as a transparent persisted production instruction", () => {
    const value = serializeCreativeValue("Gör nästa steg tydligt.", 5);
    expect(value).toBe("Gör nästa steg tydligt.\n\nSkapa 5 tydligt skilda kreativa annonsvarianter.");
    expect(splitCreativeValue(value)).toEqual({ value: "Gör nästa steg tydligt.", variantCount: 5 });
  });

  it("only allows the dedicated scheduled private-brief path to be activated", () => {
    expect(adAutomationPayload({ ...form, active: true }).active).toBe(true);
    expect(adAutomationPayload({ ...form, trigger: "manual", active: true }).active).toBe(false);
    expect(adAutomationPayload({ ...form, trigger: "signal", active: true }).active).toBe(false);
  });

  it("holds create and test keys through an ambiguous retry, then releases only a confirmed receipt", () => {
    const pending: Record<string, string> = {};
    const keys = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const nextKey = () => keys.shift() ?? null;

    expect(pendingAdAutomationIdempotencyKey(pending, "create", nextKey)).toBe("11111111-1111-4111-8111-111111111111");
    expect(pendingAdAutomationIdempotencyKey(pending, "create", nextKey)).toBe("11111111-1111-4111-8111-111111111111");
    expect(pendingAdAutomationIdempotencyKey(pending, "test:automation-a", nextKey)).toBe("22222222-2222-4222-8222-222222222222");

    clearPendingAdAutomationIdempotencyKey(pending, "test:automation-a");
    expect(pending["create"]).toBe("11111111-1111-4111-8111-111111111111");
    expect(pending["test:automation-a"]).toBeUndefined();
  });

  it("hydrates a saved workflow including its revision and unavailable delivery status", () => {
    const [saved] = adAutomationsFromPayload({
      automations: [{
        id: "11111111-1111-4111-8111-111111111111",
        name: form.name,
        active: false,
        revision: 4,
        workflow: adAutomationPayload(form).workflow,
        destinations: [{
          ...adAutomationPayload(form).workflow.destinations[0],
          execution: { status: "unavailable", message: "Meta Ads är inte anslutet." },
        }],
      }],
    });

    expect(saved).toMatchObject({ id: "11111111-1111-4111-8111-111111111111", revision: 4 });
    expect(adAutomationFormFromSaved(saved!)).toMatchObject({ id: saved?.id, revision: 4, variantCount: 3, format: "paid_social" });
    expect(saved?.destinations?.[0]?.execution?.status).toBe("unavailable");
  });

  it("blocks an incomplete flow before it reaches a write route", () => {
    expect(builderValidationMessage({ ...form, offerCopy: "" })).toContain("erbjudandet");
    expect(builderValidationMessage({ ...form, destinationProviders: [] })).toContain("destination");
  });

  it("renders the canvas and a truthful loading state on the server", () => {
    const html = renderToStaticMarkup(createElement(SagaAdAutomationBuilder));

    expect(html).toContain("Bygg ett annonsflöde");
    expect(html).toContain("En fast kedja, tydlig kontroll");
    expect(html).toContain("Läser sparade annonsflöden");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Vad sätter flödet i rörelse?");
    expect(html).toContain("Testa privat utkast");
    expect(html).toContain("Extern leverans: inte tillgänglig");
    expect(html).not.toContain("Publicera annons");
  });

  it("keeps client-supplied offer underlag pending server verification", () => {
    expect(OFFER_VERIFICATION_STATUS).toMatchObject({
      status: "unverified",
      title: "Underlag sparat",
    });
    expect(OFFER_VERIFICATION_STATUS.detail).toContain("Väntar på verifiering");
    expect(adAutomationPayload(form).workflow.creative.creativeBrief.offer.verification.status).toBe("unverified");
  });

  it("keeps the dedicated builder behind its own automation surface", () => {
    const route = readFileSync(resolve(process.cwd(), "app/studio/automations/page.tsx"), "utf8");
    expect(route).toContain("SagaAdAutomationBuilder");
    expect(route).toContain("SagaContentAutomationRuns");
    expect(route).toContain('href="/studio/automations?view=ads"');
    expect(route).toContain('<ContentStudio route="automations" />');
  });
});
