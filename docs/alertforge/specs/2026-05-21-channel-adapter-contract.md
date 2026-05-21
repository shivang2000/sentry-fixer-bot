---
spec: channel-adapter-contract
title: Channel adapter contract
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0004-code-registry-not-db-adapters
related_specs:
  - pluggable-pipeline-design
plan_phases:
  - 2026-05-21-phase-5-channels
---

# Channel adapter contract

Channel adapters are the outbound boundary. One adapter per delivery vendor (Slack, email, PagerDuty-out, Teams, Discord, …). Each ships as a TS module under `packages/channels/<name>/`.

GitHub PR opening is **not** a channel — it's a core fix-step output that the pipeline always produces (when the preset includes the fix step). Channels are post-fix notification delivery.

## Interface

```ts
// packages/alertforge-core/src/types.ts
export interface ChannelAdapter {
  type: string;                                   // 'slack'
  displayName: string;
  configSchema: z.ZodSchema;                      // zod schema for per-channel-config-row config
  send(notification: PipelineNotification, config: unknown): Promise<void>;
  catalogEntry: {
    description: string;
    setupGuide: string;                           // markdown rendered in UI catalog
    requiresEnvKeys: string[];                    // global env keys this adapter needs
  };
}

export interface PipelineNotification {
  triggerId: string;
  alert: NormalizedAlert;
  runId: string;
  status: 'pr_opened' | 'triage_only' | 'failed' | 'budget_blocked' | 'duplicate_pr';
  prUrl?: string;
  triageSummary?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  confidence?: number;
  costCents?: number;
  ctxArchiveS3?: string;
}
```

## Fan-out step

`packages/steps/fan-out-channels/` is the final step in the default pipeline (after `openPr` or after `budget` for `triage_only` preset). It:

1. Loads `channel_configs` rows for the current trigger where `enabled = true`.
2. Filters by `notify_on` overlap with current run status.
3. For each, calls `adapter.send(notification, row.config)`.
4. Records result in `ctx/notifications.json` and updates `channel_configs.last_send_at/ok/err`.
5. Errors during send do not abort the pipeline — they're logged and recorded. Other channels still fire.

## Slack adapter (V1)

```ts
// packages/channels/slack/src/adapter.ts
export default {
  type: 'slack',
  displayName: 'Slack',
  configSchema: z.object({
    webhookUrl: z.string().url(),
    channel: z.string().optional(),
    mentionUserIds: z.array(z.string()).optional(),
  }),
  catalogEntry: {
    description: 'Send Slack messages via incoming webhook URL.',
    setupGuide: '…how to create an incoming webhook in Slack…',
    requiresEnvKeys: [],                          // per-config, not env
  },
  async send(n, config) {
    // POST { text, blocks: [...] } to config.webhookUrl
  },
} satisfies ChannelAdapter;
```

Card shape: alert title (linked), severity badge, cost, PR link button, "Open in Alertforge" button. Mentioned user IDs prepended to text.

## Email adapter (V1)

```ts
// packages/channels/email/src/adapter.ts
export default {
  type: 'email',
  displayName: 'Email',
  configSchema: z.object({
    to: z.array(z.string().email()).min(1).max(20),
    from: z.string().email().optional(),
    notifyOnSeverityAtLeast: z.enum(['low','medium','high','critical']).default('medium'),
  }),
  catalogEntry: {
    description: 'Send email digests via Resend (or SMTP fallback).',
    setupGuide: '…how to set RESEND_API_KEY…',
    requiresEnvKeys: ['RESEND_API_KEY'],         // or SMTP_HOST/SMTP_USER/SMTP_PASS as fallback
  },
  async send(n, config) {
    // pick provider based on env presence; render HTML + plaintext; deliver
  },
} satisfies ChannelAdapter;
```

Resend SDK preferred (one env key, modern). Falls back to nodemailer + SMTP if `RESEND_API_KEY` absent and SMTP envs present.

Template: same fields as Slack, plus the 14-day digest link.

## Adding a new channel — checklist

1. Create `packages/channels/<name>/`:
   - `package.json`
   - `src/adapter.ts`
   - `tests/` (configSchema validation, mocked transport delivers expected payload)
2. Add env keys to `packages/env/src/server.ts` if needed.
3. Add a row to `docs/alertforge/catalog/channels.md`.
4. PR; CI runs new tests.
5. After deploy, channel appears in UI's "Add channel" dropdown.

## Tests

- `configSchema` accepts valid configs and rejects invalid ones (fixture-based).
- `send` issues exactly one network call with the right payload shape (mocked transport).
- Fan-out integration: 2 channels configured, one throws, other still sends, error recorded on the failing row, pipeline continues.

## Future channels (catalog)

| Channel | Notes |
|---|---|
| PagerDuty-out | Create PD incident (Events API v2) for `failed` / `budget_blocked` |
| Microsoft Teams | Incoming webhook variant of Slack |
| Discord | Webhook variant |
| Generic webhook | One-off "POST to URL with normalized JSON" channel for power users |
| Linear / Jira | Create issue for failed pipelines |
