---
plan: phase-8-outcome-feedback
phase: 8
status: draft
date: 2026-05-21
implements_specs:
  - self-improvement-loop
risk: low
size: small
---

# P8 — Outcome feedback + daily digest (Self-improvement loop V1)

Add the outcome tracking and daily digest portions of the self-improvement loop. Cross-run recall (V1.5) and auto-skill distillation (V2) are out of scope here.

## Scope

- New cron job `outcome-poll-job` running daily: walks open bot PRs ≤14d old, records `prs.outcome`.
- New cron job `daily-digest-job` running daily at a configurable hour: per-trigger digest sent via the same `fanOutChannels` machinery (channels with `'digest'` in their `notify_on`).
- `channel_configs.notify_on` gains `'digest'` as an allowed value.
- UI: `/triggers/$id/audit` extended with an outcome chart (last 30 days).

## File-level changes

### Add

```
packages/steps/outcome-poll/                   cron-step (no ctx required)
  package.json
  src/index.ts
  src/poll-open-prs.ts                         per-PR poller helper
  src/fetch-review-comments.ts                 for closed-unmerged PRs
  src/__tests__/

packages/steps/daily-digest/                   cron-step
  package.json
  src/index.ts
  src/build-digest.ts                          per-trigger digest builder
  src/__tests__/

apps/server/src/cron/                          NEW cron registrations
  outcome-poll.ts                              wires outcome-poll into alertforge-cron
  daily-digest.ts                              wires daily-digest into alertforge-cron
  index.ts

apps/web/src/components/triggers/
  OutcomeChart.tsx                             merge-rate trendline for last 30d
```

### Modify

```
packages/db/src/schema/domain.ts               (prs.outcome and friends added in P4
                                                migration 0003; no schema change here)
packages/api/src/routers/cron.ts               add listOutcomes for charting
packages/steps/fan-out-channels/src/step.ts    treat status='digest' as a synthetic
                                               PipelineNotification — same code path as
                                               pr_opened/failed but with digest fields
packages/db/src/schema/triggers.ts             channel_configs.notify_on default unchanged;
                                               admins opt-in to 'digest' via UI
apps/web/src/routes/triggers.$id.audit.tsx     render OutcomeChart
```

## `outcome-poll-job` shape

```ts
// packages/steps/outcome-poll/src/index.ts
export async function pollOutcomes(deps: { db, github, log }): Promise<void> {
  const openPrs = await deps.db.query.prs.findMany({
    where: and(
      isNull(prs.outcome),
      gte(prs.openedAt, sql`now() - interval '14 days'`),
    ),
  });

  for (const pr of openPrs) {
    try {
      const state = await deps.github.pulls.get({ /* ... */ });
      let outcome: PrOutcome | null = null;
      let humanCommits = 0;

      if (state.merged) {
        humanCommits = await countHumanCommitsBetween(deps.github, pr);
        outcome = humanCommits > 0 ? 'merged_with_edits' : 'merged_clean';
      } else if (state.closed_at) {
        outcome = 'closed_unmerged';
      } else if (Date.now() - pr.openedAt.getTime() > 14 * 24 * 60 * 60 * 1000) {
        outcome = 'stale_open';
      }

      if (outcome) {
        const reviewComments = (outcome === 'closed_unmerged')
          ? await fetchReviewComments(deps.github, pr)
          : null;

        await deps.db.update(prs).set({
          outcome,
          outcomeRecordedAt: new Date(),
          humanCommits,
          ...(reviewComments && { reviewCommentsJsonb: reviewComments }),
        }).where(eq(prs.id, pr.id));
      }
    } catch (err) {
      deps.log.warn({ prId: pr.id, err }, 'outcome poll failed');
      // continue with next PR
    }
  }
}
```

## `daily-digest-job` shape

