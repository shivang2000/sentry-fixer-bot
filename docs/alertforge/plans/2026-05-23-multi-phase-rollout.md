---
plan: multi-phase-rollout
date: 2026-05-23
status: accepted
authors: ops
orchestrator: this Claude Code session
phases_covered: [P6, P8, P7, P9]
fires_by: completion-notification cascade from background-agent runs
---

# Multi-phase rollout — P6 → P8 → P7 → P9

Orchestration plan for finishing Alertforge 2.0. Each phase ships as
one commit on `main` via a dedicated Opus 4.7 background agent.
Phases fire **sequentially**; the next phase's agent is spawned only
after the previous agent's commit lands clean.

## Order + dependency rationale

```
[running]  P6  UI                  ── routes, components, RegistryConfigForm
              ▼
           P8  outcome + digest    ── net additive; new cron + chart wire-in;
                                      writes under OLD @sentry-fixer-bot/* scope
              ▼
           P7  rename cutover      ── sweeps EVERY workspace package + every
                                      import + env keys + paths + UI strings,
                                      INCLUDING files P6 and P8 just added
              ▼
           P9  2.1 cleanup         ── drops SFB_* shims + repos_config;
                                      pre-flight backfill verify
```

- **P6 first** — backend (P4/P5) already ships the schema + adapters
  the UI needs. UI doesn't depend on rename or outcome-feedback.
- **P8 second (swapped before P7)** — outcome-feedback is purely
  additive. Writing under the old `@sentry-fixer-bot/*` scope is fine
  because P7 sweeps everything immediately after. Avoids tying a
  net-new feature's risk to the rename's hot path.
- **P7 third** — rename touches every package, every import, every
  env key, every systemd unit, every UI string. Doing it ONCE over a
  stable codebase that already includes P6 + P8 means one clean
  diff. Reversing the order means chasing newly-introduced
  `@sentry-fixer-bot/*` strings P8 left behind.
- **P9 last** — depends on P7's back-compat shims existing. Also
  expected to ship in a separate release cycle (operator-controlled);
  the agent prepares the code, operator picks the release window.

## Per-phase brief contents

Each background agent receives a self-contained brief that includes:

1. **Where the repo stands** — commits to date, test count, what's
   green, what's mid-flight.
2. **Authoritative spec + plan paths** — the agent reads these as
   the contract.
3. **In-scope files** — explicit file-level change list.
4. **Out-of-scope files** — explicit don't-touch list to prevent
   scope creep.
5. **TDD requirement** — write tests first, watch them fail, then
   implement.
6. **Commit + push protocol** — conventional-commit + trailers per
   `~/.claude/CLAUDE.md`; push direct to main (no PR enforcement on
   this repo); Co-Authored-By line.
7. **Verify-before-commit checklist** — bun test, check-types,
   biome, no-ctx-in-buildprompt lint.
8. **Stop conditions** — 3-retry budget per failure, ~USD 50-80 cost
   cap per phase.
9. **Reporting back** — final commit SHA, test count delta, design
   decisions taken, unresolved follow-ups.

### P8 brief specifics

- References `docs/alertforge/specs/2026-05-21-self-improvement-loop.md`
  and `docs/alertforge/plans/2026-05-21-phase-8-outcome-feedback.md`.
- Builds:
  - `packages/steps/outcome-poll/` — cron-driven step that polls open
    bot PRs daily for 14d post-open, records `prs.outcome`.
  - `packages/steps/daily-digest/` — cron-driven step that emits
    per-trigger 7d roll-up via the same fanOutChannels machinery.
  - Slack + email adapter extensions to render
    `notification.status === 'digest'` differently.
  - `OutcomeChart.tsx` real-data wire-in (P6 ships placeholder).
  - New cron registrations in `apps/server/src/cron/`.
- Uses **old `@sentry-fixer-bot/*` scope** intentionally. The agent's
  brief explicitly says "do NOT pre-rename to @alertforge/*; P7
  sweeps next".

### P7 brief specifics

- References `docs/alertforge/specs/2026-05-21-rename-migration.md`
  and `docs/alertforge/plans/2026-05-21-phase-7-rename.md`.
- Builds:
  - Workspace package renames `@sentry-fixer-bot/*` → `@alertforge/*`
    in every package.json (one already done: `@alertforge/core`,
    `@alertforge/source-sentry`, `@alertforge/step-*`,
    `@alertforge/channel-*`; remaining: `@sentry-fixer-bot/api`,
    `@sentry-fixer-bot/auth`, `@sentry-fixer-bot/db`,
    `@sentry-fixer-bot/env`, `@sentry-fixer-bot/ui`,
    `@sentry-fixer-bot/config`, plus the root `sentry-fixer-bot`).
  - Every import path swept across .ts/.tsx files.
  - Env keys `SFB_*` → `ALERTFORGE_*` with one-release back-compat
    reading both, warn-logging on old.
  - `/var/lib/sfb` → `/var/lib/alertforge` (symlink for compat).
  - systemd units `sfb-*` → `alertforge-*` files.
  - Branch prefix update in commit-push-only.ts + open-pr.ts.
  - Slash command: keep `/sfb`, add `/alertforge`.
  - UI strings + README rewrite.
