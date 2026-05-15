# sentry-fixer-bot — Architecture

**Date:** 2026-05-15
**Companion to:** [`design.md`](design.md), [`implementation-plan.md`](implementation-plan.md)

This document describes the **how**. For the **what** and **why**, see [`design.md`](design.md).

## 1. Deployment topology

```
                    ┌────────────────────────────────────┐
                    │ Sentry (SaaS)                      │
                    └──────────────┬─────────────────────┘
                                   │ HTTPS POST /webhooks/sentry
                                   │ X-Sentry-Signature: hmac(secret, body)
                                   │
                                   ▼
              ┌─────────────────────────────────────────────────┐
              │ Route53 DNS  →  ACM cert  →  nginx (443)        │
              └──────────────┬──────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ EC2 t3.medium (Ubuntu 24.04 LTS)                                         │
│ Region: us-east-1                                                        │
│                                                                          │
│  systemd: sfb-web.service ───► node dist/web.js   (port 3000, behind nginx) │
│  systemd: sfb-worker.service ─► node dist/worker.js (no port, db consumer)  │
│  systemd: sfb-cron.service ──► node dist/cron.js   (daily budgets reset)    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Local services                                                 │    │
│  │  • Postgres 16 (RDS in prod, local for dev)                     │    │
│  │  • Filesystem: /var/lib/sfb/                                    │    │
│  │      ├── work/{run_id}/        (per-run git worktrees)          │    │
│  │      ├── logs/                  (run transcripts, rotated)      │    │
│  │      └── cache/                 (anthropic prompt cache, npm)   │    │
│  │  • OS user: sfb-runner (uid 4000, no sudo, no AWS creds)        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Outbound network allowlist (iptables OUTPUT chain):                     │
│    api.anthropic.com           (LLM)                                     │
│    api.github.com              (PR + repo metadata)                      │
│    github.com                  (git clone via HTTPS)                     │
│    sentry.io / *.sentry.io     (event detail fetch)                      │
│    registry.npmjs.org          (build-time only; agent does not install) │
│    169.254.169.254             (EC2 metadata for IAM role)               │
│    s3.amazonaws.com            (archive run logs + Sentry payloads)      │
│  ALL OTHER EGRESS BLOCKED.                                               │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
              ┌──────────────────────────────────────────────┐
              │ AWS S3: sfb-archives-{env}                   │
              │   sentry-payloads/{yyyy}/{mm}/{alert_id}.json│
              │   run-logs/{yyyy}/{mm}/{run_id}.log.zst      │
              └──────────────────────────────────────────────┘

              ┌──────────────────────────────────────────────┐
              │ AWS Secrets Manager                          │
              │   /sfb/prod/sentry-webhook-secret            │
              │   /sfb/prod/anthropic-api-key                │
              │   /sfb/prod/github-app-installation          │
              │   /sfb/prod/db-password                      │
              └──────────────────────────────────────────────┘
```

## 2. Process model

Three long-running Node processes managed by systemd:

| Process | Purpose | Concurrency |
| --- | --- | --- |
| `sfb-web` | HTTP server (Hono). Receives Sentry webhooks, exposes health/metrics, serves a tiny admin dashboard. | Single process; Hono is async, handles >1k req/s easily for our load. |
| `sfb-worker` | Consumes the `pg-boss` queue. Runs triage, agent spawn, test gate, PR open. | One process, **bounded internal concurrency of 3** (configurable). Pg-boss claims jobs atomically. |
| `sfb-cron` | Periodic tasks: budget reset, stale-PR cleanup, dedup-table prune, S3 archive flush. | Single process, cron-driven. |

All three connect to the same Postgres. State lives in Postgres; the processes are stateless.

## 3. Data model

PostgreSQL 16. Schema in `src/db/schema.sql`. All tables `companyId`-scoped omitted because V1 is single-tenant.

### `alerts`

One row per **deduplicated** Sentry alert. Storms collapse to one row.

