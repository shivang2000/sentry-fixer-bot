# sentry-fixer-bot — Planning

**Date:** 2026-05-15
**Companion to:** [`design.md`](design.md), [`architecture.md`](architecture.md), [`implementation-plan.md`](implementation-plan.md)

This document covers operational planning: timeline, risks, dependencies, rollout, monitoring, cost, and open questions. Read this last; it assumes you have read the other three.

## 1. Timeline

```
Week  1   2   3   4   5   6   7   8   9
      │   │   │   │   │   │   │   │   │
P1 ───┤                                       Webhook + triage-only
P2     ───────┤                               Agent + draft PRs
P3              ───┤                          Quality gates + ops
P4                  ───────┤                  Feedback loop + tuning
Buffer                         ───────┤       Bug fixes, prod stabilise
```

Single-engineer base estimate: **6 weeks**.
With buffer for incidents, vacation, scope drift: **9 weeks** to a stable V1.

If the project has 2 engineers, Phases 1 and 2 cannot meaningfully be parallelised (Phase 2 depends on Phase 1's data model and queue). Phase 3 and Phase 4 can run in parallel after Phase 2 lands. Two-engineer estimate: **6 weeks calendar**.

## 2. Dependencies

### Outside our team

| Dependency | What we need | What if missing |
| --- | --- | --- |
| Sentry plan with webhooks | Internal Integrations or Webhooks feature; available on Team plan+ | Bot cannot launch; fallback is polling Sentry API on a cron (slower, more API quota burn) |
| GitHub App for the org | App with `contents: write`, `pull_requests: write`, `metadata: read` scopes installed on target repos | Cannot open PRs; manual personal access token is a worse fallback (PR author shows as a real human) |
| AWS account access | EC2, RDS, S3, Secrets Manager, IAM | Could deploy elsewhere (Fly.io, Render) with similar architecture |
| Anthropic API quota | ~$300/month for moderate volume; raise rate limits if alerts spike | Bot pauses; alerts go to triage-only queue |
| DNS subdomain (e.g. `sfb.example.com`) | A record + TLS cert | Cannot receive webhooks |
| Slack workspace and incoming-webhook URLs | One per oncall channel | Notifications fall back to email |

### Internal preconditions

- Each repo that opts in must have:
  1. A deterministic test command (`pnpm test --run`, `pytest -x`, etc.) that exits non-zero on failure
  2. Branch protection on default branch (rejects direct pushes, requires PR review)
  3. A CODEOWNERS file or named reviewers for bot PRs
  4. Reasonable repo size (`--depth 50` clone < 500MB)
- Sentry project tags include a `release` value so we can dedupe by code version (otherwise dedup only covers `(project, fingerprint)`)

## 3. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| **Bot opens a PR with a wrong fix** | High | Medium (humans review) | Test gate; draft on failure; explicit `confidence` in PR body; track merge rate; tune prompt |
| **Bot commits a secret it found in repo** | Low | High | Pre-push secret scanner; revoke + rotate runbook documented; `gitleaks` in CI inside agent's workspace |
| **Bot enters infinite loop** | Low | Medium (cost) | 15-min spawn timeout; daily token cap; max 2 retries per alert |
| **Sentry sends webhook storm during incident** | High | Medium (cost + queue depth) | Dedup-first; bounded worker concurrency; alert on queue backlog |
| **Anthropic outage** | Medium | Medium | Webhook still ack'd; jobs accumulate in queue; resume when API returns |
| **GitHub outage** | Medium | Medium | `gh pr create` retry with backoff; orphan worktrees cleaned up by cron |
| **Postgres disk fills** | Low | High | RDS alarms; cron prunes alerts older than 30 days |
| **Bot PR is malicious due to prompt injection** | Low (we control payload) | High | Sanitise Sentry-supplied strings; review-required branch protection means a human still has to approve |
| **EC2 instance dies during a long run** | Medium | Low | Workspace cleaned on boot; alert auto-retried once via `runs.retry_of` |
| **Repo has flaky tests, every PR is draft** | High | Low | `tests-flaky` label visible to operators; tune retry count per repo |
| **Cost overrun** | Medium | Medium | Daily cap per repo; operator sees burn rate in Slack; auto-pause at 100% cap |
| **GDPR / PII in Sentry payload archived to S3** | Medium | High (compliance) | Configurable PII scrubber on archive; document retention policy; KMS encryption |
| **Engineers stop trusting bot PRs and ignore them** | Medium | High (project value lost) | Measure merge rate weekly; if < 25% by week 12, pause and re-evaluate prompt strategy |

## 4. Rollout plan

### Internal alpha (week 7)

- Deploy to staging EC2
- Wire one repo only: the bot's own repo (`sentry-fixer-bot`)
- Generate fake Sentry alerts with a script
- Verify end-to-end flow over 1 week
- Team reviews and merges 5+ bot-authored PRs

### Limited beta (week 8)

- Wire 2 production repos with low-risk profiles
- Bot runs in **PR draft only** mode regardless of test result for the first 3 days
- Promote to normal mode (passing tests → ready PR) after 3 days of clean operation
- Daily review meeting for the first week to triage false-positive PRs

### General rollout (week 9+)

- Add repos one per week
- Each new repo starts in draft-only mode for 3 days
- Per-repo daily caps enforced; default $25/day, raise on request after 2 weeks of clean data
- Engineering manager owns the merge-rate dashboard

### Kill switch

- A single env flag `SFB_ENABLED=false` in Secrets Manager → on next process refresh, bot stops processing webhooks
- Webhooks continue to be ack'd 202 so Sentry doesn't retry forever
- Documented in `docs/runbook.md`

## 5. Monitoring and alerts

| Signal | Threshold | Action | Channel |
| --- | --- | --- | --- |
| Webhook 5xx rate | > 1% for 5 min | Page on-call | PagerDuty |
| Worker queue depth | > 100 for 10 min | Slack warning | #sfb-ops |
| Average run duration | > 10 min | Slack warning | #sfb-ops |
| Run failure rate | > 30% for 1 hour | Slack warning | #sfb-ops |
| Daily cost | > 80% cap | Slack info | #sfb-ops |
| Daily cost | > 100% cap | Bot auto-pause; Slack alert | #sfb-ops + email |
| Disk usage on `/var/lib/sfb` | > 80% | Cron prune; Slack info | #sfb-ops |
| Bot PR merge rate (rolling 7-day) | < 20% | Slack info; review prompt | #sfb-ops |
| Bot PR closed-without-merge rate | > 50% | Slack info; review prompt | #sfb-ops |

Dashboards:
- **Live ops** (Grafana): queue depth, runs/min, cost burn, error rate
- **Quality** (Metabase): merge rate, confidence calibration, per-repo trends

## 6. Cost projection

Per-alert cost breakdown (estimates; tune after real data):

| Item | Cost |
| --- | --- |
| Haiku triage | ~$0.001 per alert |
| Opus agent (5 min, ~50k tokens in/out) | ~$1.00-1.50 per fix attempt |
| Sentry API calls | negligible (within plan) |
| GitHub API calls | negligible |
| S3 storage (~10KB payload + 200KB log per alert, 90-day retention) | ~$0.01 per 1000 alerts |
| EC2 t3.medium | ~$30/month |
| RDS db.t4g.micro | ~$15/month |
| Data transfer | ~$5/month |

Operational scenarios:

| Scenario | Alerts/day (after dedup) | Fixed/day | Monthly cost |
| --- | --- | --- | --- |
| Small team (1 service) | 5 | 3 | ~$140 |
| Medium team (5 services) | 30 | 15 | ~$725 |
| Large team (20 services) | 150 | 60 | ~$2750 |

Cost grows with **PR attempts**, not with **webhook volume**, because dedup catches storms. Storm-heavy days are cheaper than steady-state days at the same incident count.

## 7. Privacy and data handling

| Data | Where | Retention | Access |
| --- | --- | --- | --- |
| Sentry raw webhook payload | S3 | 90 days | Read via signed URL through admin endpoint |
| Agent run transcript (stdout/stderr) | S3 | 90 days | Same as above |
| Code being modified (repo clone) | EC2 disk `/var/lib/sfb/work/` | Deleted at end of run; max 1h if run fails | sfb-runner only |
| Database rows (alerts, runs, prs) | RDS | 1 year | Engineers via bastion |
| Slack messages | Slack (their retention) | Per Slack settings | Channel members |

PII concerns:
- Sentry payloads may contain user IDs, emails, request bodies → run a configurable scrubber before S3 upload
- Agent prompt includes payload excerpts → if scrubber runs, prompt is also scrubbed
- Agent never receives user PII unless it's already in source code being edited (and shouldn't be)
- Operator runbook describes how to wipe a specific alert's data on user request (GDPR DSR)