- **Explicit instruction in brief:** sweep any `sentry-fixer-bot`,
  `@sentry-fixer-bot`, or `SFB_` literal in code authored by P6 + P8
  — don't skip newly-added files. Use `grep -rn` across the repo
  before committing to confirm zero residue (modulo intentional
  historical references in docs).
- Cutover step (manual, documented in PR body, NOT run by agent):
  - `gh repo rename alertforge`
  - `git tag alertforge-2.0.0`

### P9 brief specifics

- References `docs/alertforge/plans/2026-05-21-phase-9-cleanup.md`.
- Builds:
  - New Drizzle migration (`0008_alertforge_cleanup.sql` or
    whichever number is next free).
  - Pre-flight `DO` block: `RAISE EXCEPTION` if
    `(SELECT count(*) FROM repos_config) > (SELECT count(*) FROM
    triggers WHERE source_type='sentry')` — aborts the drop.
  - `DROP TABLE IF EXISTS repos_config`.
  - Removes `SFB_*` env-key fallback shim from
    `packages/env/src/server.ts` (now `packages/alertforge-env`
    after P7).
  - Removes `/var/lib/sfb` symlink-creation hook.
  - Removes `/sfb` slash command from `parse-mention.ts`.
  - Removes legacy re-export shims from P2/P3 file moves.

## Orchestrator verification gates

After each background-agent completion notification, this session
performs:

```bash
git fetch && git pull origin main
bun install
bun test                                                        # ≥ baseline + new
bun run check-types                                             # all packages green
bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts  # OK: no violations
```

**If any verification fails → STOP. Do not spawn next phase. Surface
the failure to the user with the failing-agent's report attached.**

If all green → spawn next phase's background agent with the
appropriate brief.

## Failure recovery protocol

| Failure type | Orchestrator action |
|---|---|
| Agent hits stop condition (3 retries, $50 cap) | Read final report. If known limitation (spec ambiguity), refine brief + re-spawn. If deeper issue, escalate to user with report. |
| Tests fail after agent commits | Stop rollout. Investigate; do NOT spawn next phase. |
| check-types fails after agent commits | Stop rollout. Investigate. |
| Lint rule fails after agent commits | Stop rollout. Investigate. |
| Agent reports "spec contradicts reality" | Escalate to user; do NOT amend specs unilaterally. |

The orchestrator session never modifies the spec/plan docs in
`docs/alertforge/` itself. Specs are the agent's contract; amending
them is a user decision.

## Cumulative cost ceiling

| Phase | Per-agent cap |
|---|---|
| P6 (running) | USD 80 |
| P8 | USD 50 |
| P7 | USD 80 (broad rename touches many files) |
| P9 | USD 30 (small surface) |

Total rollout cap: **USD 240**. If burn approaches the cap, stop and
report.

## Success criteria for the rollout

The rollout is complete when all four phases have landed clean on
`main` with the following verification gates passed at each step:

- 486+ tests pass after each phase (baseline going into P6 was 486;
  each phase adds tests).
- check-types green across all packages after each phase.
- Lint clean after each phase.
- After P7: `git grep -n "sentry-fixer-bot"` in code returns only
  intentional historical references (docs/PROGRESS.md, etc.).
- After P9: `git grep -n "SFB_\|/var/lib/sfb\|/sfb\b"` returns zero
  matches in active code (only in historical docs / commit messages).

## Out of scope (explicitly)

- Behavior-parity automated tests against the pre-rename codebase
  (manual smoke per phase suffices).
- Actual `gh repo rename` execution (operator-controlled — agent
  documents the command in PR body).
- Actual `db:migrate` execution against production (operator runs
  during a maintenance window).
- Actual `alertforge-2.0.0` and `alertforge-2.1.0` git tag pushes
  (operator-controlled release moments).
- Multi-tenant + multi-LLM-provider work (V2+, separate roadmap).

## Related

- `docs/alertforge/specs/2026-05-21-pluggable-pipeline-design.md` — umbrella spec
- `docs/alertforge/specs/2026-05-21-self-improvement-loop.md` — P8 spec
- `docs/alertforge/specs/2026-05-21-rename-migration.md` — P7 spec
- `docs/alertforge/plans/2026-05-21-phase-6-ui.md` — P6 plan
- `docs/alertforge/plans/2026-05-21-phase-8-outcome-feedback.md` — P8 plan
- `docs/alertforge/plans/2026-05-21-phase-7-rename.md` — P7 plan
- `docs/alertforge/plans/2026-05-21-phase-9-cleanup.md` — P9 plan
- `docs/alertforge/plans/2026-05-21-phase-3c-worker-flip.md` — sibling background-agent precedent
