---
plan: phase-5-channels
phase: 5
status: draft
date: 2026-05-21
implements_specs:
  - channel-adapter-contract
risk: low
size: small
---

# P5 — Slack + email channel adapters

Replace the placeholder `fan-out-channels` step from P3 with a real implementation that iterates `channel_configs` rows and dispatches to channel adapters. Ship Slack and email adapters as the first two.

## Scope

- `packages/channels/slack/` adapter.
- `packages/channels/email/` adapter (Resend SDK first, SMTP fallback if RESEND_API_KEY absent).
- `packages/steps/fan-out-channels` implementation upgraded from no-op to real fan-out.
- Catalog file `docs/alertforge/catalog/channels.md` updated.

## File-level changes

### Add

```
packages/channels/slack/
  package.json                              @alertforge/channel-slack
  src/index.ts
  src/adapter.ts                            default export: ChannelAdapter
  src/render-card.ts                        Slack Block Kit renderer
  src/__tests__/adapter.test.ts             configSchema valid/invalid, send mocked

packages/channels/email/
  package.json                              @alertforge/channel-email
  src/index.ts
  src/adapter.ts
  src/render-html.ts                        HTML + plaintext template
  src/transports/resend.ts                  Resend SDK wrapper
  src/transports/smtp.ts                    nodemailer wrapper
  src/__tests__/adapter.test.ts
```

### Modify

```
packages/steps/fan-out-channels/src/step.ts      real implementation:
                                                  1. read ctx.trigger.id
                                                  2. load channel_configs for trigger
                                                  3. for each enabled+notify_on matching:
                                                     adapter.send(notification, config)
                                                  4. record results in ctx/notifications.json
                                                  5. update channel_configs.last_send_*

packages/env/src/server.ts                       add RESEND_API_KEY, SMTP_HOST,
                                                  SMTP_USER, SMTP_PASS (all optional)
```

## Slack adapter

`packages/channels/slack/src/adapter.ts`:

```ts
import type { ChannelAdapter } from '@alertforge/core';
import { z } from 'zod';
import { renderSlackBlocks } from './render-card';

const adapter: ChannelAdapter = {
  type: 'slack',
  displayName: 'Slack',
  configSchema: z.object({
    webhookUrl: z.string().url(),
    channel: z.string().optional(),
    mentionUserIds: z.array(z.string()).optional(),
  }),
  catalogEntry: {
    description: 'Send notifications via Slack incoming webhook.',
    setupGuide: SLACK_SETUP_GUIDE,
    requiresEnvKeys: [],
  },
  async send(notification, config) {
    const { webhookUrl, channel, mentionUserIds } = config as {
      webhookUrl: string; channel?: string; mentionUserIds?: string[];
    };
    const body = {
      ...(channel ? { channel } : {}),
      text: buildFallbackText(notification, mentionUserIds),
      blocks: renderSlackBlocks(notification, mentionUserIds),
    };
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Slack send failed: ${res.status} ${await res.text()}`);
  },
};

export default adapter;
```

Block Kit card layout:
- Header: alert title (linked to Sentry/PostHog issue)
- Section: severity badge (color-coded), confidence, cost
- Section: short triage summary (truncated)
- Actions: [Open PR] [View in Alertforge]

## Email adapter

`packages/channels/email/src/adapter.ts`:

```ts
const adapter: ChannelAdapter = {
  type: 'email',
  displayName: 'Email',
  configSchema: z.object({
    to: z.array(z.string().email()).min(1).max(20),
    from: z.string().email().optional(),
    notifyOnSeverityAtLeast: z.enum(['low','medium','high','critical']).default('medium'),
  }),
  catalogEntry: {
    description: 'Email notifications via Resend (preferred) or SMTP fallback.',
    setupGuide: EMAIL_SETUP_GUIDE,
    requiresEnvKeys: ['RESEND_API_KEY'],            // SMTP keys are alternatives
  },
  async send(notification, config) {
    const { to, from, notifyOnSeverityAtLeast } = config as {
      to: string[]; from?: string; notifyOnSeverityAtLeast: SeverityLevel;
    };
    if (!meetsSeverityFloor(notification.severity, notifyOnSeverityAtLeast)) return;

    const transport = process.env.RESEND_API_KEY ? resendTransport() : smtpTransport();
    await transport.send({
      to,
      from: from ?? process.env.ALERTFORGE_DEFAULT_FROM ?? 'alertforge@example.com',
      subject: `[Alertforge] ${notification.alert.title}`,
      html: renderHtml(notification),
      text: renderText(notification),
    });
  },
};
```

## fan-out-channels step (upgraded)

`packages/steps/fan-out-channels/src/step.ts`:

```ts
import type { PipelineStep } from '@alertforge/core';
import { registry } from '@alertforge/core';
import { db, channelConfigs } from '@alertforge/db';

