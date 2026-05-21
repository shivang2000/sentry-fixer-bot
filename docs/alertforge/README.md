# Alertforge — Design Docs

This tree is the source of truth for **ongoing Alertforge design work**. Existing top-level `docs/*.md` files (`design.md`, `architecture.md`, `planning.md`, `PROGRESS.md`, `runbook.md`, `v2-frontend-and-skills.md`) describe the original `sentry-fixer-bot` MVP 1.0.0 and remain authoritative for what shipped before the rename. New design work happens here.

## Layout

| Folder | Contains |
|---|---|
| `specs/` | Design documents — what we're building and why. Frontmatter status: `draft` / `accepted` / `implemented` / `superseded`. |
| `plans/` | Implementation plans — how and when. Each phase plan links back to the spec(s) it implements. |
| `decisions/` | ADRs — short, frozen, immutable once accepted. Supersede by adding a new ADR that links back. |
| `catalog/` | Living docs — list of source adapters, channel adapters, supported model IDs. Updated as adapters land. |

## File-naming convention

- Specs and plans: `YYYY-MM-DD-<topic>.md`
- ADRs: `ADR-####-<topic>.md` (zero-padded, monotonic)

## Spec catalog

| Spec | Status | Plans implementing it |
|---|---|---|
| [Pluggable pipeline (umbrella)](specs/2026-05-21-pluggable-pipeline-design.md) | accepted | P1, P2, P3, P4, P5, P6, P7, P8, P9 |
| [Disk-backed context store](specs/2026-05-21-disk-context-store.md) | accepted | P1 |
| [Source adapter contract](specs/2026-05-21-source-adapter-contract.md) | accepted | P1, P2 |
| [Channel adapter contract](specs/2026-05-21-channel-adapter-contract.md) | accepted | P5 |
| [Pipeline step contract](specs/2026-05-21-pipeline-step-contract.md) | accepted | P1, P3 |
| [Trigger config schema](specs/2026-05-21-trigger-config-schema.md) | accepted | P4 |
| [UI surface](specs/2026-05-21-ui-surface.md) | accepted | P6 |
| [Rename + data migration](specs/2026-05-21-rename-migration.md) | accepted | P7, P8 (migration 0003) |
| [Self-improvement loop](specs/2026-05-21-self-improvement-loop.md) | accepted | P8 (V1), V1.5+ later |

## Phase plan catalog

| Plan | Status | Implements |
|---|---|---|
| [P1 — Core abstraction](plans/2026-05-21-phase-1-core-abstraction.md) | draft | alertforge-core package + ctx-store + step contract |
| [P2 — Sentry source refit](plans/2026-05-21-phase-2-sentry-refit.md) | draft | source adapter contract V1 |
| [P3 — Steps refactor](plans/2026-05-21-phase-3-steps-refactor.md) | draft | pipeline step contract |
| [P4 — Triggers schema](plans/2026-05-21-phase-4-triggers-schema.md) | draft | trigger config + migration 0003 |
| [P5 — Slack + email channels](plans/2026-05-21-phase-5-channels.md) | draft | channel adapter contract |
| [P6 — Triggers UI + URL-trigger](plans/2026-05-21-phase-6-ui.md) | draft | UI surface |
| [P7 — Rename cutover](plans/2026-05-21-phase-7-rename.md) | draft | rename + data migration |
| [P8 — Outcome feedback + digest](plans/2026-05-21-phase-8-outcome-feedback.md) | draft | self-improvement loop V1 |
| [P9 — Deprecation cleanup (2.1)](plans/2026-05-21-phase-9-cleanup.md) | draft | drop repos_config + SFB_* env keys |

## ADRs

| ADR | Status | Topic |
|---|---|---|
| [ADR-0001](decisions/ADR-0001-disk-vs-memory-ctx-store.md) | accepted | Disk-backed pipeline context store |
| [ADR-0002](decisions/ADR-0002-anthropic-only-v1.md) | accepted | Anthropic-only V1, plugin slot for future providers |
| [ADR-0003](decisions/ADR-0003-rename-to-alertforge.md) | accepted | Rename `sentry-fixer-bot` → `alertforge` in place |
| [ADR-0004](decisions/ADR-0004-code-registry-not-db-adapters.md) | accepted | Source + channel adapters as TS code, not DB rows |
| [ADR-0005](decisions/ADR-0005-three-presets-not-toggle-list.md) | accepted | 3 presets + advanced disclosure, not raw toggle list |
| [ADR-0006](decisions/ADR-0006-step-modules-not-step-per-job.md) | accepted | Approach A (step modules + shared ctx) over Approach B (step-per-pg-boss-job) |

## Reading order for new contributors

1. [Pluggable pipeline (umbrella spec)](specs/2026-05-21-pluggable-pipeline-design.md) — the big picture
2. [Disk-backed context store](specs/2026-05-21-disk-context-store.md) + [ADR-0001](decisions/ADR-0001-disk-vs-memory-ctx-store.md) — performance contract
3. [Source adapter contract](specs/2026-05-21-source-adapter-contract.md) and [Channel adapter contract](specs/2026-05-21-channel-adapter-contract.md) — extension surface
4. [Pipeline step contract](specs/2026-05-21-pipeline-step-contract.md) — how steps cooperate
5. Current implementation phase plan
