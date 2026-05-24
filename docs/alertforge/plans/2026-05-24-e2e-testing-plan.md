# Alertforge — End-to-End Testing & Smoke Verification Plan

**Date drafted:** 2026-05-24
**Status:** Plan — pre-implementation
**Triggered by:** post-rollout request to verify everything shipped in P1–P9 works end-to-end before tagging `alertforge-2.1.0` + deploying
**Supersedes:** the prior plan in this file (the Alertforge refactor itself — now SHIPPED across 23 commits on `main`)

---

## Context

Across this session, 23 commits landed on `origin/main` shipping the
full sentry-fixer-bot → alertforge 2.0 → 2.1 rollout: pluggable
pipeline runtime, source/channel adapters, triggers schema, worker
flip to `runPipeline`, UI for triggers + channels + manual URL
trigger, self-improvement loop (outcome poll + daily digest), full
rename, and 2.1 cleanup.

Current health:
- **383/383 tests pass** across 58 files
- **18 packages check-typed** clean
- **biome** clean (only pre-existing `noNonNullAssertion` warnings)
- **`no-ctx-in-buildprompt` lint** clean
- **Web + server bundles** build cleanly
- **0 stale legacy references** (`@sentry-fixer-bot`, `SFB_*`, `/var/lib/sfb`) in active code

Outstanding caveats explicitly flagged by the background agents that
shipped P3c, P5, P6, P8, P9:
- No live boot against a real Postgres + populated env file
- No real webhook fixture executed end-to-end through the new pipeline
- Production migration `0008_drop_repos_config.sql` never applied
  against a real DB
- Web component coverage thin (no apps/web Vitest rig set up)
- Several tRPC procedures added by P6 without focused unit tests
- Cron jobs (outcome-poll + daily-digest) untested against realistic
  DB fixtures
- The pluggable-adapter abstraction has never been exercised by a
  *new* adapter (only the Sentry/Slack/Email shipped with the refactor)

Intent: close every gap before tagging 2.1.0. This plan ships a
**comprehensive layered test program** (T1–T7 below) via the same
Opus-4.7 background-agent cascade pattern proven across P3c/P5/P6/P7/
P8/P9. Each layer = one commit, one verification gate, then the next
fires. Cap ≈ USD 250 across all layers.

---

## Locked decisions

| # | Decision |
|---|---|
| D1 | **Comprehensive layered plan** (chosen via brainstorming 2026-05-24). All test layers T1–T7 ship. T8 (perf/load) deferred. |
| D2 | **Sequential background-agent execution** (no parallel — each agent pushes to main; parallel risks merge conflicts). Verification gate between each. |
| D3 | **Five ship phases**: T-A (DB + routers), T-B (adapter goldens + cron), T-C (web components + Vitest rig), T-D (pluggable-adapter proof), T-E (operator E2E runbook + final smoke). |
| D4 | **TDD discipline**: every new test file is authored first (red), then implementation (if any new code is needed beyond fixture data) lands until green. Adapter goldens are pure-fixture work — no new production code expected. |
| D5 | **Target ~500–550 total tests** post-rollout. Current 383 baseline + ~150–170 new tests. Don't bloat past necessity. |
| D6 | **Operator-driven smoke** (T-E) is a MANUAL checklist, not an automated harness. Real Postgres + real GitHub App fixture + real Sentry webhook → confirm pipeline opens a real PR. Captured as runbook in `docs/alertforge/runbook-smoke.md`. |
| D7 | **No live vendor calls in automated CI tests** — Slack/Resend/Sentry HTTP is mocked. Real vendor verification is operator's smoke step at T-E. |
| D8 | **Cost cap**: USD 250 total across the five test ship phases. Each agent caps at USD 50–80. |

---

## Test layers (T1–T8)

### T1 — DB migration application + safety (in ship phase T-A)

**Goal:** prove migrations 0007 (P4 triggers schema + backfill) and
0008 (P9 drop/rename `repos_config`) apply cleanly on a fresh
Postgres + the pre-flight `DO $$` block in 0008 actually aborts when
the backfill is incomplete.