```sql
CREATE TABLE alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sentry_issue_id TEXT NOT NULL,
  sentry_project  TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  code_version    TEXT,                        -- release tag from Sentry payload
  dedup_key       TEXT NOT NULL,               -- hash(project, fingerprint, code_version)
  title           TEXT NOT NULL,
  level           TEXT NOT NULL,               -- error | warning | info from Sentry
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  webhook_count   INT NOT NULL DEFAULT 1,      -- bumped on dedup hits
  raw_payload_s3  TEXT NOT NULL,               -- s3:// key
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dedup_key)
);
CREATE INDEX alerts_sentry_issue_id_idx ON alerts (sentry_issue_id);
CREATE INDEX alerts_created_at_idx ON alerts (created_at DESC);
```

### `runs`

One row per **attempt** by the worker. An alert can have up to 2 runs (initial + 1 retry).

```sql
CREATE TABLE runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id         UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  repo             TEXT NOT NULL,              -- e.g. acme-corp/api
  branch           TEXT,                       -- sentry-fix/{short_id}-{ts}
  status           TEXT NOT NULL,              -- queued | triaging | agenting | testing | pr_opened | failed | budget_blocked | duplicate_pr
  severity         TEXT,                       -- low | medium | high | critical (from triage)
  triage_summary   TEXT,
  suspected_files  JSONB,                      -- string[]
  agent_pid        INT,
  agent_exit_code  INT,
  tokens_input     INT NOT NULL DEFAULT 0,
  tokens_output    INT NOT NULL DEFAULT 0,
  cost_cents       INT NOT NULL DEFAULT 0,
  test_passed      BOOLEAN,
  pr_id            UUID REFERENCES prs(id) ON DELETE SET NULL,
  log_s3           TEXT,                       -- archived after run
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  error            TEXT,                       -- if status=failed
  retry_of         UUID REFERENCES runs(id)
);
CREATE INDEX runs_alert_id_idx ON runs (alert_id);
CREATE INDEX runs_status_idx ON runs (status);
```

### `prs`

One row per pull request the bot has opened.

```sql
CREATE TABLE prs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id        UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,
  number          INT NOT NULL,
  url             TEXT NOT NULL,
  state           TEXT NOT NULL,              -- open | merged | closed
  is_draft        BOOLEAN NOT NULL,
  needs_human     BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  merged_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  human_commits   INT NOT NULL DEFAULT 0,     -- updated by `gh pr view` poll in cron
  UNIQUE (repo, number)
);
```

### `budgets`

Per-repo daily token budget.

```sql
CREATE TABLE budgets (
  repo               TEXT NOT NULL,
  date               DATE NOT NULL,           -- UTC day
  tokens_used        INT NOT NULL DEFAULT 0,
  cost_cents         INT NOT NULL DEFAULT 0,
  cap_tokens         INT NOT NULL,            -- copied from repo config at insert
  cap_cost_cents     INT NOT NULL,
  PRIMARY KEY (repo, date)
);
```

### `repo_config` (file, not DB)

Static configuration; lives at `/etc/sfb/repos.yaml`. Reloaded on SIGHUP.

```yaml
repos:
  - sentry_project: backend-api
    github: acme-corp/api
    test_command: pnpm test --run
    daily_token_cap: 1_000_000
    daily_cost_cap_cents: 2500          # $25/day
    slack_channel: "#oncall-backend"
    pr_reviewers: ["@acme-corp/backend"]
    branch_protection_required: true
  - sentry_project: web-frontend
    github: acme-corp/web
    test_command: pnpm test:ci
    daily_token_cap: 500_000
    daily_cost_cap_cents: 1500
    slack_channel: "#oncall-web"
    pr_reviewers: ["@acme-corp/web"]
    branch_protection_required: true
```

## 4. End-to-end sequence

Successful happy path. Each step references the file/function that owns it.