const step: PipelineStep = {
  name: 'fan-out-channels',
  description: 'Send notification to every enabled channel configured for this trigger',
  async run(ctx, cfg, deps) {
    const trigger = await ctx.read<TriggerRow>('trigger');
    const alert = await ctx.read<NormalizedAlert>('alert');
    const pr = await ctx.read<PrSummary>('pr');
    const triage = await ctx.read<TriageOutput>('triage');

    const configs = await db.query.channelConfigs.findMany({
      where: and(eq(channelConfigs.triggerId, trigger.id), eq(channelConfigs.enabled, true)),
    });

    const notification: PipelineNotification = {
      triggerId: trigger.id,
      alert,
      runId: ctx.runId,
      status: determineStatus(ctx, cfg),
      prUrl: pr?.url,
      triageSummary: triage?.summary,
      severity: triage?.severity,
      confidence: triage?.confidence,
      // ... cost from runs row
    };

    const results: NotificationResult[] = [];
    for (const cc of configs) {
      if (!cc.notifyOn.includes(notification.status)) continue;
      const adapter = registry.channels.get(cc.channelType);
      if (!adapter) {
        results.push({ channel: cc.channelType, ok: false, error: 'Adapter not found in registry' });
        continue;
      }
      try {
        await adapter.send(notification, cc.config);
        results.push({ channel: cc.channelType, ok: true });
        await db.update(channelConfigs).set({
          lastSendAt: new Date(), lastSendOk: true, lastSendErr: null,
        }).where(eq(channelConfigs.id, cc.id));
      } catch (err) {
        results.push({ channel: cc.channelType, ok: false, error: String(err) });
        await db.update(channelConfigs).set({
          lastSendAt: new Date(), lastSendOk: false, lastSendErr: String(err),
        }).where(eq(channelConfigs.id, cc.id));
      }
    }

    await ctx.write('notifications', results);
  },
};

export default step;
```

Errors during a channel send are **logged**, **recorded**, and do not abort the pipeline.

## Tests

- Slack adapter: configSchema valid/invalid; send produces correct POST body (mocked fetch).
- Email adapter: Resend transport called when RESEND_API_KEY present; SMTP transport called otherwise; below-severity-floor notifications are skipped.
- fan-out integration: 2 channels configured, one throws, the other still sends, error recorded on the failing row, pipeline continues.
- `channels.testSend` tRPC procedure mock-runs the adapter with a fixture notification.

## Verification

```bash
bun --filter='@alertforge/channel-*' test
bun --filter=@alertforge/step-fan-out-channels test
bun --filter=@alertforge/server test

# Smoke (with a real Slack webhook URL):
# 1. Create a trigger via UI
# 2. Add a Slack channel config with your webhook URL
# 3. Click [Test send] — verify message arrives in #channel
```

## Commit

```
feat(channels): Slack + email adapters + fan-out step

Ship the first two channel adapters per the channel-adapter-contract
spec. Slack uses incoming webhook URLs; email uses Resend SDK with
SMTP fallback. The fan-out-channels step (placeholder in P3) is
upgraded to iterate channel_configs rows, dispatch to the adapter
registry, and record per-channel send results in ctx/notifications.json.

A failing channel send no longer aborts the pipeline — error is logged
to the channel_configs row and other channels still fire.

Spec: docs/alertforge/specs/2026-05-21-channel-adapter-contract.md
Plan: docs/alertforge/plans/2026-05-21-phase-5-channels.md

Constraint: channel send failure must not abort pipeline (operator UX)
Rejected: hard-coded Slack-only | violates plugin-model goal
Rejected: SMTP-only V1 | Resend has better dev ergonomics
Confidence: high
Scope-risk: narrow
Directive: New channel adapters must conform to ChannelAdapter from
           @alertforge/core; tests live in src/__tests__/.
Not-tested: high-volume fan-out under realistic concurrency
```
