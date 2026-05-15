# sentry-fixer-bot — Design Document

**Date:** 2026-05-15
**Status:** Draft — pre-implementation
**Owner:** TBD

## 1. Problem

Production exceptions in Sentry are noisy, repetitive, and lossy.

- A new exception fires → Sentry creates an issue → the assignee starts the same investigation flow every time: open the stack trace, find the file, read the surrounding code, hypothesise the cause, write a fix, write a test, open a PR.
- The first 80% of that loop is mechanical and well-suited to an agent: gather the trace, locate the code, propose a minimal change. The last 20% (review, merge, ship) needs human judgement.
- During incidents (auth outage, deploy regression) the same alert fires hundreds or thousands of times. Engineers context-switch into the dashboard, dismiss duplicates, then start one investigation.

We want to compress the first 80% to zero engineer-minutes and present the engineer with a reviewable draft pull request instead of a stack trace.

## 2. Users and personas

| Persona | Need | Interaction |
| --- | --- | --- |
| On-call SRE | Reduce time-to-fix for new exceptions | Receives a Slack ping with a draft PR link instead of a Sentry email |
| Backend engineer | Wants context on a recurring alert | Opens a PR the bot already wrote, reviews + commits more changes |
| Engineering manager | Wants the team to spend less time on dashboard archaeology | Tracks merge rate of bot PRs as a productivity metric |
| Security/platform team | Wants the bot to never escalate blast radius | Reviews branch protection rules, allowed repos, network egress |

## 3. Goals

- **G1**: Receive Sentry webhooks, dedupe storms, and respond to genuinely novel alerts within 60 seconds.
- **G2**: For supported repos, open a pull request with either a fix or a triage analysis within 5 minutes.
- **G3**: Never merge anything automatically. Every change is human-reviewed.
- **G4**: Bound cost. Per-repo daily token budget enforced before any agent run.
- **G5**: Auditable. Every alert → run → PR transition recorded in a queryable database. Sentry payload and run transcript archived to S3.

## 4. Non-goals

- **N1**: Not a general-purpose CI bot. It only reacts to Sentry alerts. Not a code reviewer, not a refactor tool, not a dependency updater.
- **N2**: Not multi-tenant. Not a SaaS. This is an open-source project: anyone clones the repo and deploys their own instance. One deployment serves one organisation. The project does not host anyone's data; there is no central control plane we operate. Multi-tenant SaaS hosting is a separate project that someone could build by forking this one and adding tenant tables + billing.
- **N3**: Not a Sentry replacement. We do not host or proxy Sentry data; we read from Sentry's API on demand.
- **N4**: Not auto-merge. Even high-confidence fixes are PRs, never direct commits.
- **N5**: Not a chat interface. There is no "talk to the bot" UI; humans interact via the PR.
- **N6**: Not a knowledge graph. We do not build long-term memory of fixes across alerts in V1. (Stretch goal in Phase 4.)

## 5. Success metrics

| Metric | Target (90 days post-launch) |
| --- | --- |
| Webhook → first triage comment latency | p95 < 60s |
| Webhook → PR open latency (when agent is allowed to fix) | p95 < 5 min |
| Bot-PR merge rate (without code change by human) | ≥ 25% |
| Bot-PR merge rate (with human edits on top of bot diff) | ≥ 50% |
| Duplicate alerts deduplicated correctly | ≥ 99% (no double-PRs) |
| Cost per PR | ≤ $1.50 average |
| False-positive PRs (closed without merge, no test catch) | ≤ 20% |
| Incidents caused by the bot | 0 |

## 6. Decisions locked in

The user confirmed three foundational decisions during brainstorming:

### 6.1 Agent runtime: spawn Claude Code CLI per alert

- One `claude` subprocess per alert
- Headless mode (`--print --dangerously-skip-permissions`)
- Per-alert git worktree (no shared workspace)
- Reuses Anthropic's existing tool surface (Read, Write, Edit, Bash, Grep, Glob, etc.)

**Why this and not alternatives:**

| Alternative | Why not chosen |
| --- | --- |
| Direct Claude API + custom tools | More work to re-implement file/shell tools; loses prompt caching and tool-budget benefits Claude Code already optimises |
| Paperclip company | Heavyweight; we don't need org chart / multi-agent / heartbeat for this single-purpose service |
| Static analysis only | User wants real fixes, not just triage comments |

### 6.2 Fix scope: broad (anything the LLM thinks it can fix)

- The agent decides scope itself
- High value when correct, but higher noise
- **Mitigation**: strong PR gates (always draft on test failure, branch protection requires review, daily PR cap per repo)

### 6.3 Trigger: Sentry webhook only

