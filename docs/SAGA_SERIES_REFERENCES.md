# SAGA Series References

`/api/saga/series` is the Vercel/Neon control plane for a workspace-owned
editorial series. A series is a frozen example post, plus fixed editorial
controls. It is not an automation, calendar job, delivery rule, provider
connection, or model run.

## API contract

All routes derive `workspaceId` and user identity from the signed server
session. A request containing `workspaceId` or `workspace_id` at any nesting
level is rejected with `422`.

| Method | Request | Success response |
| --- | --- | --- |
| `GET /api/saga/series` | none | `{ "series": SagaSeriesReference[] }` |
| `POST /api/saga/series` | `{ slug, name, active?, referenceDraftId, controls }` | `201 { "series": SagaSeriesReference }` |
| `PATCH /api/saga/series` | `{ id, expectedRevision, slug?, name?, active?, referenceDraftId?, controls? }` | `{ "series": SagaSeriesReference }` |
| `DELETE /api/saga/series` | `{ id, expectedRevision }` | `{ "deleted": { "id": string } }` |

`PATCH` and `DELETE` require the last observed `expectedRevision`. A stale
write receives `409 conflict`; a missing actor-owned series receives `404`.
Every response is `Cache-Control: no-store` and `X-Robots-Tag: noindex`.

The response keeps controls top-level for the editor surface:

```ts
type SagaSeriesReference = {
  id: string;
  slug: string;
  name: string;
  active: boolean;
  revision: number;
  reference: {
    revision: number;
    sourceDraftId: string;
    sourceDraftRevision: number;
    contentType: "social_post" | "newsletter" | "article";
    title: string;
    body: string;
    channels: ("facebook_page" | "instagram" | "linkedin" | "newsletter")[];
    media: Array<{
      kind: "upload" | "generated" | "derived";
      contentType: string;
      width: number | null;
      height: number | null;
      altText: string | null;
      status: "processing" | "ready" | "failed" | "deleted";
    }>;
    capturedAt: string;
  };
  controls: {
    objective: "educate" | "inspire" | "convert" | "community";
    audience: string; // 1–160 characters
    tone: "direct" | "warm" | "insightful";
    requiredElements: string[]; // maximum 6
    forbiddenElements: string[]; // maximum 6
    defaultChannels: ("facebook_page" | "instagram" | "linkedin" | "newsletter")[];
    reviewRequired: true;
  };
  createdAt: string;
  updatedAt: string;
};
```

Cadence, schedule, variation count and destination selection belong to
Automation/Distribution, not a Series Reference. `reviewRequired` cannot be
disabled.

## Database invariants

Migration `202608250016_neon_saga_series_references.sql` creates:

- `saga_series_references`: workspace-local identity and current revision.
- `saga_series_reference_revisions`: append-only snapshots.
- a database trigger that refuses updates to a snapshot row.
- a database trigger that refuses an active series without its current
  immutable snapshot.

`POST` reads the eligible Studio draft server-side. It requires a non-empty
title and body and a status of `draft`, `in_review`, `approved`, `scheduled`,
or `published`. The browser never sends reference copy, media metadata, a
workspace ID, or a storage locator.

The snapshot stores at most 12 media entries, each containing exactly
`kind`, `contentType`, `width`, `height`, `altText`, and `status`. Blob URLs,
Blob paths, hashes, raw metadata, credentials, provider configuration and
filenames are not persisted or returned.

## Server-only readers

`lib/neon/saga-series-reference-repository.ts` exposes two actor-scoped
readers:

- `getSagaSeriesReferenceContext(actor, seriesId)` returns an active series'
  identity/revision plus frozen reference and controls for server orchestration.
- `getSagaSeriesReferenceGuidanceContext(actor, seriesId)` returns only
  `{ reference, controls }`, compatible with
  `resolveSagaSeriesReferenceContext` in the Series guidance service.

Both return `null` for inactive or missing series. Neither reader fetches a
URL, returns a Blob locator, calls a model, schedules work, creates a draft,
or delivers content.
