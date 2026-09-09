# SAGA Adobe-simple authoring

This vertical is a private writing workflow for turning one saved Studio draft
into a small, reviewable series. It is intentionally separate from Studio
automation, calendar moves, media creation and all delivery providers.

## Boundary

The browser may send a saved reference draft ID, its last seen revision, a
writing goal, a writing instruction, an optional request to use the signed-in
profile display name, a bounded candidate count, and Daily Knowledge entry
IDs. It never sends a workspace, user, reference body, knowledge summary,
source URL, model, provider token, schedule, publication instruction or an
arbitrary author name.

At creation Neon snapshots the actor-scoped Studio reference and the selected,
unexpired Daily Knowledge entry summaries. The run keeps no live URL or
evidence payload, so a later Daily Knowledge retention prune cannot silently
alter requested work.

`includeAuthorName: true` means only “use the current signed-in
`app_users.display_name` if one exists.” It is not an arbitrary author-name
field. If the profile name is empty, the run remains valid but no name is
injected into the model context.

## UI API

All responses have `cache-control: no-store` and are actor/workspace scoped.

### First transient draft

`POST /api/saga/authoring-preview`

Body is the supported generation shape plus opaque Daily Knowledge IDs:

```json
{
  "contentType": "social_post",
  "channels": ["linkedin"],
  "topic": "System som frigör mänsklig tid",
  "brief": "En konkret och ödmjuk vinkel.",
  "voice": "Rak, varm och konkret svenska.",
  "targetLength": "medium",
  "templateInstructions": "",
  "desiredCallToAction": "",
  "avoid": "",
  "imageDirection": "Dokumentärt, naturligt och utan text i bilden.",
  "language": "sv",
  "selectedKnowledgeEntryIds": ["uuid"]
}
```

Response:

```json
{
  "draft": { "title": "...", "body": "..." },
  "quality": { "decision": "review_required", "canCreatePrivateDraft": true, "canDeliver": false },
  "selectedKnowledgeEntryIds": ["uuid"],
  "saved": false,
  "noPublication": true
}
```

It calls Gateway transiently after server-side entry resolution. It does not
write a run, candidate, Studio draft, calendar item, media asset or provider
request.

### Durable series

`POST /api/saga/authoring-runs`

```json
{
  "idempotencyKey": "uuid",
  "referenceDraftId": "uuid",
  "expectedReferenceDraftRevision": 4,
  "objective": "Förklara hur välbyggda system frigör mänsklig tid.",
  "prompt": "Låt resonemanget vara jordnära och konkret.",
  "includeAuthorName": false,
  "selectedKnowledgeEntryIds": ["uuid"],
  "candidateCount": 1
}
```

The `candidateCount` check exists in both Zod and Neon and is always `1..10`.
The same creation idempotency key may only replay the exact same reference,
revision, goal, prompt, name flag, entry IDs and count; a reused key for a
different request returns `409`.

`GET /api/saga/authoring-runs` and `GET /api/saga/authoring-runs/:runId` are
read-only. They return `run.candidates`, `run.revision`, `run.canSelect`, a
read-only `run.generationProgress` object (`total`, `pending`, `completed`,
`queued`, `generating`, `ready`, `blocked`, `failed`, `selected`,
`notSelected`), and the explicit continuation signals:

- `hasPendingWork`: an already requested receipt still has queued or leased
  candidate jobs;
- `canContinue`: the UI may show **Fortsätt produktionen**.

`POST /api/saga/authoring-runs/:runId/generate`

```json
{
  "idempotencyKey": "uuid",
  "expectedRunRevision": 2,
  "retryFailed": false
}
```

This endpoint starts an initial receipt or attaches a fresh post-reload key to
the current active receipt. A durable command maps each idempotency key to one
bounded worker slice: replaying the same key returns current status with zero
new claims, while a fresh key can claim the next explicit slice only when no
other live command lease owns it. An expired command lease is safely reclaimed
by a later explicit request; no cron, GET or polling path performs that
reclaim. Each command claims at most one candidate because the Gateway call has
a bounded Vercel lease. For a run with remaining work, the UI must show an
explicit continuation action and call this endpoint again; polling and cron
never generate the next candidate. The response includes `{ run, receipt,
worker, noPublication:true, studioDraftsCreated:0 }`.

AI output only becomes an immutable private candidate after the production
quality gate passes. Blocked output has a durable `blocked` candidate state;
no placeholder or Studio draft is created. Candidate provenance retains only
the model, response ID, token counts, prompt-policy version and completion
time—never a prompt, source URL or provider raw payload.

`POST /api/saga/authoring-runs/:runId/candidates/:candidateId/select`

```json
{
  "idempotencyKey": "uuid",
  "expectedRunRevision": 3,
  "expectedCandidateRevision": 4
}
```

This is the only materialization step. It atomically creates exactly one
editable Studio draft with `status: "in_review"`, `scheduledAt: null` and
`approvalRequired: true`, then marks the run selected. It cannot schedule,
publish, create media or deliver to a provider.

## Worker and Cron

`runSagaAdobeAuthoringWorker` runs only from the explicit generate route. It
claims a durable Neon job, resolves the actor workspace and snapshots, calls
the configured AI Gateway, runs `assessGeneratedContentQuality`, and writes a
private candidate only if `canCreatePrivateDraft === true`, `decision !==
"blocked"`, and `canDeliver === false`.

The Vercel cron tick intentionally does **not** import this worker. Daily
Knowledge cron refreshes research freshness; it never starts, resumes, selects
or materializes authoring runs.

## Deployment

Apply migrations in order through
`202608260026_neon_saga_adobe_authoring_generation_commands.sql`
after migration 024 (Daily Knowledge). Configure `DATABASE_URL` and the
server-only AI Gateway/OpenAI credentials as described in
`SAGA_AI_GATEWAY_RUNBOOK.md`. No browser key or direct Gateway call is used.