```
1. Sentry webhook hits nginx → forwarded to sfb-web:3000
2. POST /webhooks/sentry handler:
     a. read raw body
     b. verify X-Sentry-Signature HMAC-SHA256 against SENTRY_WEBHOOK_SECRET
        (timing-safe compare; reject 401 if mismatch)
     c. parse JSON
     d. compute dedup_key = sha256(project + fingerprint + code_version)
     e. INSERT ... ON CONFLICT (dedup_key) DO UPDATE
        SET webhook_count = webhook_count + 1, last_seen_at = now()
        RETURNING id, (xmax = 0) as is_new
     f. if is_new:
          - upload raw payload to S3
          - pg-boss publish('triage', { alert_id })
        else:
          - just log and return 202
     g. respond 202 Accepted in <100ms (all heavy work is async)

3. sfb-worker consumes 'triage' job:
     a. SELECT alert by id
     b. fetch Sentry event detail via Sentry API
        GET https://sentry.io/api/0/issues/{sentry_issue_id}/events/latest/
     c. read project's repo config → resolve github repo, test_command, caps
     d. check budgets table for today's row
        if tokens_used >= cap → mark run status=budget_blocked, post Sentry comment, return
     e. call Claude Haiku with structured output schema:
        { severity, summary, suspected_files: string[], confidence: 0..1 }
        (small prompt, ~$0.001 per call)
     f. INSERT into runs (status='triaging', severity, triage_summary, ...)
     g. pg-boss publish('agent', { run_id })

4. sfb-worker consumes 'agent' job:
     a. SELECT run by id, JOIN alerts, JOIN config
     b. workspace prep:
        - mktemp dir under /var/lib/sfb/work/{run_id}/
        - git clone --depth 50 https://x-access-token:{TOKEN}@github.com/{repo}.git
        - git checkout -b sentry-fix/{short_id}-{ts}
        - chown -R sfb-runner:sfb-runner work/
     c. build prompt (see §5)
     d. spawn:
        sudo -u sfb-runner \
          claude --print \
                 --dangerously-skip-permissions \
                 --model claude-opus-4-7 \
                 --append-system-prompt "$(cat prompt.txt)" \
                 < /dev/null
     e. capture stdout + stderr to /var/lib/sfb/logs/{run_id}.log
     f. parse Claude's final message for any structured tail (e.g. "## Summary")
     g. UPDATE runs SET status='testing', tokens_*=..., cost_cents=...
     h. cd work/{run_id} && eval "$test_command"
        timeout 5 minutes
        record exit code → test_passed
     i. git add -A && git commit -m "fix: {alert.title} (sentry {short_id})"
        git push origin HEAD
     j. gh pr create --title "[sentry-fix] {short_id}: {title}" \
                     --body "$(see §6 for PR template)" \
                     {--draft if !test_passed} \
                     --reviewer "{config.pr_reviewers}"
     k. INSERT into prs, UPDATE runs SET status='pr_opened', pr_id=...
     l. post Sentry comment via Sentry API: "Bot opened PR: {url}"
     m. Slack ping to config.slack_channel
     n. cleanup: rm -rf work/{run_id}; archive log to S3; UPDATE budgets

5. sfb-cron runs every 5 minutes:
     a. for each open bot PR: GET /repos/{repo}/pulls/{number}
        update state, merged_at, human_commits
     b. for each PR open >7d with no merge + no human commits:
        gh pr close {url} --comment "..."
        UPDATE prs SET state='closed', closed_at=now()
     c. prune alerts older than 30 days from dedup table

6. sfb-cron runs at 00:00 UTC:
     a. INSERT new row into budgets for each repo for today's date
        (alternative: just let the per-day query insert lazily on first hit)
```

## 5. Agent prompt construction

The prompt is the contract between the bot and Claude. Stored in `src/agent/prompt.ts` and rendered per-run.

Structure:

```
[system]
You are an automated SRE agent. You are inside a git worktree of {repo}.
Your job is to investigate a Sentry alert and write a minimal, correct fix.

HARD RULES:
- Only modify files needed to fix this specific error.
- Do NOT refactor unrelated code.
- Do NOT add new dependencies.
- Do NOT change build configuration, lint configuration, or CI workflows.
- Write or update at least one test that fails before your change and passes after.
- If you cannot identify a fix with high confidence, write a triage comment in
  a new file SENTRY_TRIAGE.md instead. Do not guess.
- When done, output a final block:
  ## Summary
  <one paragraph>
  ## Confidence
  <high | medium | low>
  ## Risk
  <one paragraph: what could break>

[user]
Sentry alert:
  Project: {project}
  Issue: {sentry_issue_id} ({short_id})
  Title: {title}
  Level: {level}
  First seen: {first_seen_at}
  Release: {code_version}

Stack trace:
{stack_trace}

Breadcrumbs (last 20):
{breadcrumbs}

User impact:
  Users affected: {users_affected}
  Events in last 24h: {event_count_24h}

Triage classification (from a smaller model):
  Severity: {severity}
  Suspected files: {suspected_files}
  Summary: {triage_summary}

You may explore the repo. Use Read, Glob, Grep, Edit, Write, Bash.
The test command is: {test_command}
Run it before opening any PR.
```

