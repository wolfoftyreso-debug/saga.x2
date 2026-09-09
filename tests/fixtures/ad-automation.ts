export function validAdCreativeBrief(overrides: Record<string, unknown> = {}) {
  return {
    format: "paid_social" as const,
    hook: "En enkel start på bilaffären.",
    value: "Visa ett tydligt nästa steg och relevant kundnytta.",
    offer: {
      copy: "Provkörning bokas direkt hos Sätra Elbilshus.",
      terms: "Med reservation för tillgängliga tider.",
      verification: { status: "unverified" as const, sourceReference: "" },
    },
    callToAction: "Boka en provkörning i Sätra.",
    visualMetaphor: "day_to_evening" as const,
    customVisualDirection: "Lugn provkörning vid Sätra med varm kvällsbelysning.",
    ...overrides,
  };
}

export function validAdAutomationInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "Sätra – provkörningsannons",
    active: false,
    workflow: {
      trigger: { kind: "manual" as const, summary: "Redaktionen startar testet." },
      creative: {
        objective: "leads" as const,
        mediaSource: "mixed" as const,
        creativeBrief: validAdCreativeBrief(),
      },
      review: { required: true as const },
      schedule: {
        mode: "manual" as const,
        timezone: "Europe/Stockholm",
        weeklyCount: null,
        weekdays: [],
        localTimes: [],
        cronExpression: null,
        startsOn: null,
        endsOn: null,
      },
      destinations: [{
        id: "meta-provkorningskampanj",
        provider: "meta_ads" as const,
        label: "Meta Ads – provkörning",
        campaignName: "Provkör Sätra",
        destinationUrl: "https://example.test/provkorn",
      }],
    },
    ...overrides,
  };
}

export const adAutomationCreateIdempotencyKey = "77777777-7777-4777-8777-777777777777";

export function validAdAutomationCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    ...validAdAutomationInput(),
    createIdempotencyKey: adAutomationCreateIdempotencyKey,
    ...overrides,
  };
}