## 8. Open questions to resolve before Phase 2

1. **GitHub App or personal access token?** Strong preference for App (auditable, install scopes, no human user ambiguity). Confirm org policy allows installing a custom app.
2. **Where do GitHub App install credentials live?** Secrets Manager; private key as encrypted secret.
3. **Test command per repo or per branch?** Per repo for V1. Per branch later if needed.
4. **What is the on-call rotation for bot incidents?** Same as service rotation, or dedicated? Default same.
5. **Should the bot identify itself in PRs?** Yes — username `sentry-fixer-bot[bot]`, footer in PR body, custom commit trailer `Co-Authored-By: sentry-fixer-bot`.
6. **What about Sentry projects that map to multiple repos (microservices in a monorepo)?** Out of scope V1. Document as a known limitation. Workaround: map to monorepo root, agent navigates.
7. **What happens if the agent decides "this is not a bug, this is a feature request"?** Agent should write a `SENTRY_TRIAGE.md` file in a no-fix PR with the analysis. Operator decides.

## 9. Out-of-scope wishlist (for V2+)

Documented so we don't lose ideas:

- **Multi-LLM fallback**: try Opus, fall back to GPT-4o if Opus is rate-limited
- **Local model for triage**: run a small model on the EC2 for triage classification to avoid Haiku API cost
- **Diff-only mode**: instead of opening a PR, post the diff as a Sentry comment and let the engineer copy it
- **Sentry replay integration**: pull session replay frames as additional context for the agent
- **GitLab support**: second adapter at `src/github/` → rename to `src/forge/{github,gitlab}/`
- **Multi-tenant SaaS deployment**: per-tenant Anthropic key, isolated DB schemas, billing per fix
- **Auto-merge for trusted classes**: e.g. lint-style fixes can auto-merge after CI passes
- **Cross-repo fix suggestions**: detect that the real bug is in a different repo; open issue (not PR) in that repo
- **PR-comment chat**: agent listens to PR review comments and responds with a new commit

## 10. Decision log addendum

This is in addition to the decision log in `design.md`. Anything decided here while planning that is operational rather than product/architectural:

| Decision | Rationale |
| --- | --- |
| Single us-east-1 region V1 | Cost; Sentry retries cover regional blips |
| RDS db.t4g.micro start | Cheap; right-size after observing real load |
| Manual repo onboarding (config file) | Avoid registration UI in V1; one config commit per repo |
| Operator-driven prompt tuning, not auto-RL | Auto-RL adds risk + complexity disproportionate to V1 value |
| 90-day retention default | Balances incident retrospection with privacy minimisation |
| Slack as default notify; email backup | Slack-first culture; email for off-hours mirror |

---

## How to read this when starting Phase 1

1. Re-read `design.md` §3 (goals) and §7 (user flows). Anchor on what success looks like.
2. Re-read `architecture.md` §3 (data model) and §4 (sequence) before opening the editor. Many later bugs come from drifting from the documented schema.
3. Open `implementation-plan.md` Phase 1 task list. Work top-to-bottom. Don't skip ahead.
4. Update this `planning.md` if a risk materialises differently than expected, or if any "Open question" gets answered. Future-you will thank you.