`★ Design note`: We pass the Haiku triage output as a *hint* not a constraint. The Opus agent can disagree with the suspected-files list and choose differently. This is intentional — the cheap model is wrong sometimes, and we want the expensive model to override.

## 6. PR body template

```markdown
## 🤖 sentry-fixer-bot

**Sentry issue:** [{short_id}: {title}]({sentry_url})
**Severity:** {severity}
**Confidence:** {confidence}
**Users affected:** {users_affected}
**Events in last 24h:** {event_count_24h}

### Summary
{agent_summary}

### Risk
{agent_risk}

### Test status
- Command: `{test_command}`
- Result: ✅ passing / ⚠️ FAILED — see run log

### Audit
- Run ID: `{run_id}`
- Model: `claude-opus-4-7`
- Tokens: {tokens_input} in / {tokens_output} out
- Cost: ${cost_dollars}
- Run log: [s3://...]({log_url})

---
This PR was generated by sentry-fixer-bot. **Always human-review before merging.**
This bot will never merge its own PRs.
```

## 7. Security model

| Concern | Mitigation |
| --- | --- |
| **Webhook spoofing** | HMAC-SHA256 verification with timing-safe compare. Secret in Secrets Manager. |
| **Agent prompt injection from Sentry payload** | Sanitise stack frames to strip control characters; treat user-supplied breadcrumb text as opaque, escape in prompt. |
| **Agent escapes the worktree** | Run `claude` as low-priv user `sfb-runner` with no sudo, no AWS creds env. Workspace is per-run, deleted after. |
| **Agent steals secrets via Bash** | sfb-runner has no AWS credentials in env. `.env` files in cloned repos are gitignored — we do not provide them. The bot **cannot run the app**, only `test_command`. |
| **Agent pushes to main** | Branch protection on main rejects direct pushes. Bot GitHub App has `contents: write` but not `admin`. Even if it tried `git push origin main`, GitHub rejects. |
| **Agent merges its own PR** | Bot GitHub App has `pull_requests: write` (open + comment) but not `pull_requests: admin` (merge). Bot literally cannot click merge. |
| **Token theft via memory** | Anthropic key and GitHub token loaded from Secrets Manager at process start, not stored on disk. |
| **Run log leaks** | S3 bucket private, encrypted at rest (SSE-KMS). IAM role on EC2 has put-only, not read-back. Engineers fetch via signed URL through admin endpoint. |
| **DoS via webhook flood** | nginx rate-limits `/webhooks/sentry` to 100 req/s per source IP. Pg-boss queue is bounded; if backlog > 1000 jobs, alerts go to a holding table and are processed later. |
| **Repo not in config** | Webhook handler refuses unknown `sentry_project`. Alert is logged, payload not stored to S3. No agent work. |

## 8. Observability

- **Logs**: pino JSON → stdout → systemd-journald → CloudWatch agent → CloudWatch Logs group `/sfb/{env}`.
- **Metrics**: emit StatsD lines from the app, forwarded by CloudWatch agent. Key gauges:
  - `sfb.webhook.received` (counter, label: project)
  - `sfb.webhook.dedup_hit` (counter)
  - `sfb.run.duration_ms` (histogram)
  - `sfb.run.status` (counter, label: status)
  - `sfb.run.cost_cents` (counter, label: repo)
  - `sfb.pr.opened` (counter, label: repo, draft)
  - `sfb.pr.merged` (counter, label: repo)
- **Alarms** (CloudWatch):
  - `sfb-web` 5xx rate > 1% for 5 min → SNS to on-call
  - Worker queue depth > 100 for 10 min → SNS
  - Daily cost > 80% of cap → Slack warning
  - Daily cost > 100% of cap → bot auto-pauses, Slack alert
