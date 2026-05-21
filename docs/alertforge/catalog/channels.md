# Channel adapter catalog

Lists the channel adapters available in `packages/channels/`. Each conforms to `ChannelAdapter` from `@alertforge/core` (see [channel-adapter-contract](../specs/2026-05-21-channel-adapter-contract.md)).

## Active adapters (shipping V1)

### Slack

| Field | Value |
|---|---|
| Package | `@alertforge/channel-slack` |
| Adapter type | `slack` |
| Display name | Slack |
| Per-config fields | `webhookUrl` (required), `channel` (optional), `mentionUserIds` (optional) |
| Required global env keys | none (webhook URL is per-config) |
| Setup guide | "Create an Incoming Webhook in your Slack workspace; paste the URL into the channel config." |
| Notes | Renders alert as Block Kit card with severity badge, cost, PR link button, "Open in Alertforge" button. Digest layout used when `notification.status === 'digest'`. |

### Email

| Field | Value |
|---|---|
| Package | `@alertforge/channel-email` |
| Adapter type | `email` |
| Display name | Email |
| Per-config fields | `to` (required, max 20), `from` (optional), `notifyOnSeverityAtLeast` (default 'medium') |
| Required global env keys | `RESEND_API_KEY` preferred, or `SMTP_HOST` + `SMTP_USER` + `SMTP_PASS` as fallback |
| Setup guide | "Set `RESEND_API_KEY` for the simplest setup; or set SMTP env keys to use any SMTP relay." |
| Notes | Severity floor: notification dropped if `alert.severity` is below the configured floor. |

## Planned adapters (catalog stubs)

### PagerDuty (outbound)

| Field | Value |
|---|---|
| Package | `@alertforge/channel-pagerduty-out` (future) |
| Adapter type | `pagerduty-out` |
| Display name | PagerDuty (create incident) |
| Per-config fields | `routingKey` (Events API v2 routing key), `severityFloor` |
| Notes | Useful for `failed`/`budget_blocked` notifications when the team uses PagerDuty for paging. |

### Microsoft Teams

Incoming webhook variant of Slack. Same shape, different POST payload structure.

### Discord

Webhook variant; markdown-formatted message.

### Generic webhook

A power-user channel: `{ url, headers, payloadTemplate }`. Posts the normalized `PipelineNotification` (or a template-evaluated variant) to any URL.

### Linear / Jira (issue tracker channels)

Create an issue when the pipeline fails or hits budget. Different status filter than chat channels — typically `failed` only.

## Adding a new channel

See [channel-adapter-contract](../specs/2026-05-21-channel-adapter-contract.md) §"Adding a new channel — checklist".

After PR merges, add a row to the "Active adapters" section.
