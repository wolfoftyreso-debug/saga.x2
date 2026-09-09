# SAGA Brand Onboarding

Every new Content Engine brand is created through one Vercel/Neon onboarding
boundary. The boundary writes the canonical `content_engine_brand_profiles`
record, one current annual plan, its deterministic budget decision support and
an immutable revision together. It does **not** publish, spend, fetch market
data, predict business outcomes, or call AI while saving.

## Lifecycle

1. `POST /api/saga/brand-onboarding` creates an inactive canonical profile and
   its onboarding document atomically.
2. `completionState: "completed"` activates the profile only after the plan,
   budget scenario and revision exist in the same database transaction.
3. `completionState: "in_progress"` keeps the profile inactive. A completed
   profile can be deliberately returned to in-progress; it is deactivated in
   the same revisioned update.
4. Generic `POST /api/content-engine` now rejects `brandProfile` creation.
   Generic `PATCH /api/content-engine` still edits an existing profile, but a
   database guard will not allow activation without completed onboarding.

Legacy active profiles are deactivated by migration `202608260022` because no
annual plan exists for them. Their identity remains editable; completing the
onboarding activates them again.

## API

All endpoints derive actor and workspace from the signed HttpOnly session.
Request bodies must not contain `workspaceId`, `userId`, profile identifiers,
`active`, `isDefault`, credentials, accounts, publishing or delivery fields.

| Method | Route | Request | Result |
| --- | --- | --- | --- |
| `GET` | `/api/saga/brand-onboarding` | — | `{ onboardings, calculationVersion }` overview only |
| `POST` | `/api/saga/brand-onboarding` | `SagaBrandOnboardingCreateInput` | `{ onboarding, reused }`, `201` or idempotent `200` |
| `GET` | `/api/saga/brand-onboarding/:brandProfileId` | — | `{ onboarding }` |
| `PATCH` | `/api/saga/brand-onboarding/:brandProfileId` | `SagaBrandOnboardingUpdateInput` | `{ onboarding }` |
| `POST` | `/api/saga/brand-onboarding/advice` | `{ draft }` | `{ advice, saved: false }` |

Creation needs a UUID `createIdempotencyKey`. Updating needs the last returned
`expectedRevision`; the full brand and plan replace together. A stale revision
returns `409` and changes nothing.

### Brand input

`brand` is the existing Content Engine profile payload without lifecycle
flags:

```ts
{
  slug: string,
  name: string,
  organizationName: string,
  summary: string,
  defaultLanguage: "sv" | string,
  voice: {
    positioning: string,
    audience: string,
    toneTraits: string[],
    vocabulary: string[],
    avoidPhrases: string[],
    writingSamples: string[],
  },
  profileConfig: Record<string, unknown>,
}
```

`profileConfig` follows Content Engine’s no-secrets rule. API keys, tokens,
passwords and credentials are rejected before Neon.

### Annual plan input

```ts
{
  planYear: number,
  primaryObjective:
    | "awareness" | "demand_creation" | "demand_capture"
    | "conversion" | "retention" | "positioning",
  objectiveStatement: string,
  objectives: [{
    id: string,
    kind: /* one of the objective values above */,
    statement: string,
    measurement: {
      metric: string,
      unit: "count" | "percent" | "currency" | "index" | "custom",
      baseline: number | null,
      target: number | null,
      provenance: "historical_measurement" | "user_estimate" | "unknown",
    },
  }],
  audience: {
    description: string,
    geography: string,
    sizeEvidence: "unknown" | "estimated" | "measured",
  },
  marketContext: {
    productReadiness: "not_ready" | "early" | "ready" | "proven",
    demandEvidence: "unknown" | "hypothesis" | "customer_signal" | "repeatable_demand",
    historicalPerformance: "none" | "partial" | "reliable",
    conversionMeasurement: "none" | "basic" | "reliable",
    competitiveContext: "unknown" | "working_assumption" | "researched",
    timingConfidence: "unknown" | "working_assumption" | "researched",
  },
  channels: Array<
    "organic_social" | "paid_social" | "search" | "email" | "website"
    | "direct_mail" | "print" | "events" | "partners"
  >,
  activity: {
    alwaysOn: boolean,
    campaignBurstsPerYear: number,
    contentPiecesPerMonth: number,
    reviewCadence: "monthly" | "quarterly",
    seasonalWindows: [{
      label: string,
      startMonth: 1..12,
      endMonth: 1..12,
      importance: "supporting" | "primary",
      rationale: string,
    }],
  },
  budget: {
    currency: "SEK" | string,
    status: "unknown" | "provisional" | "confirmed",
    annualBudgetMinor: integer,
    fixedCommitmentsMinor: integer,
    allocationIntent: "balanced" | "learning_first" | "demand_capture" | "reach_building",
  },
}
```

The primary objective must be represented by an objective. Objectives, channels
and seasonal windows are unique; seasonal windows cannot overlap. A completed
onboarding requires a provisional or confirmed budget. An unknown budget must
use zero amounts and stays in-progress.

## Decision support, not a forecast

`calculationVersion: "saga-brand-plan-v1"` produces a deterministic scenario
allocation of the **user-declared** flexible budget into production,
distribution, experimentation, measurement and reserve. It also returns
quarterly/monthly cadence, input provenance, assumptions, unknowns,
decision-readiness flags and the exact scope:

```ts
scope: "scenario_allocation_not_outcome_forecast"
outcomeForecast: {
  available: false,
  reason: "no_historical_outcome_data_or_external_market_model",
}
```

The percentage weights are internal planning heuristics, made visible in the
returned decision support. They are not marketing laws, benchmarks or promises
about reach, sales, CAC, ROAS or conversion.

## AI adviser

`POST /api/saga/brand-onboarding/advice` accepts the same validated document
under `draft`, performs no database write and returns `saved: false`. It uses
only Vercel AI Gateway (a direct `OPENAI_API_KEY` is never a fallback), calls
the Responses API with `store: false`, and has no web-search, scheduling,
advertising, publishing or delivery tool.

The server—not the model—returns supplied facts, assumptions and unknowns from
the deterministic calculation. The model may provide bounded recommendations
and questions but is instructed not to invent external market facts or make
outcome forecasts. Missing Gateway/OIDC configuration returns a truthful
`503 ai_gateway_not_configured` and saves nothing.
