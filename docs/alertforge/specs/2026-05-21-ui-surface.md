---
spec: ui-surface
title: UI surface — triggers, channels, manual URL trigger
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0005-three-presets-not-toggle-list
related_specs:
  - pluggable-pipeline-design
  - trigger-config-schema
  - source-adapter-contract
plan_phases:
  - 2026-05-21-phase-6-ui
---

# UI surface

## Routes

| Route | Purpose |
|---|---|
| `/triggers` | Primary nav — list of all triggers, search, filter by source/repo |
| `/triggers/new` | Wizard: source → source-project → repo → preset → channels |
| `/triggers/$id` | Edit page with tabs (Pipeline / Channels / Budget / Audit) |
| `/triggers/$id/pipeline` | Pipeline tab |
| `/triggers/$id/channels` | Channels tab |
| `/triggers/$id/budget` | Budget tab |
| `/triggers/$id/audit` | Recent runs for this trigger |
| `/repos` | Kept as secondary nav (still useful for repo-level config) |
| `/mcps`, `/skills`, `/runs` | Unchanged |
| `/chat` | Unchanged |
| `/usage` | Extended with per-trigger + per-step cost breakdown |
| `/sources` (new, optional) | Catalog page listing available source adapters from registry |
| `/channels` (new, optional) | Catalog page listing available channel adapters from registry |

## Triggers list page

Card grid layout. Each card shows:

```
┌─ Sentry → backend-api ──────────────────────────┐
│ Repo: acme-corp/api                             │
│ Preset: ● Auto-fix                              │
│ Last alert: 4 minutes ago                       │
│ 7d: 12 alerts • 8 PRs • 3 merged                │
│ [Edit] [Disable] [Trigger from URL…]            │
└─────────────────────────────────────────────────┘
```

Card header includes the source icon (from `adapter.catalogEntry`) for instant visual scanning.

## Pipeline tab layout

```
Mode:
  [● Auto-fix       ○ Triage-only   ○ Auto-fix + review   ○ Custom]
  Estimated cost: $1.00–$1.50 per alert (Auto-fix)

Models:
  Classifier        [Haiku 4.5      ▾]   est. cost/alert: $0.001
  Fix agent         [Opus 4.7       ▾]   est. cost/alert: $1.00–$1.50
  Reviewer          [Sonnet 4.6     ▾]   greyed if preset≠auto_fix_review and Advanced.autoReview=off
  Follow-up agent   [Sonnet 4.6     ▾]   greyed if Advanced.followUpLoop=off

Budget:
  Daily tokens      [1,000,000]
  Daily cost cap    [$25]

Advanced ▾  (expanded only when preset='custom')
  ☐ Override preset: auto-PR-review
  ☐ Override preset: follow-up /sfb loop
  Secret-scan:  [● Block PR  ○ Warn-only]

[Save]  [Test pipeline with mock alert]
```

When a non-`custom` preset is selected, Advanced toggles render in disabled state with a "set by preset" indicator (matches ADR-0005). Switching to `custom` makes them editable.

`Test pipeline with mock alert` button kicks off a dry-run that uses a stored fixture (per source adapter) and goes end-to-end with a noop channel — useful for validating model picks + budget settings without burning a real LLM call.

## Channels tab layout

```
[+ Add channel]   ← lists available channel adapters from registry

┌─ Slack ───────────────────────────────────────────┐
│ Webhook URL:  https://hooks.slack.com/…           │
│ Channel:      #oncall-backend                     │
│ Notify on:    ✓ PR opened  ✓ Failed  ☐ Budget hit │
│ [Test send]  [Edit]  [Disable]  [Remove]          │
│ Last send:    2026-05-21 14:02 ✓                 │
└───────────────────────────────────────────────────┘

┌─ Email ───────────────────────────────────────────┐
│ To:           sre@acme.com                        │
│ Notify on:    ✓ Failed only                       │
└───────────────────────────────────────────────────┘
```

Adding a channel: click `[+ Add channel]` → dropdown lists registry entries that aren't yet configured for this trigger → selecting one renders that adapter's `configSchema` as a dynamic form (same pattern already in `/mcps` install dialog). On Save, the row is created in `channel_configs`.

## Manual URL trigger UI

Single input box. Placement:
- Header action on `/triggers` (always visible to admins).
- Header action on `/triggers/$id` (focused on this trigger; URL auto-routed).
- Tab on `/runs/new` (replaces today's Sentry-URL-only trigger UI).

```
┌───────────────────────────────────────────────────────────────┐
│  Trigger fix from URL                                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ https://acme.sentry.io/issues/12345/   or               │ │
│  │ https://us.posthog.com/project/123/events/abc/   or     │ │
│  │ https://acme.pagerduty.com/incidents/PXXXXX             │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  Detected source: Sentry  ←  populated after blur            │
│  Matching trigger: backend-api → acme-corp/api  ←  populated  │
│  Preset: Auto-fix  ←  populated from trigger row              │
│                                                               │
│  [Run pipeline now]   [Run as triage-only this once]          │
└───────────────────────────────────────────────────────────────┘
```

Backend tRPC procedures (see [source-adapter-contract](2026-05-21-source-adapter-contract.md) §Manual URL trigger flow):

- `triggers.detectUrl({ url }) → { adapterType, sourceProject, externalId, matchingTrigger? }` (debounced on blur in UI)
- `triggers.runFromUrl({ url, mode? }) → { runId }` (on Run click)

Errors UI must handle:
- `BAD_REQUEST` (no adapter matches URL) → show "Source not recognized. Configure one in /sources first."
- `NOT_FOUND` (no trigger configured) → show "No trigger configured for `<source>/<source_project>`. [Create trigger]" link.
- adapter `fetchByExternalId` error → show adapter's error message + link to `/runs` for debugging.

## `/usage` page extensions

Today's page rolls up cost by repo. Extensions:

- **Per-trigger breakdown** — sortable table: trigger / preset / 24h cost / 7d cost / cap remaining.
- **Per-step breakdown** — for selected trigger or globally: classify / fix / review / follow-up cost columns.
- **Cost guard banner** — if any trigger is on `auto_fix_review` and current burn × projected multiplier > cap, render a warning offering "Downgrade to Auto-fix" link.

## `/sources` and `/channels` catalog pages (optional V1)

Lists registry entries. Each shows `displayName`, `description`, `setupGuide` (rendered markdown), `requiresEnvKeys` (with green ✓ if env key present in process env, red ✗ if missing).

These pages give admins a discovery surface for what's available without diving into the code.

## Component reuse

Existing components to lean on:
- shadcn `Tabs`, `Card`, `Table` (already used in `/runs`, `/repos`)
- `RepoForm` modal pattern → adapt for `TriggerForm`
- `ConfirmDialog` from delete flow
- `McpInstallDialog` (`apps/web/src/components/McpInstallDialog.tsx`) — pattern for "dynamic form from a registry's configSchema"; reuse the same `RegistryConfigForm` after extracting from it.
- xterm install log → reuse for "Test send" output and "Test pipeline" output streams.
- `AppSidebar` — add `/triggers` link in primary section; demote `/repos` to secondary.

## Accessibility / responsiveness

- Triggers list: card grid collapses to single column at <640 px.
- Trigger edit tabs: convert to accordion at <768 px.
- All form labels with `for` attribute; all toggles keyboard-navigable; preset selector uses native `<select>` for VoiceOver compatibility.