- **Dashboard**: a single Grafana panel: alerts in, PRs out, dedup rate, cost burn, queue depth, error rate. Hosted on the same EC2 in V1.

## 9. Failure modes and recovery

| Failure | Detection | Recovery |
| --- | --- | --- |
| EC2 instance dies | CloudWatch instance health check | Auto-recover via ASG of size 1; on boot, sfb-worker scans `runs` for status in (`triaging`, `agenting`, `testing`) older than 10 min and marks them `failed` (operator can retry manually). |
| Postgres connection drops mid-run | pg-boss connection retry | Job is not acked → re-delivered to another worker process (or same process after reconnect). |
| `claude` CLI hangs | Spawn timeout (15 min wall clock) | Kill process group, mark run failed, no PR. |
| `git push` fails (network blip) | Exit code | Retry once with backoff; if still failing, mark run failed, keep workspace, alert operator. |
| `gh pr create` fails (GitHub down) | Exit code | Retry with backoff (max 5 attempts over 10 min); if still failing, save the diff to S3 and mark run as `failed_pr_open` so operator can manually `gh pr create` later. |
| Test command flakes | We re-run test once on failure | If second run also fails → open as draft, label `tests-flaky`. |
| Sentry API rate limit | 429 response | Exponential backoff up to 5 min; if still 429, mark triage failed (we still have the webhook payload, just no event detail). |
| Daily budget exhausted | `budgets.tokens_used >= cap` check before triage | Move to triage-only mode (just classify, comment on Sentry, no agent). |
| Disk full on /var/lib/sfb | Hourly check by `sfb-cron` | Force-prune oldest worktrees; alert operator. |
| Postgres disk full | RDS alarm | Manual intervention. Bot stops accepting webhooks (returns 503) until cleared. |

## 10. Why these tech choices

| Choice | Reason | What it costs |
| --- | --- | --- |
| **Node 20 + TypeScript** | Reuses team skills, large ecosystem, good GitHub/Sentry SDKs | Slightly higher RAM than Go for the worker |
| **Hono over Express** | 4× faster, smaller bundle, better typing | Less middleware ecosystem |
| **pg-boss over BullMQ** | One less daemon (no Redis), transactional `enqueue on insert` | Lower throughput ceiling (~1k/s vs 50k/s — fine for our load) |
| **Postgres over SQLite** | Multi-process safe (web + worker + cron), RDS managed | More ops than embedded DB |
| **Claude Code CLI over Anthropic SDK** | Reuses tool surface, prompt caching, dangerously-skip-permissions semantics already debugged | Adds a subprocess hop |
| **Single EC2 over Lambda** | Long-running agent (5+ min) blows Lambda 15-min limit; cold starts hurt p95; workspace state needs disk | EC2 maintenance, ASG of 1 not 100 |
| **gh CLI over Octokit** | Handles GitHub App auth refresh, branch creation, PR open with one command. Battle-tested. | Subprocess overhead |
| **systemd over PM2** | First-class on Ubuntu, no extra layer | Less convenient dev experience |
| **CloudWatch over Datadog/Honeycomb** | No extra vendor for V1, IAM-native | Less ergonomic queries |

## 11. What this architecture cannot do

These are out of scope V1; documented so we know what to add later:

- **Multi-region**: single us-east-1 deploy. If AWS region is down, bot is down. No replication. Phase 4 candidate.
- **Multi-tenant**: one Anthropic key, one GitHub App, one Sentry org. Adding tenants needs auth + isolation + per-tenant budget. Phase 5+.
- **Self-improvement loop**: the bot does not learn from merged vs closed PRs in V1. Phase 4 introduces a tracker; turning that into prompt updates is later.
- **Cross-repo fixes**: agent works in one repo per run. If the bug spans two repos, the bot will pick the one in the stack trace's top frame. Out of scope to fix the other.
- **Performance issues**: only Sentry "error" issues. Performance, profiling, replay — out of scope.
- **Non-GitHub hosts**: GitLab, Bitbucket, self-hosted Forgejo not supported. Would require a second adapter.
