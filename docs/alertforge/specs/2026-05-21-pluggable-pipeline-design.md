---
spec: pluggable-pipeline-design
title: Pluggable Alert→Fix Pipeline (umbrella)
status: accepted
date: 2026-05-21
authors: ops
supersedes_parts_of:
  - docs/design.md
  - docs/architecture.md
  - docs/v2-frontend-and-skills.md
related_specs:
  - disk-context-store
  - source-adapter-contract
  - channel-adapter-contract
  - pipeline-step-contract
  - trigger-config-schema
  - ui-surface
  - rename-migration
  - self-improvement-loop
adrs:
  - ADR-0001-disk-vs-memory-ctx-store
  - ADR-0002-anthropic-only-v1
  - ADR-0003-rename-to-alertforge
  - ADR-0004-code-registry-not-db-adapters
  - ADR-0005-three-presets-not-toggle-list
  - ADR-0006-step-modules-not-step-per-job
---

# Pluggable Alert→Fix Pipeline (umbrella spec)

This is the umbrella spec for the Alertforge 2.0 refactor. It describes the high-level architecture; each subsystem has its own focused spec linked in frontmatter.

## Problem

`sentry-fixer-bot` MVP 1.0 hard-codes a single linear pipeline (Sentry → triage → fix → tests → PR → review → follow-up → notify) at every layer:

- Vocabulary: `repos_config.sentry_project`, `runs/sentry/*`, env keys prefixed `SFB_*`.
- Behavior: every step always runs unconditionally regardless of repo or cost preference.
- Outputs: only a Sentry comment + a GitHub PR.

Two product pressures force a rethink:

1. **Token cost is unpredictable.** Users want per-trigger control over which steps run and which model each step uses.
2. **Sentry isn't the only signal source.** Users want to route PostHog, PagerDuty, and future sources through the same triage→fix→notify machinery.

## Goals

- **G1** — Pluggable source adapters: add a new source (PostHog, PagerDuty, …) as a PR adding one TS module, no core changes.
- **G2** — Pluggable channel adapters: add a new outbound channel (Slack, email, PagerDuty-out, Teams, …) the same way.
- **G3** — Per-trigger pipeline configuration: preset + advanced toggles + per-step model selection.
- **G4** — Resource-light pipeline: per-run state lives on disk, not in process memory; worker runs on a small EC2.
- **G5** — Rename the project to **Alertforge** in place, preserving git history, GitHub App installs, and customer webhook URLs.
- **G6** — Self-improvement loop foundations: outcome tracking, daily digest, cross-run recall scaffolding.

## Non-goals

- Multi-LLM-provider in V1 (Anthropic only; provider interface defined for future PRs — see ADR-0002).
- DB-stored adapter code (security risk — see ADR-0004).
- Step-level resume on crash (V2 — see ADR-0006).
- DSL-defined custom pipelines (rejected — see ADR-0006).
- Multi-tenant SaaS hosting (unchanged from original `design.md` N2).

## High-level architecture

```
                          ┌────────────────────────────────────┐
                          │  Source webhooks                   │
                          │  POST /webhooks/:sourceType        │
                          └────────────────────┬───────────────┘
                                               │
                          SourceAdapter.verifyWebhook(req)
                          SourceAdapter.parsePayload(body) → NormalizedAlert
                                               │
                                     dedup + alerts upsert
                                               │
                                       pg-boss enqueue
                                               │
                            ┌──────────────────▼──────────────────┐
                            │ alertforge-worker                   │
                            │   resolveEffectiveConfig(trigger)   │
                            │   createRunDir(run_id)              │
                            │   runPipeline(steps, ctxRef)        │
                            │      classify (LLM)                 │
                            │      fetchEvent (source adapter)    │
                            │      budget                         │
                            │      [if triage_only: STOP → fanOut]│
                            │      workspace                      │
                            │      fixAgent (LLM)                 │
                            │      secretScan                     │
                            │      testGate                       │
                            │      commitPush                     │
                            │      openPr                         │
                            │      reviewPr (LLM, optional)       │
                            │      followUp (LLM, optional)       │
                            │      fanOutChannels                 │
                            │   archiveCtxToS3 + cleanup          │
                            └──────────────────┬──────────────────┘
                                               │
                          ChannelAdapter.send(notification, channel_config)
                                ├── slack / email / pagerduty-out / …
                                └── (GitHub PR is direct artifact, not a channel)
```

Detailed contracts:
- Sources: see [source-adapter-contract](2026-05-21-source-adapter-contract.md).
- Channels: see [channel-adapter-contract](2026-05-21-channel-adapter-contract.md).
- Steps: see [pipeline-step-contract](2026-05-21-pipeline-step-contract.md).
- Context store: see [disk-context-store](2026-05-21-disk-context-store.md).
- Trigger config: see [trigger-config-schema](2026-05-21-trigger-config-schema.md).
- UI: see [ui-surface](2026-05-21-ui-surface.md).
- Rename + migration: see [rename-migration](2026-05-21-rename-migration.md).
- Self-improvement loop: see [self-improvement-loop](2026-05-21-self-improvement-loop.md).

## Trigger = (source_type, source_project, repo)

A **trigger** is the addressable unit a pipeline config attaches to. One trigger per (source-type, source-project, repo) tuple. Example rows:

- `(sentry, backend-api, acme-corp/api)` — Sentry alerts from project `backend-api` fix code in repo `acme-corp/api`.
- `(sentry, web-frontend, acme-corp/web)` — separate config; different preset, different model picks possible.
- `(posthog, signup-flow, acme-corp/web)` — future, same target repo, different source.

Each trigger owns its pipeline config (preset + toggles + model picks + budget) and zero or more channel configs (Slack channel, email recipients, …).

## Presets

(see also ADR-0005)

| Preset | Behavior |
|---|---|
| `triage_only` | Classify + notify; no agent, no PR. Cheapest. |
| `auto_fix` | Classify + fix + tests + PR. Default for new triggers. Matches today's behavior. |
| `auto_fix_review` | Above + LLM reviews own PR before marking ready. |
| `custom` | Exposes individual toggles in Advanced disclosure. |

## Manual URL trigger (parity with today's Sentry-URL trigger)

Every source adapter implements `parseUrl(url)` + `fetchByExternalId(externalId)`. A single UI box accepts a URL (Sentry issue / PostHog event / PagerDuty incident / …); the router detects source by `urlPatterns`, fetches the alert via adapter, and fires the same pipeline code path as a webhook. See [source-adapter-contract](2026-05-21-source-adapter-contract.md) §URL-trigger.

## Phasing

See `../plans/2026-05-21-phase-1-core-abstraction.md` through `…-phase-9-cleanup.md`. Nine phases, each ships as a PR. P1–P3 introduce the abstraction with zero behavior change. P4–P6 land schema + UI. P7 is the rename cutover. P8 adds outcome feedback + digest. P9 drops deprecated surface.

## Success criteria

| Outcome | Measurable how |
|---|---|
| Sentry pipeline behavior identical post-refactor | E2E webhook → PR test on fixture repo produces the same PR as today |
| Worker process RAM ≤ 100 MB resident at concurrency 3 | `ps -o rss` on `alertforge-worker` after a stress run |
| New source adapter buildable in < 1 day | Time-to-merge of first PostHog adapter PR |
| Average alert cost on `auto_fix` preset unchanged vs MVP | Per-trigger cost rollup on `/usage` |
| Average alert cost on `triage_only` preset ≤ $0.005 | Same |
| Renaming surface complete | `grep -r "sentry-fixer-bot"` in code returns only intentional historical references |