**Tests to write** (Bun test runner, real Postgres via docker compose):
- `packages/db/src/migrations/__tests__/0007-apply.test.ts` — fresh
  DB → apply 0001..0007 → assert `triggers` + `channel_configs` tables
  exist with expected columns + indexes + FKs.
- `packages/db/src/migrations/__tests__/0007-backfill.test.ts` — seed
  3 `repos_config` rows pre-migration → apply 0007 → assert
  `triggers` has 3 rows with `source_type='sentry'`,
  `preset='auto_fix'`, `config.budget.dailyTokens` carried from
  `repos_config.daily_token_cap`, `config.budget.dailyCostCents`
  carried from `repos_config.daily_cost_cap_cents`. Backfill
  `runs.trigger_id` for 2 fixture runs by joining via
  `alerts.sentry_project`.
- `packages/db/src/migrations/__tests__/0008-safety.test.ts` — pre-flight
  DO block: insert one orphan `repos_config` row (no matching
  trigger) → apply 0008 → assert exception with message
  `Cannot drop repos_config: triggers count (N) < repos_config
  count (N+1)`. Run again WITH the orphan backfilled → migration
  succeeds; `repos` table exists (renamed from `repos_config`), FKs
  on `triggers.repo_id` still resolve.
- `packages/db/src/migrations/__tests__/0008-idempotent.test.ts` —
  apply 0008 twice → second run is a no-op (table already named
  `repos`).

**Acceptance criteria:** all 4 migration test files green against a
fresh docker postgres started via `bun --filter=@alertforge/db
db:start`. Cleanup tears down test DB between cases. Reusable
fixture helper at `packages/db/src/migrations/__tests__/_fixtures.ts`.

**Files to create:**
- `packages/db/src/migrations/__tests__/0007-apply.test.ts`
- `packages/db/src/migrations/__tests__/0007-backfill.test.ts`
- `packages/db/src/migrations/__tests__/0008-safety.test.ts`
- `packages/db/src/migrations/__tests__/0008-idempotent.test.ts`
- `packages/db/src/migrations/__tests__/_fixtures.ts`
- `packages/db/src/migrations/__tests__/setup.ts` — docker compose
  helper (starts postgres on a random port for test isolation)

**Files referenced (not modified):**
- `packages/db/src/migrations/0007_natural_mandroid.sql`
- `packages/db/src/migrations/0008_drop_repos_config.sql` (P9)
- `packages/db/docker-compose.yml`

### T2 — tRPC router CRUD coverage (in ship phase T-A)

**Goal:** every public tRPC procedure exercised in unit form with
mocked DB + zod validation pass/fail cases.

**Tests to write:**
- `packages/api/src/routers/__tests__/triggers.test.ts` — list / byId
  / create / update / delete + admin-only enforcement + repoId-FK
  validation + unknown source-type rejection + `runFromUrl` happy
  path + error cases (no adapter matches, no trigger matches,
  fetchByExternalId fails).
- `packages/api/src/routers/__tests__/channels.test.ts` — list /
  byId / create / update / delete + listAdapters from registry +
  notify_on enum validation + invalid configSchema rejection.
- `packages/api/src/routers/__tests__/runs.test.ts` — list / get /
  logs + usageByTrigger + usageByStep + outcomeChart (P8 wire-in).
- `packages/api/src/routers/__tests__/repos.test.ts` — confirm CRUD
  still works against the renamed `repos` table (P9).
- `packages/api/src/routers/__tests__/setup.test.ts` — admin
  bootstrap flow + first-signup race protection.

**Approach:** mock `createDb()` via dependency injection or use a
test-DB fixture spun up once per file. The existing `cron.test.ts`
pattern is the template.