```ts
// packages/steps/daily-digest/src/index.ts
export async function sendDailyDigests(deps: { db, registry, log }): Promise<void> {
  const allTriggers = await deps.db.query.triggers.findMany({
    where: eq(triggers.enabled, true),
    with: { channelConfigs: true },
  });

  for (const trigger of allTriggers) {
    const digestChannels = trigger.channelConfigs.filter(
      c => c.enabled && c.notifyOn.includes('digest'),
    );
    if (digestChannels.length === 0) continue;

    const digest = await buildDigest(trigger, deps);     // 7d stats, top fingerprints, cost burn
    const notification: PipelineNotification = {
      triggerId: trigger.id,
      alert: digest.syntheticAlert,                       // a placeholder; digest is the payload
      runId: 'digest-' + new Date().toISOString().slice(0, 10),
      status: 'digest',
      digestBody: digest.body,                            // adapters that support it render this
      // ... cost roll-up
    };

    for (const cc of digestChannels) {
      const adapter = deps.registry.channels.get(cc.channelType);
      if (!adapter) continue;
      try {
        await adapter.send(notification, cc.config);
      } catch (err) {
        deps.log.warn({ triggerId: trigger.id, channel: cc.channelType, err }, 'digest send failed');
      }
    }
  }
}
```

## Channel adapter extension

`PipelineNotification` gains `status: 'digest'` and an optional `digestBody`. Existing Slack/email adapters extended:

```ts
// Slack adapter: when status='digest', render a different block layout
if (notification.status === 'digest') {
  return renderDigestBlocks(notification);
}
```

This keeps the adapter contract uniform; digest is just another notification kind.

## Tests

- `pollOutcomes`: fixture PRs in each state → correct outcome recorded; reviewer comments fetched only for closed_unmerged.
- `buildDigest`: fixture trigger with 47 runs → correct counts, top fingerprints, cost roll-up.
- Slack adapter: digest fixture renders expected block layout.
- Integration: full cron tick records outcomes + sends digest to a mocked Slack endpoint.

## Verification

```bash
bun --filter=@alertforge/step-outcome-poll test
bun --filter=@alertforge/step-daily-digest test
bun --filter=@alertforge/channel-slack test

# Manual:
# Set a digest channel via UI: edit Slack channel config, add 'digest' to notify_on.
# Trigger cron manually: bun run cron:digest
# Verify Slack message arrives with the digest block layout.
```

## Commit

```
feat(cron,channels): outcome tracking + daily digest (V1 self-improvement)

Phase 1 of the self-improvement loop:
- alertforge-cron polls open bot PRs daily for 14d post-open and records
  prs.outcome (merged_clean | merged_with_edits | closed_unmerged | stale_open).
  Review comments captured for closed-unmerged PRs (input to V2 reviewer
  modeling).
- New daily digest cron emits per-trigger 7d roll-up (merge rate, top
  recurring fingerprints not getting fixed, cost vs cap, suggested actions)
  to any channel with 'digest' in its notify_on list.
- Slack + email adapters extended to render a digest block layout when
  PipelineNotification.status === 'digest'.
- /triggers/$id/audit page adds OutcomeChart showing 30-day merge rate
  trendline.

V1.5 (cross-run recall via run_summaries + find_similar_past_alerts agent
tool) and V2 (auto-skill distillation + reviewer-style modeling) remain
designed-only in this spec.

Spec: docs/alertforge/specs/2026-05-21-self-improvement-loop.md
Plan: docs/alertforge/plans/2026-05-21-phase-8-outcome-feedback.md

Constraint: digest fan-out reuses fanOutChannels (no parallel pathway)
Constraint: review comment capture limited to closed-unmerged PRs (privacy)
Rejected: aggregated cross-customer skills | privacy boundary
Rejected: synchronous outcome polling on PR close webhook | reliability
Confidence: high
Scope-risk: narrow
Directive: Future improvements (cross-run recall, auto-skill distillation,
           reviewer modeling) build on the data captured here. Do not
           change outcome enum values without updating downstream
           distillation queries.
Not-tested: 14-day outcome poll under high PR volume; V1.5/V2 not in scope
```
