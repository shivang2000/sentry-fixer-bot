# sentry-fixer-bot — Implementation Plan

**Date:** 2026-05-15
**Companion to:** [`design.md`](design.md), [`architecture.md`](architecture.md)

This plan breaks the build into four phases. Each phase ends in a working, deployable system; later phases extend it. No phase leaves the codebase in a half-implemented state.

## Layout

```
sentry-fixer-bot/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
├── repos.yaml.example
├── docs/
│   ├── design.md
│   ├── architecture.md
│   ├── implementation-plan.md     ← you are here
│   └── planning.md
├── src/
│   ├── index.ts                   # process entrypoint dispatch (web | worker | cron)
│   ├── config.ts
│   ├── env.ts                     # zod-validated env schema
│   ├── log.ts                     # pino setup
│   ├── db/
│   │   ├── client.ts
│   │   ├── schema.sql
│   │   └── migrate.ts
│   ├── web/
│   │   ├── server.ts              # Hono app, routes mounted
│   │   ├── routes/
│   │   │   ├── health.ts
│   │   │   ├── metrics.ts
│   │   │   └── sentry-webhook.ts
│   │   └── verify-hmac.ts
│   ├── queue/
│   │   ├── boss.ts                # pg-boss init
│   │   └── jobs.ts                # job name/payload types
│   ├── alerts/
│   │   ├── dedup.ts
│   │   └── persist.ts
│   ├── triage/
│   │   ├── fetch-event.ts         # Sentry REST client
│   │   └── classify.ts            # Claude Haiku call
│   ├── agent/
│   │   ├── workspace.ts           # clone, branch, cleanup
│   │   ├── prompt.ts              # render prompt
│   │   └── spawn.ts               # claude subprocess
│   ├── gate/
│   │   └── run-tests.ts
│   ├── github/
│   │   ├── app-auth.ts
│   │   ├── pr.ts                  # gh pr create wrapper
│   │   └── pr-watch.ts            # cron poll of open PRs
│   ├── sentry/
│   │   ├── client.ts
│   │   └── comment.ts             # post triage comment
│   ├── slack/
│   │   └── notify.ts
│   ├── budget/
│   │   ├── check.ts
│   │   └── reset.ts
│   ├── archive/
│   │   └── s3.ts
│   ├── worker/
│   │   ├── triage-job.ts
│   │   ├── agent-job.ts
│   │   └── index.ts               # registers handlers
│   ├── cron/
│   │   ├── pr-poll.ts
│   │   ├── stale-pr-close.ts
│   │   ├── budget-reset.ts
│   │   └── index.ts
│   └── admin/
│       └── dashboard.ts           # minimal HTMX dashboard
├── deploy/
│   ├── systemd/
│   │   ├── sfb-web.service
│   │   ├── sfb-worker.service
│   │   └── sfb-cron.service
│   ├── nginx/sfb.conf
│   ├── ec2/
│   │   ├── userdata.sh            # AMI bootstrap
│   │   └── ami-build.md
│   └── README.md
├── scripts/
│   ├── dev-up.sh                  # docker-compose for local Postgres
│   ├── seed-fake-alert.sh         # send a fake webhook for local testing
│   └── test-claude-prompt.ts      # iterate prompts without real Sentry
└── tests/
    ├── unit/
    └── integration/
```

## Phase 1 — Webhook + triage-only (week 1)

**Goal:** Sentry webhook reliably acked, deduplicated, classified by Haiku, with a triage comment posted back to the Sentry issue. No agent spawn, no PRs.

### Why start here

Webhook ingestion and dedup are the riskiest correctness paths. Get them battle-tested before adding an LLM that can write code. If the dedup logic is broken, we will write 1000 PRs in our first incident.

### Tasks

