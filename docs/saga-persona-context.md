# SAGA private persona context

`/api/saga/persona-context` is a private, self-described presence profile for
the signed workspace owner. It is deliberately separate from the existing
editorial relevance profile and the private avatar-reference image flow.

## Data boundary

The owner may voluntarily store a short self-description, height, clothing,
environments, visual countries, interests, work, roles, organisations,
display-only homepage links, and optional political, religious, origin and
birth-country context.

Nothing is inferred from an image, website, prompt, model response, or another
SAGA record. `not_specified` is the default for political and religious context;
it is not treated as neutral. A `self_described` stance requires a voluntary
description. The record is owner-and-workspace scoped, not shared with editors,
viewers, or another owner in the same workspace.

Political/religious values (including an explicitly chosen `neutral`), origin,
and birth country require a fresh, owner-only
`sensitiveDataStorageConsent` receipt on every save that contains one of those
values. The exact receipt is:

```json
{
  "accepted": true,
  "version": "saga_persona_sensitive_storage_v1"
}
```

It is rejected when sensitive fields are present without it, and is rejected
when no sensitive fields are being saved. The server creates the timestamp and
binds the receipt to the immutable context revision; those receipt details are
not exposed to model, visual, editorial, Cron, or publishing context.

The full record is private and is excluded from publishing, Cron, news,
editorial, and model flows. It never creates an avatar, image, calendar item,
or post when saved.

## API

All routes derive the user and workspace from the signed HttpOnly app session.
They reject nested `workspaceId`, `workspace_id`, `userId`, `user_id`,
`ownerUserId`, and `owner_user_id` values. Responses are `no-store` and
`noindex`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/saga/persona-context` | Read only the current owner’s record. |
| `PUT` | `/api/saga/persona-context` | Full owner-only replacement. Optional `expectedRevision` prevents a stale overwrite. |
| `DELETE` | `/api/saga/persona-context` | Erase the current owner’s record and all revisions. |

`PUT` accepts `SagaPersonaContextInput` from
`lib/domain/saga-persona-context.ts`. Browser code must use the endpoint, not a
database client or a local fallback.

Homepage links are canonical, public HTTPS origins only (for example
`https://example.se/`). The server never fetches them. Credentials, IP literals,
localhost/private hostnames, paths, queries and fragments are rejected so a
profile link cannot become an SSRF target or secret carrier.

## Private visual future seam

`getSagaPersonaPrivateVisualContext()` in
`lib/neon/saga-persona-context-repository.ts` is server-only. It returns
**only** self-described `clothing`, `environments`, and `visualCountries`, and
only after `visualContextConsent: true`.

It deliberately does not select height, biography, work, organisations,
websites, interests, political/religious context, origin, or birth country.
There is no caller or model integration today. Any future use requires a new,
explicitly reviewed implementation; consent alone does not start a model,
create an image, enter the calendar, or publish.

## Retention and deletion

Each save is appended to `saga_persona_context_revisions`, whose rows are
immutable. A sensitive save also writes an immutable owner receipt in
`saga_persona_sensitive_storage_consents`. This creates an accurate edit
history while the record exists. Clearing a profile must therefore call
`DELETE`, never `PUT` an empty object: the parent-row cascade removes every
revision, receipt and sensitive payload.
