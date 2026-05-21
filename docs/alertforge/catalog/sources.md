# Source adapter catalog

Lists the source adapters available in `packages/sources/`. Each adapter conforms to `SourceAdapter` from `@alertforge/core` (see [source-adapter-contract](../specs/2026-05-21-source-adapter-contract.md)).

This file is the human-readable catalog. The UI's `/sources` page derives the same information from the registry at runtime.

## Active adapters (shipping V1)

### Sentry

| Field | Value |
|---|---|
| Package | `@alertforge/source-sentry` |
| Adapter type | `sentry` |
| Display name | Sentry |
| Webhook path | `POST /webhooks/sentry` (also `POST /webhooks/sentry` via generic route) |
| Required env keys | `SENTRY_WEBHOOK_SECRET`, `SENTRY_API_TOKEN` |
| URL pattern examples | `https://acme.sentry.io/issues/12345/`, `https://sentry.io/organizations/acme/issues/12345/` |
| Setup guide | `packages/sources/sentry/src/setup-guide.md` |
| Dedup key formula | `sha256(project + fingerprint + code_version)` |
| Notes | Refit of the original sentry-fixer-bot MVP code. Supports both webhook ingest and manual URL trigger. |

## Planned adapters (catalog stubs — not yet implemented)

### PostHog

| Field | Value |
|---|---|
| Package | `@alertforge/source-posthog` (future) |
| Adapter type | `posthog` |
| Display name | PostHog |
| Webhook path | `POST /webhooks/posthog` |
| Required env keys | `POSTHOG_WEBHOOK_SECRET`, `POSTHOG_API_KEY` |
| URL pattern examples | `https://us.posthog.com/project/123/events/abc-def-ghi/`, `https://eu.posthog.com/...` |
| Notes | Triggered by PostHog insight alerts; each alert fires once per event. Project mapping inferred from project ID in URL/payload. |

### PagerDuty

| Field | Value |
|---|---|
| Package | `@alertforge/source-pagerduty` (future) |
| Adapter type | `pagerduty` |
| Display name | PagerDuty |
| Webhook path | `POST /webhooks/pagerduty` |
| Required env keys | `PAGERDUTY_WEBHOOK_SECRET`, `PAGERDUTY_API_TOKEN` |
| URL pattern examples | `https://acme.pagerduty.com/incidents/PXXXXX` |
| Notes | Each incident is treated as an alert; `codeVersion` may be absent. Higher signal than Sentry — incident itself is the trigger. |

### OpsGenie

Similar to PagerDuty. Webhook v2 + REST API for fetch-by-id.

### Datadog

Monitor-style alerts. Aggregates host/service signal; map to a repo via Datadog tags.

## Adding a new adapter

See [source-adapter-contract](../specs/2026-05-21-source-adapter-contract.md) §"Authoring a new adapter — checklist".

When your PR merges, update this file with a new row in the "Active adapters" section.