1. Repo scaffolding (`package.json`, `tsconfig.json`, `.env.example`, `eslint`, `prettier`)
2. `src/env.ts` — zod schema for required env (`DATABASE_URL`, `SENTRY_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, `S3_BUCKET`, `LOG_LEVEL`)
3. `src/db/schema.sql` — `alerts`, `runs`, `budgets` tables (no `prs` table yet)
4. `src/db/migrate.ts` — simple runner that applies `schema.sql` idempotently
5. `src/web/server.ts` + `src/web/routes/sentry-webhook.ts`
   - reads raw body (Hono `c.req.text()`)
   - calls `verifyHmac(body, signature, secret)` (timing-safe compare)
   - on mismatch: log + 401
6. `src/alerts/dedup.ts` — `INSERT ... ON CONFLICT (dedup_key) DO UPDATE` returning `(id, is_new)`
7. `src/archive/s3.ts` — put raw payload to S3 with `sentry-payloads/{yyyy}/{mm}/{alert_id}.json` key
8. `src/queue/boss.ts` — pg-boss with the `triage` queue defined
9. `src/triage/fetch-event.ts` — Sentry REST client with retry on 429
10. `src/triage/classify.ts` — Claude Haiku call with JSON schema response; returns `{ severity, summary, suspected_files, confidence }`
11. `src/sentry/comment.ts` — POST comment to Sentry issue with triage block
12. `src/worker/triage-job.ts` — handler that fetches event → classifies → posts comment → updates `runs` row
13. `src/web/routes/health.ts` — `/healthz` that checks DB + queue
14. `deploy/systemd/sfb-web.service`, `sfb-worker.service` — minimal systemd units
15. `deploy/nginx/sfb.conf` — TLS termination, proxy_pass to 127.0.0.1:3000
16. `scripts/seed-fake-alert.sh` — curl a real-shaped Sentry payload for local testing

### Exit criteria (Phase 1 done means all of these are true)

- `bun run dev` starts web + worker locally; `./scripts/seed-fake-alert.sh` triggers a triage end-to-end and adds a comment to a real Sentry issue (or a fake one in test mode)
- HMAC verification rejects unsigned and tampered payloads (unit test)
- Dedup correctly collapses 1000 identical webhooks to a single `alerts` row (load test)
- Health endpoint returns 200 with subsystem statuses
- Deployed to a staging EC2; webhook from a real Sentry test project lands a triage comment within 60s

### Risk for this phase

- **Sentry webhook signature format change**: lock to current docs; add a feature flag to disable verification temporarily for emergencies.
- **Haiku JSON schema drift**: pin model version, validate response with zod, fall back to text-parse if structured output fails.

## Phase 2 — Agent fix + draft PRs (week 2-3)

**Goal:** For supported repos, the bot opens a real GitHub pull request with a code change proposed by Claude Opus running in a per-run worktree. PRs may be draft if tests fail.

### Tasks

1. Add `prs` table to `schema.sql`; add `pr_id` FK on `runs`
2. `repos.yaml.example` documented; loader in `src/config.ts` parses + validates with zod
3. `src/github/app-auth.ts` — GitHub App private key + installation ID → install access token (cached, refreshed)
4. `src/agent/workspace.ts`
   - `mkdtemp` under `/var/lib/sfb/work/`
   - `git clone --depth 50` with installation token
   - `git checkout -b sentry-fix/{short_id}-{ts}`
   - `chown -R sfb-runner:sfb-runner`
   - cleanup helper
5. `src/agent/prompt.ts` — renders prompt per §5 of architecture doc
6. `src/agent/spawn.ts`
   - `execa('sudo', ['-u', 'sfb-runner', 'claude', '--print', '--dangerously-skip-permissions', '--model', 'claude-opus-4-7', '--append-system-prompt', prompt])`
   - timeout 15 min
   - stream stdout to log file, stderr to log file (separated)
   - parse trailing "## Summary / Confidence / Risk" block
   - return `{ summary, confidence, risk, exitCode, tokensIn, tokensOut, costCents }`
7. `src/gate/run-tests.ts` — `execa(testCommand)` in worktree, capture exit code + last 200 lines
8. `src/github/pr.ts`
   - `git add -A && git commit -m "..."`
   - `git push origin HEAD`
   - `gh pr create --title --body --reviewer [...] [--draft]`
   - parse PR URL + number from `gh` output
9. `src/worker/agent-job.ts` — orchestrates workspace → spawn → tests → PR open → cleanup
10. `src/triage/classify.ts` extended to publish `agent` job after triage completes (if severity ≥ medium and budget allows)
11. `src/budget/check.ts` — reads today's budget row, returns `{ tokensRemaining, costRemainingCents, allowed }`
12. Sentry comment updated to include PR link
13. `tests/integration/agent-job.test.ts` — fixture-based test using a tiny test repo with a known bug

### Exit criteria

- Real Sentry alert → real PR opened within 5 min for at least one configured repo
- PR contains a coherent code change (manual eyeball verification on ~10 PRs)
- Draft PR mode triggers when test command fails
- Agent runs as `sfb-runner` (verified by `ps auxf` showing the spawned `claude` PID under the right UID)
- Worktree cleanup confirmed (no leaked dirs after 100 runs)
- Budget hard-stop kicks in: if cap is exceeded mid-day, new alerts go triage-only

### Risk for this phase

- **Agent escapes worktree** → sfb-runner has no sudo, no AWS creds. Test by `ps auxe` inspection during a run.
- **Agent commits secrets** → repo's own `.gitignore` should handle. Add a post-commit check: `git diff HEAD~1 --name-only` rejected against a denylist (`.env`, `*.pem`, `id_rsa`, etc.). Agent's commit is rolled back if any match.
- **`claude` CLI prompt injection from Sentry payload** → escape control chars; treat user-supplied breadcrumb text as opaque code-fenced.
- **`gh pr create` race when two alerts in same repo run concurrently** → branch names include `{ts}` so no collision. PR title format consistent.

## Phase 3 — Quality gates and lifecycle (week 4)

**Goal:** PRs that pass tests are promoted from draft to ready-for-review automatically. Stale PRs are closed. Per-repo daily limits applied.

### Tasks

1. `src/cron/pr-poll.ts` — every 5 min, for each `prs` row with `state=open`, call `gh pr view` and update `state`, `merged_at`, `human_commits`
2. `src/cron/stale-pr-close.ts` — find PRs `state=open AND opened_at < now() - 7 days AND human_commits = 0 AND merged_at IS NULL` → close with apology comment
3. `src/cron/budget-reset.ts` — at 00:00 UTC, insert today's budgets row for each repo (or rely on lazy upsert)
4. `src/budget/check.ts` extended to enforce **PR count cap** (e.g. max 10 PRs per repo per day) in addition to token cap
5. `src/slack/notify.ts` — webhook poster, channel from repo config; one message per PR with severity badge
6. `src/admin/dashboard.ts` — tiny HTMX page showing today's metrics: alerts in, dedup rate, PRs open, cost burn, queue depth. Protected by basic auth from `ADMIN_PASSWORD` env.
7. CloudWatch metrics emitter (`src/log.ts` extended)
8. Alarms scripted in Terraform or AWS CDK (separate sub-project at `deploy/aws-cdk/`)
9. Runbook for common ops: pause the bot, drain the queue, replay a missed webhook, rotate Anthropic key
10. Daily summary email to operator via SES: "Today: 47 alerts, 12 PRs, 3 merged, $18.50 spend"

### Exit criteria

- Cron jobs run reliably (verify via 7-day window in CloudWatch)
- PR auto-promotion works (test by toggling test command to pass after first failure)
- Stale-close has been observed in staging
- Daily summary email arrives at 09:00 UTC

## Phase 4 — Feedback loop and prompt tuning (week 5-6)

**Goal:** Measure which prompt structures and which models produce the best merge rates. No mandate to change anything; just instrument.

### Tasks

1. `runs.prompt_template_version` column added; default `v1`
2. `prs.outcome` derived column: `merged_clean | merged_with_human_edits | closed_unmerged | abandoned`
3. Weekly job: compute merge rate per template version, per repo, per severity. Export CSV.
4. A/B harness: when launching an agent job, 5% chance of using template `v2-experimental`. Both versions tracked in `runs.prompt_template_version`.
5. Add a confidence calibration check: bucket runs by reported confidence (high/medium/low), compute actual merge rate per bucket. If high-confidence merges < 60%, alarm.
6. Phase 4 deliverable: a Looker / Metabase dashboard or a Grafana board with the merge-rate metrics. Decision-making, not new behaviour.

### Exit criteria

- 4 weeks of data collected
- At least one prompt-template iteration shipped based on the data
- Confidence calibration table populated

## Cross-cutting concerns (apply to all phases)

### Testing strategy

| Test type | Coverage target |
| --- | --- |
| Unit | HMAC verification, dedup key calc, prompt rendering, S3 archive helpers — 90% line coverage on `src/{alerts,triage,agent,github,budget}` |
| Integration | End-to-end fake webhook → triage → agent → PR open using a sandbox GitHub org and a tiny test repo with intentional bugs |
| Load | k6 script sending 1000 webhooks/min for 10 min, asserting dedup works and queue does not back up indefinitely |
| Chaos | Kill `sfb-worker` mid-agent-run, verify orphan recovery on restart |

### Logging and tracing

- Every log line carries `alert_id`, `run_id` (when known), `repo`, `dedup_key` for correlation
- Trace IDs flow from webhook receive → triage → agent → PR open as a single `trace_id`

### Secrets handling

- All secrets via AWS Secrets Manager, fetched at process start
- No secret in `.env` files in production
- Local dev uses `.env` file; `.env` is `.gitignore`'d
- Anthropic key rotation: hot-reload supported (SIGHUP triggers config refetch)

### Deployment

- Infrastructure-as-code: AWS CDK (TypeScript, Bun-runtime) at `deploy/aws-cdk/`
- AMI built nightly with packer; bot deployed via systemd update on AMI swap
- Zero-downtime not required (Sentry retries webhooks)

### Documentation upkeep

- Every PR to this repo must update at least one doc if behaviour changes
- ADRs (architectural decision records) in `docs/adr/` for any decision that contradicts a Phase-1 plan
- Runbook lives in `docs/runbook.md`; treat as code

## Estimated effort

Rough order-of-magnitude, single senior engineer:

| Phase | Calendar weeks | Eng days |
| --- | --- | --- |
| Phase 1 | 1 | 4-5 |
| Phase 2 | 2 | 8-10 |
| Phase 3 | 1 | 4-5 |
| Phase 4 | 2 | 6-8 (instrumentation light, analysis heavy) |
| **Total** | **6** | **22-28** |

Add 50% buffer for unknowns: **~9 calendar weeks** for a polished V1.
