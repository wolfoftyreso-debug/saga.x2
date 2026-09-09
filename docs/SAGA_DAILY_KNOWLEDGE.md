# SAGA Daily Knowledge

Daily Knowledge is SAGA's controlled bridge from selected News Core topics to
a small, retained daily evidence bundle. It is a research aid, not an
automation that writes, schedules or delivers content.

```text
selected, allowed SAGA News sources
  → metadata-only source items
  → explicit daily knowledge policy
  → idempotent Neon job + short Vercel Cron lease
  → daily source bundle
  → human chooses whether to use it elsewhere
```

## Hard boundaries

- A workspace must explicitly save `enabled: true`; no policy means no work.
- The selected `sourceIds` are revalidated as active, allowed News Core
  sources in the signed-in workspace, both when the policy is saved and when
  evidence is read. A browser never submits a workspace ID.
- The worker selects only canonical URL, title, existing bounded summary,
  publisher/source metadata and timestamps. It never selects or returns
  `saga_news_source_items.body_text`.
- Each topic needs the configured number of evidence items **and** independent
  publisher domains. Missing evidence completes as a zero-entry receipt, not
  a speculative article.
- There are no fields or routes for prompt, model, draft, image, channel,
  delivery, social publishing or newsletter sending.
- A policy edit changes its revision and cancels queued/leased jobs before an
  old snapshot can write. Jobs are idempotent per policy/local date, leased,
  retried at most three times and removed with their entries after retention.

## API contract

All responses are private, `no-store` and require the signed session.

| Route | Contract |
| --- | --- |
| `GET /api/saga/knowledge/policy` | `{ data: SagaDailyKnowledgePolicy \| null }` |
| `PUT` / `PATCH /api/saga/knowledge/policy` | Full replacement of `{ enabled, timezone, dailyAt, topics, sourceIds, minimumIndependentPublishers, minimumEvidenceItems, maximumEvidenceItems, evidenceWindowHours, retentionDays, expectedRevision? }`; returns `{ data: SagaDailyKnowledgePolicy }`. `workspaceId` is rejected. |
| `GET /api/saga/knowledge/entries?date=YYYY-MM-DD&limit=1..60` | `{ data: SagaDailyKnowledgeEntry[] }` |
| `GET /api/saga/knowledge/runs?limit=1..60` | `{ data: SagaDailyKnowledgeRun[] }` |

An entry has a deterministic headline/summary plus a bounded `evidence` array:
`itemId`, `sourceId`, source name/trust/connector, canonical URL, title,
excerpt, publisher name/domain, language and timestamps. It does not contain
a scraped article body, raw provider response, key, URL query secret or lease
token.

For a first policy save, omit `expectedRevision` because `GET` returned
`data: null`. For every replacement of an existing policy, send the current
response's `revision` as `expectedRevision`. A missing or stale value returns
`409 { code: "conflict" }`; reload the policy before retrying. This prevents
one editor from silently overwriting another editor's source controls.

## Runtime

`/api/cron/tick` runs `runDueSagaDailyKnowledgeWorker` with one bounded job
per tick. The policy's IANA timezone and `dailyAt` determine when its local
date becomes due; an idempotency key of
`saga-daily-knowledge:<policy-id>:<local-date>` ensures one job per day.

The Cron response exposes a `dailyKnowledge` operational summary marked
`metadataOnly: true`, `draftsCreated: 0` and `noPublication: true`.

## Deployment

Run `202608260024_neon_saga_daily_knowledge.sql` after migration 023 and
before enabling a policy. It uses only Neon and Vercel Cron; it adds no new
environment variable and does not require Supabase, a model provider or an
outbound API credential.