**Files to create:**
- `packages/api/src/routers/__tests__/triggers.test.ts`
- `packages/api/src/routers/__tests__/channels.test.ts`
- `packages/api/src/routers/__tests__/runs.test.ts`
- `packages/api/src/routers/__tests__/repos.test.ts`
- `packages/api/src/routers/__tests__/setup.test.ts`
- `packages/api/src/routers/__tests__/_db-fixture.ts` — shared
  fixture helper (insert one trigger, one alert, one run for query
  tests)

### T3 — Web component tests (ship phase T-C)

**Goal:** set up Vitest + happy-dom in `apps/web` + write component
tests for every non-trivial P6 component.

**One-time setup** (lands in this phase's commit):
- Add `vitest` + `@vitejs/plugin-react` + `happy-dom` (or `jsdom`)
  to `apps/web/devDependencies`.
- `apps/web/vitest.config.ts` — point at `src/**/*.test.tsx`, use
  happy-dom, alias `@/` to `./src`.
- `apps/web/src/test-setup.ts` — global setup (testing-library
  cleanup; tRPC mock provider).
- Add `"test": "vitest run"` script to `apps/web/package.json`.

**Tests to write** (≥3 per component):
- `apps/web/src/components/triggers/__tests__/PresetSelector.test.tsx`
  — renders 4 presets, fires `onChange`, shows cost estimates,
  greyed-out advanced toggles when preset≠custom.
- `apps/web/src/components/triggers/__tests__/ManualUrlTrigger.test.tsx`
  — debounced detect on blur, displays detected source, "Run" disabled
  when no matching trigger.
- `apps/web/src/components/triggers/__tests__/TriggerForm.test.tsx`
  — wizard steps render in order, validation prevents skip, submit
  fires correct tRPC mutation.
- `apps/web/src/components/triggers/__tests__/AddChannelDialog.test.tsx`
  — dropdown lists channel adapters, dynamic form renders per
  selected type, save fires correct mutation.
- `apps/web/src/components/triggers/__tests__/ChannelCard.test.tsx`
  — renders channel config, shows last-send status, fires
  edit/disable/remove handlers.
- `apps/web/src/components/triggers/__tests__/OutcomeChart.test.tsx`
  — empty state when no data; renders correct bar counts when data
  present; aria-label includes 30-day summary.
- `apps/web/src/components/__tests__/RegistryConfigForm.test.tsx`
  — renders each zod schema field type (string, url, email, number,
  boolean, enum, array-of-string); fires onChange with structured
  value.

**Acceptance criteria:** `bun --filter=web test` green. All P6
components have ≥3 tests each. Test setup is documented in
`apps/web/README.md` (new short file).

### T4 — Adapter contract golden fixtures (ship phase T-B)

**Goal:** golden fixtures for each adapter capturing real vendor
payload shapes — protects against vendor API drift without making
live calls in CI.

**Fixtures to create:**
- `packages/sources/sentry/src/__fixtures__/webhook-issue-created.json`
  — real Sentry "issue created" webhook body (sourced from Sentry
  docs or a real captured payload, redacted). Test: feeding it to
  `parsePayload(body)` produces the expected `NormalizedAlert`;
  feeding it past the HMAC verify with the matching signature
  succeeds; feeding it with a tampered signature fails.
- `packages/sources/sentry/src/__fixtures__/api-issue-detail.json`
  — real `/api/0/issues/<id>/` response. Test: `fetchByExternalId`
  with mocked fetch returning this produces the expected
  `NormalizedAlert`.
- `packages/sources/sentry/src/__fixtures__/api-event-detail.json`
  — real `/api/0/issues/<id>/events/latest/` response. Test:
  `fetchEventDetail` produces the expected `EnrichedAlert` with
  stack trace populated.
- `packages/channels/slack/src/__fixtures__/webhook-response-ok.json`
  + `.../webhook-response-rate-limited.json` — capture Slack webhook
  ACK shapes. Test: `send` succeeds on 200; throws on 429 with
  expected error message.
- `packages/channels/email/src/__fixtures__/resend-response-ok.json`
  + `.../resend-response-error.json` — capture Resend API responses.
  Test: `send` succeeds + parses `id` from response; throws on
  4xx/5xx with expected error message.

**Acceptance criteria:** every golden fixture is a real captured
payload (or a documented synthesized one matching the vendor's
schema). Tests that exercise each adapter against its goldens are
green. Total ~12 new tests across the three adapter packages.

### T5 — Cron job tests (ship phase T-B)

**Goal:** `outcome-poll` + `daily-digest` exercised against realistic
DB fixtures.

**Tests to write:**
- `packages/steps/outcome-poll/src/__tests__/poll-outcomes-integration.test.ts`
  — seed 4 PRs in the 4 outcome states (merged_clean,
  merged_with_edits, closed_unmerged, stale_open) via fixtures;
  mock GitHub API responses; run `pollOutcomes(deps)`; assert each
  `prs.outcome` + `outcome_recorded_at` + `human_commits` is
  written correctly.
- `packages/steps/outcome-poll/src/__tests__/poll-outcomes-resilience.test.ts`
  — one PR's GitHub call throws → other PRs in the same sweep
  succeed; failing PR is logged + skipped, not crashing the cron.
- `packages/steps/daily-digest/src/__tests__/build-digest-integration.test.ts`
  — seed 47 runs + 18 PRs over 7 days for a fixture trigger; call
  `buildDigest(trigger, deps)`; assert returned `DigestPayload` has
  correct counts, top-3 fingerprints ordered by recurrence + closed
  count, cost vs cap percentage.
- `packages/steps/daily-digest/src/__tests__/send-daily-digests-integration.test.ts`
  — 3 triggers (2 with digest-subscribed channels, 1 without); run
  `sendDailyDigests(deps)`; assert exactly the 2 channels receive a
  `PipelineNotification` with `status='digest'` + correct
  `digestBody`.

**Acceptance criteria:** all 4 cron integration tests green. The
human-commits classifier covered: bot-authored commits ignored,
human commits counted, empty-author commits treated as bot.

### T6 — Pluggable abstraction proof (ship phase T-D)

**Goal:** prove the source-adapter and channel-adapter abstractions
actually work for a new adapter — no core changes needed beyond
writing the adapter module + registering it.

**What ships:**
- `packages/sources/test-source/` — a complete fake source adapter
  package implementing `SourceAdapter` end-to-end. Webhook payload
  shape is a simple `{ project: string, event_id: string, title:
  string, level: string }`. `urlPatterns` matches `https://test-
  source.example/events/<id>`. `fetchByExternalId` returns a
  deterministic fixture. dedup key = sha256 of `project|event_id`.
- `packages/channels/test-channel/` — a complete fake channel
  adapter package. `send()` writes to an in-memory array (exposed
  for tests). configSchema requires `target: string`.
- Wire both in `apps/server/src/register-adapters.ts` behind an env
  flag (`ALERTFORGE_REGISTER_TEST_ADAPTERS=1`) so they're only
  active in test mode.
- `apps/server/src/pipeline/__tests__/test-adapter-e2e.test.ts` —
  end-to-end pipeline test using the test source + test channel.
  Confirms: webhook POST to `/webhooks/test-source` → adapter
  parses → trigger resolves → runPipeline executes mocked LLM steps
  → mocked GitHub PR opens → test channel receives the notification
  with correct shape.

**Acceptance criteria:** the end-to-end test passes. Adding these
two packages required **zero** changes to `@alertforge/core`,
worker handlers, routers, or schema. Negative test: confirm
`grep -r 'test-source\|test-channel' packages/alertforge-core
apps/server/src/worker` returns 0 hits (the abstraction is
genuinely pluggable).

### T7 — Operator E2E smoke runbook (ship phase T-E)

**Goal:** a step-by-step manual checklist the operator follows
BEFORE tagging `alertforge-2.1.0` and BEFORE the first production
deploy. Captures every gap automated tests can't close: real
GitHub App auth, real Sentry HMAC, real Slack/Resend delivery,
real `bun run dev` smoke through the full pipeline.

**What ships:** new file at
`docs/alertforge/runbook-smoke.md` with sections:

1. **Pre-flight checklist** — env file populated, Postgres reachable,
   migrations applied (`bun --filter=@alertforge/db db:migrate`),
   verify-backfill query returns matching counts, registry adapters
   loaded at boot.
2. **First boot** — `bun run dev`, hit `/healthz`, sign up as admin,
   land on dashboard, visit `/triggers` (empty state shown).
3. **Trigger wizard smoke** — `/triggers/new` → Sentry → fake
   project slug → fixture repo → preset auto_fix → no channels →
   save. Confirm trigger row appears in DB.
4. **Manual URL trigger smoke** — paste a real Sentry issue URL into
   the Manual URL Trigger box. Confirm: detect resolves Sentry
   adapter; matching trigger surfaces; click Run; `/runs/$id`
   surfaces live tail; pipeline progresses through steps; PR opens
   on the test repo.
5. **Webhook smoke** — generate a 256-bit hex secret via the home
   wizard, paste into Sentry Internal Integration webhook config,
   subscribe to `issue`. Fire a test alert from Sentry (or use a
   captured payload via `./scripts/seed-fake-alert.sh`). Confirm
   pipeline runs end-to-end with HMAC verification passing.
6. **Channel smoke** — add a Slack channel (use a real test
   workspace's incoming webhook); add an email channel (use
   Resend with a test domain). Use a trigger's "Test send" button.
   Confirm receipt in both.
7. **Review-pass smoke** — switch trigger preset to `auto_fix_review`;
   fire another alert; confirm reviewer LLM second pass posts a
   comment on the PR; if blocker, PR flips to draft.
8. **`/alertforge` follow-up smoke** — comment `/alertforge tighten
   the null check` on the bot PR; confirm webhook fires the
   follow-up pipeline; confirm a new commit appears on the same
   branch with a reply comment.
9. **Outcome-poll smoke** — manually merge the test PR; trigger the
   outcome-poll cron via `bun run cron:outcome-poll` (or wait for
   the daily slot); confirm `prs.outcome = 'merged_clean'` +
   `outcome_recorded_at` populated.
10. **Daily digest smoke** — manually trigger daily-digest cron;
    confirm Slack + email receive the digest layout with correct
    counts.
11. **Migration safety smoke** — on a staging copy of the prod DB,
    apply `0008_drop_repos_config.sql` and confirm the pre-flight
    `DO $$` block passes (counts match). If counts mismatch in
    prod, do NOT proceed to migrate; investigate the orphan
    `repos_config` rows first.
12. **Post-deploy tag** — once all 11 steps pass, `git tag
    alertforge-2.1.0 && git push --tags`. Then `gh repo rename
    alertforge` (already documented in P7's commit body).

Each step has a clear ✅ / ❌ checkbox + a "what to do if it
fails" pointer to the relevant spec / debugging path.

### T8 — Performance / load (DEFERRED, flagged for future spec)

Not in this plan. Future work captured as a stub at
`docs/alertforge/specs/2026-05-24-perf-load-stub.md` with a TODO
list (storm-rate dedup test, concurrent worker stress, agent
spawn latency distribution, cost-burn under realistic alert
volume) so the topic isn't forgotten.

---

## Ship phases + agent orchestration

Five sequential ship phases. Each = one Opus-4.7 background agent,
one commit on `main`, verification gate before the next fires.

| Phase | Layers | Risk | Cost cap | Approx new tests |
|---|---|---|---|---|
| **T-A** | T1 (DB migration) + T2 (router CRUD) | medium (touches DB) | USD 60 | ~40 |
| **T-B** | T4 (adapter goldens) + T5 (cron) | low | USD 40 | ~16 |
| **T-C** | T3 (web components + Vitest rig) | medium (new test rig) | USD 70 | ~25 |
| **T-D** | T6 (pluggable proof + 2 new packages) | low | USD 40 | ~5 |
| **T-E** | T7 (operator runbook + final automated smoke) + T8 stub | low | USD 30 | 0 (runbook is docs) |

Cumulative cap: **USD 240**.

Same pattern as P3c → P5 → P6 → P7 → P8 → P9: I (orchestrator)
spawn each agent in sequence, wait for completion notification,
pull + verify gates, then spawn next.

### Per-agent brief contents

Same structure proven across prior background-agent ships:
1. Where the repo stands (commits to date, test count, what's green)
2. Authoritative spec + plan paths (this file + the existing
   `docs/alertforge/` tree)
3. In-scope files + out-of-scope files
4. TDD requirement (write tests first; fixtures-first for adapter
   goldens)
5. Commit + push protocol (per `~/.claude/CLAUDE.md`)
6. Verify-before-commit checklist (test, check-types, biome,
   no-ctx-in-buildprompt lint)
7. Stop conditions (3-retry budget; cost cap)
8. Reporting back (commit SHA, test count delta, decisions made,
   unresolved follow-ups, lint confirmation)

### Orchestrator verification gates

After each agent's completion notification:
```bash
git fetch && git pull origin main
bun install
bun test                                                         # baseline + new
bun run check-types                                              # all packages green
bun packages/alertforge-core/src/lint/no-ctx-in-buildprompt.ts   # OK: no violations
bun run build                                                    # web + server bundles
```

**If any gate fails → STOP. Do not spawn next phase. Surface failure
to user with the failing-agent's report.** Pattern matched
verbatim from the multi-phase rollout plan
(`docs/alertforge/plans/2026-05-23-multi-phase-rollout.md`).

### Failure recovery

Same protocol as the rollout plan: agent stop-condition → read
final report → if known limitation (spec ambiguity), refine brief +
re-spawn; if deeper issue (spec contradicts reality), escalate to
user, do NOT fire downstream phases. Orchestrator never modifies the
spec (this file) unilaterally — that's a user decision.

---

## Critical files referenced by this plan

### Existing tests (baseline 383 across 58 files — DO NOT modify in
this plan unless adding adjacent fixtures):

- `packages/alertforge-core/src/{ctx-store,preset,pipeline,llm-step,hmac}.test.ts`
  + `lint/no-ctx-in-buildprompt.test.ts` — core abstractions (6 files)
- `packages/sources/sentry/src/{adapter,dedup,parse-payload,parse-url}.test.ts`
  — Sentry adapter (4 files)
- `packages/channels/{slack,email}/src/adapter.test.ts` — channel
  adapters (2 files)
- `packages/steps/*/src/__tests__/*.test.ts` — per-step + worker
  wrapper coverage (~30 files)
- `apps/server/src/pipeline/__tests__/{run-pipeline,run-followup-pipeline}.integration.test.ts`
  — end-to-end pipeline (2 files)
- `apps/server/src/pipeline/wrappers/__tests__/*.test.ts` — 12
  wrapper unit tests
- `packages/api/src/routers/{cron,triggers.detect,describe-schema}.test.ts`
  — partial router coverage (3 files; T2 adds more)
- `packages/api/src/run/npm-runner.test.ts`, `packages/api/tests/skills-*.test.ts`
  — utility tests (3 files)
- `apps/server/src/{chat/url-detector,secrets/shell-quote,routes/__tests__/github-webhook,__tests__/legacy-path-symlinks}.test.ts`
  — server-side helpers (note: legacy-path-symlinks deleted by P9
  — confirm before referencing)

### Existing code surfaces tested by this plan:

- `packages/db/src/migrations/{0007_natural_mandroid,0008_drop_repos_config}.sql`
- `packages/db/src/schema/{triggers,admin,domain}.ts`
- `packages/api/src/routers/{triggers,channels,runs,repos,setup}.ts`
- `apps/web/src/components/triggers/*.tsx` (P6 components)
- `apps/web/src/components/RegistryConfigForm.tsx`
- `packages/sources/sentry/src/{adapter,parse-payload,parse-url,sentry-client}.ts`
- `packages/channels/{slack,email}/src/adapter.ts`
- `packages/steps/outcome-poll/src/*.ts`
- `packages/steps/daily-digest/src/*.ts`
- `apps/server/src/register-adapters.ts`
- `apps/server/src/pipeline/{default-steps,followup-steps,deps-factory}.ts`

### Functions to reuse from existing tests:

- `packages/sources/sentry/src/parse-payload.test.ts` exports fixture
  helpers for valid Sentry payload shapes
- `apps/server/src/pipeline/__tests__/fixtures.ts` already has mock
  factories for `PipelineContext`, `StepDeps`, mock model provider,
  mock GitHub client — reuse for T2 + T5 + T6
- `packages/api/src/routers/cron.test.ts` shows the pattern for
  testing a tRPC procedure with mock context — copy for T2

---

## Verification

End-to-end success criteria for the plan as a whole:

| Gate | Acceptance |
|---|---|
| Total test count | ≥ 480 (baseline 383 + ~100 conservative) |
| Tests still passing | 100% (0 fail) |
| check-types | green across all packages |
| biome | no new errors (warnings consistent with baseline) |
| `no-ctx-in-buildprompt` lint | OK: no violations |
| Web bundle build | clean |
| Server bundle build | clean |
| Migration 0007 application test | green |
| Migration 0008 application test (incl. safety) | green |
| Adapter goldens for Sentry + Slack + email | green |
| Cron integration tests | green |
| Pluggable adapter proof | passes; no core changes needed |
| Operator E2E runbook | written + reviewed |

After T-A through T-E all land:
- `docs/alertforge/runbook-smoke.md` exists
- Operator can follow the 12-step smoke checklist before deploy
- Tag `alertforge-2.1.0` is safe to push
- `gh repo rename alertforge` is safe to execute

---

## Out of scope (deferred)

- **T8 perf/load** — stubbed at `docs/alertforge/specs/2026-05-24-perf-load-stub.md`; not implemented this plan
- **Live vendor verification in CI** — Slack/Resend/Sentry HTTP
  mocked at test layer; real-vendor verification is operator's
  smoke step at T-E
- **Multi-tenant / multi-LLM-provider testing** — those features
  don't ship in 2.x; testing them is future work
- **Browser E2E (Playwright/Cypress)** — web component tests in T3
  cover the surfaces; full browser-driver E2E is post-2.1
- **Migrating the existing `parse-output.test.ts` etc. into proper
  Vitest** — they work as bun:test today, no migration needed
- **CI infrastructure changes** (parallel test sharding, coverage
  reporting, etc.) — out of scope; existing single-shot `bun test`
  is sufficient at this scale

---

## Background-agent execution checklist (for the orchestrator)

When the user approves this plan:

1. Spawn T-A agent (Opus 4.7, max effort, background) with a
   self-contained brief drawing from this file's T1 + T2 sections
   + the per-agent brief template above.
2. Wait for completion notification.
3. Run orchestrator verification gates.
4. If green → spawn T-B agent with T4 + T5 brief.
5. Repeat for T-C, T-D, T-E.
6. After T-E lands, post a final session summary noting:
   - Total tests added across T-A through T-E
   - The 12-step operator runbook is ready at
     `docs/alertforge/runbook-smoke.md`
   - Operator can proceed to tag + deploy whenever ready

If any gate fails: STOP, escalate to user with the failing agent's
report, do not fire downstream phases.

---

## Related

- `docs/alertforge/plans/2026-05-23-multi-phase-rollout.md` — the
  P6→P8→P7→P9 orchestration plan; same pattern, just shipped
- `docs/alertforge/specs/` — all 9 specs that defined the
  abstractions now being tested
- `docs/alertforge/plans/` — per-phase plans for P1 through P9
- `~/.claude/CLAUDE.md` — commit_protocol, model_routing, agent_catalog
