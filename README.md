# sentry-fixer-bot

Automated Sentry-to-PR remediation agent. Receives Sentry webhooks, triages issues, and opens pull requests with proposed fixes.

> **Status:** Planning phase. No code yet. Design and planning documents only.

## What it does

1. Sentry fires an alert (new issue, regression, etc.)
2. Webhook hits this service running on EC2
3. Service deduplicates the alert and classifies severity
4. For actionable issues, the service spawns a Claude Code agent in a worktree of the impacted repo
5. The agent investigates, writes a minimal fix, runs the repo's tests
6. A pull request is opened on GitHub (draft if tests fail) for human review
7. No code is ever merged automatically

## Why

Existing Sentry → Linear/Jira workflows produce tickets that sit in backlogs. The on-call engineer reads the alert, opens the repo, reproduces, writes the fix. The investigation + draft fix is the most parallelisable, lowest-context-switch part of the job. A bot can absorb that work and leave humans on the high-judgement parts: reviewing the proposed change, deciding whether to ship, deciding architecture.

## Documents

| Document | Purpose |
| --- | --- |
| [`docs/design.md`](docs/design.md) | Product design: problem, users, goals, non-goals, decisions, success metrics |
| [`docs/architecture.md`](docs/architecture.md) | Technical design: topology, components, schemas, sequence diagrams, security, failure modes |
| [`docs/implementation-plan.md`](docs/implementation-plan.md) | Phased build plan with per-phase tasks, files, exit criteria |
| [`docs/planning.md`](docs/planning.md) | Ops planning: timeline, risks, dependencies, rollout, monitoring, cost |

## Quick read order

For reviewers, read in this order:

1. `docs/design.md` — what we are building and why
2. `docs/architecture.md` — how it is structured
3. `docs/implementation-plan.md` — how it gets built
4. `docs/planning.md` — risks, costs, rollout
