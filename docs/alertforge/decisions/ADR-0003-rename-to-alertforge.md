---
adr: 0003
title: Rename sentry-fixer-bot → alertforge, same repo
status: accepted
date: 2026-05-21
---

## Context

The product has outgrown its name. It now triages and fixes alerts from any source (Sentry today; PostHog, PagerDuty next), with pluggable notification channels (Slack, email, more later). "sentry-fixer-bot" is misleading both for users (what about PostHog?) and contributors (where do new sources go?).

Two questions:

1. New name?
2. Same git repo or new repo?

## Decision

**Name: `Alertforge`.** Connotes signals in → fixes forged out → multi-source. Reasonably available (no major product collision). Picked from a short list (Triagent / Alertforge / Patchpilot / Signalcrew) during the 2026-05-21 brainstorming session.

**Repo: same repo, renamed in place.** Execute `gh repo rename alertforge` at the Phase 7 cutover. GitHub creates an auto-redirect from the old slug. Preserves:

- Git history (~30+ commits of decision context, every TDD iteration, every fix attempt).
- Tags. `mvp-1.0.0` stays as historical baseline; new release tagged `alertforge-2.0.0`.
- GitHub App installations on customer repos — no reinstall, no scope re-grant.
- Configured webhook URLs at Sentry (and at future PostHog/PagerDuty integrations) — no repointing.
- CI/CD secrets, deploy credentials, branch protection rules.
- Star count, issue history, PR history.

Rename touches every reference in code, deploy artifacts, docs, and UI strings. Back-compat policy: one minor release (`alertforge-2.0.x`) accepts both old (`SFB_*`, `/var/lib/sfb/`, `/sfb`) and new (`ALERTFORGE_*`, `/var/lib/alertforge/`, `/alertforge`) surfaces with a deprecation warning on the old. `alertforge-2.1.0` drops the old surface.

## Consequences

**Positive:**
- Zero customer-side rebuild work at the rename moment.
- All historical investigation context survives `git blame` and `git log`.
- The rename is a single PR — reviewable, revertible, atomic.

**Negative:**
- A grep for "sentry-fixer-bot" in repo history will keep finding hits forever; acceptable.
- The rebrand "feels" smaller because there's no new-repo splash. Marketing handles that separately.

## Alternatives rejected

- **New repo, fresh start**: rejected. Loses history; forces every customer to reinstall the GitHub App and repoint webhooks; CI secrets re-wired from scratch. The "fresh start" feel is illusory.
- **Both repos in parallel**: rejected. Doubles maintenance for no benefit; we are not maintaining a legacy V1 separately.

## Related

- Specs: `specs/2026-05-21-rename-migration.md`
- Plan: `plans/2026-05-21-phase-7-rename.md`
