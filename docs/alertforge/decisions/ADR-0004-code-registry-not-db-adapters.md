---
adr: 0004
title: Source + channel adapters as TS code, not DB rows
status: accepted
date: 2026-05-21
---

## Context

Sources (Sentry / PostHog / PagerDuty / …) and channels (Slack / email / PagerDuty-out / Teams / …) are the two extension points of the pipeline. How should new adapters be added?

| Option | Auditability | Type safety | Security | Hot-reload | Distribution |
|---|---|---|---|---|---|
| TS modules in `packages/{sources,channels}/` | High (PR review) | Full TS types | Safe (no user-supplied code) | No (redeploy) | npm/Bun workspace |
| DB rows containing JS mapping code | Low | None | **Dangerous** (eval user code at webhook time) | Yes | DB row insert |
| Hybrid: code registry + DB enable/disable flag | High | Full | Safe | Partial | Mixed |

## Decision

Adapters are **TS code in the monorepo**. Each adapter lives under `packages/sources/<name>/adapter.ts` or `packages/channels/<name>/adapter.ts`, exports an object conforming to `SourceAdapter` or `ChannelAdapter` from `@alertforge/core`. At boot, `packages/alertforge-core/src/registry.ts` collects them via Bun glob and registers them in a Map.

New adapters land as pull requests against this repo. No DB row contains adapter code, mapping logic, or URL patterns.

## Consequences

**Positive:**
- Type safety end-to-end. Adapter authors get IDE help; consumers of the registry get full inference.
- Security: webhook handlers never execute user-supplied code. Adapter logic is reviewed before merge.
- Tests run against real adapters at CI time.
- Adapter catalog (UI's "available sources / available channels") is auto-derived from the registry — no separate catalog config drift.

**Negative:**
- New adapter requires a redeploy. Acceptable: deploy cadence is multiple-per-week; not a hot path.
- Out-of-tree adapters are not supported — adding GitLab support, etc., means a PR against the main repo. Acceptable for an open-source project; users who need bespoke adapters can fork.

## Alternatives rejected

- **DB-stored adapter code**: rejected. Webhook endpoints would eval user-supplied JavaScript, which is an immediate RCE vector. Not negotiable.
- **Hybrid**: rejected. Adds complexity (two registry sources of truth, drift risk) for marginal gain — deploys are already infrequent enough that the DB-toggle flexibility doesn't earn its keep.

## Related

- Specs: `specs/2026-05-21-source-adapter-contract.md`, `specs/2026-05-21-channel-adapter-contract.md`
- Code: `packages/alertforge-core/src/registry.ts` (to be created in P1)