- No poll-fallback in V1
- Acceptable risk: if EC2 is down during a webhook, Sentry retries (per Sentry's retry policy: up to 4 retries over ~15 minutes)
- Operator monitors webhook health via CloudWatch metric on `/webhooks/sentry` 5xx rate

## 7. User flows

### 7.1 Happy path

```
Sentry        EC2 bot                                Engineer
  │              │                                       │
  ├─ webhook ───►│                                       │
  │              ├─ verify HMAC                          │
  │              ├─ dedup hash check (miss)              │
  │              ├─ insert alert row                     │
  │              ├─ enqueue triage job                   │
  │◄─ 202 ack ───┤                                       │
  │              │                                       │
  │              ├─ worker picks job                     │
  │              ├─ fetch event detail from Sentry       │
  │              ├─ Haiku classify → severity=high       │
  │              ├─ resolve repo from config             │
  │              ├─ clone repo + create branch           │
  │              ├─ spawn `claude` CLI                   │
  │              ├─ agent reads stack, edits files       │
  │              ├─ run repo tests → green               │
  │              ├─ gh pr create (ready, not draft)      │
  │              ├─ post comment on Sentry issue         │
  │              │      with PR link                     │
  │              ├─ Slack ping #oncall                   │
  │              │                                       │
  │              │             ◄─── notification ────────┤
  │              │                                       │
  │              │             reviews PR, merges ──────►│
  │              │                                       │
```

### 7.2 Storm path (Sentry fires 1000× during incident)

- First webhook → full path (triage + PR)
- Webhooks 2-1000 hit the dedup table → drop immediately, return 202
- No extra cost, no extra PRs
- Dedup key TTL: 24h or until original PR is closed (whichever first)

### 7.3 Test-failure path

- Agent makes fix
- Repo test command fails
- PR opened as **draft** with label `needs-human`
- Slack ping is **degraded** ("bot tried, tests failed, please review")
- Sentry comment includes test output

### 7.4 Budget-exceeded path

- Per-repo daily token budget hit
- New alerts get **triage-only** (no agent run)
- Sentry issue gets a comment: "Bot budget exceeded today; not attempting fix. Triage: severity=X, suspected files=Y"
- Resets at midnight UTC

### 7.5 Unknown-repo path

- Sentry alert from a project not in `repos.yaml`
- Webhook ack'd, alert logged, no work done
- Operator sees this in dashboard, adds repo to config, re-runs

## 8. Constraints

| Constraint | Source | Implication |
| --- | --- | --- |
| Single EC2 instance | Cost ceiling for V1 | No horizontal scale; concurrency bounded |
| Postgres only (no Redis) | Operational simplicity | Use `pg-boss` for queue, not BullMQ |
| GitHub-only repo hosting | Tool ecosystem | Use `gh` CLI; GitLab/Bitbucket not supported V1 |
| Anthropic Claude only | LLM provider choice | No model fallback to OpenAI/local in V1 |
| Bun 1.x, TypeScript | Team familiarity | No Go/Python rewrite |
| Public webhook endpoint | Sentry requires reachable URL | Need TLS cert, public DNS |
| Repo test command must be deterministic | Agent uses test result as PR-readiness signal | Flaky test repos → all PRs land as draft |

## 9. Open product questions

These are deferred to detailed design or first deployment:

1. **Slack vs PagerDuty for engineer notifications?** Default to Slack; PagerDuty is a future plug-in.
2. **Where does the human give feedback to improve the bot?** Phase 4 introduces a "merge rate per prompt template" tracker; no UI for direct feedback in V1.
3. **Should the bot ever close stale unmerged PRs?** Yes — after 7 days no merge + no human commit → bot closes with apology comment.
4. **What about Sentry "performance" issues (slow transactions)?** Out of scope V1. Only error issues. Performance issues require profiling tools the agent does not have.
5. **What about Sentry "session replay"?** Could enrich triage prompt. Stretch goal Phase 4.

## 10. Decision log (for future readers)

| Decision | Rationale | Alternatives rejected |
| --- | --- | --- |
| Claude Code CLI, not Anthropic SDK | Reuse existing tool surface, prompt caching, sandbox flag patterns | Custom SDK harness |
| Postgres + pg-boss, not Redis + BullMQ | One less moving part on EC2 | BullMQ |
| Haiku for triage, Opus for fix | ~10× cost saving on classification | Opus everywhere |
| HMAC-verify before dedup write | Untrusted POST could pollute dedup table | Dedup first then verify |
| Per-alert worktree, not shared clone | Concurrency safety, easy cleanup | Single clone with branch checkout |
| Draft PRs on test failure, not no-PR | Engineer still sees the bot's analysis | Comment-only on failure |
| Branch protection enforced externally | Bot can't bypass org policy | Trust the bot to not merge |
| No multi-tenant in V1 | Auth/isolation complexity not worth it for single org | Multi-tenant from day one |
