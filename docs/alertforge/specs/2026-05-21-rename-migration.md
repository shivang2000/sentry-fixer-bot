---
spec: rename-migration
title: Rename sentry-fixer-bot → alertforge + data migration
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0003-rename-to-alertforge
related_specs:
  - pluggable-pipeline-design
  - trigger-config-schema
plan_phases:
  - 2026-05-21-phase-7-rename
---

# Rename + data migration

## Repo rename

GitHub-side action: `gh repo rename alertforge` (run after the rename PR merges). GitHub creates an auto-redirect from the old slug. No customer-side action required.

## Asset rename table

| Asset class | Old | New |
|---|---|---|
| Repo slug on GitHub | `sentry-fixer-bot` | `alertforge` |
| npm scope | `@sentry-fixer-bot/*` | `@alertforge/*` |
| Workspace package names | `@sentry-fixer-bot/{server,api,db,ui,auth,env,config}` | `@alertforge/{server,api,db,ui,auth,env,config,core}` (note: new `core`) |
| systemd units | `sfb-{web,worker,cron,backup}` | `alertforge-{web,worker,cron,backup}` |
| Working dir | `/var/lib/sfb/` | `/var/lib/alertforge/` (symlink old → new for one release) |
| Config dir | `/etc/sfb/` | `/etc/alertforge/` (symlink old → new for one release) |
| Env prefix | `SFB_*` | `ALERTFORGE_*` (old prefix warn-only fallback for one release) |
| Branch prefix | `sentry-fix/{short}-{ts}` | `alertforge/{source}-{short}-{ts}` |
| Webhook path | `POST /webhooks/sentry` | both old + new `POST /webhooks/:sourceType` work |
| Slash command (PR comment) | `/sfb` | both `/sfb` + new `/alertforge` recognized by follow-up step |
| Git tags | `mvp-1.0.0` (kept) | next release `alertforge-2.0.0` |
| README + docs | scattered `docs/*.md` | rewritten under `docs/alertforge/` (this tree); top-level docs get a banner pointing here |
| UI title bar | "sentry-fixer-bot" | "Alertforge" |
| PR author identity | `sentry-fixer-bot[bot]` | `alertforge[bot]` (GitHub App rename, done in App settings) |
| nginx server_name | `sfb.example.com` (operator's choice) | unchanged DNS; operator-controlled |
| S3 bucket prefix | `sfb-archives-*` | unchanged (rename in place via new naming for future buckets only) |
| CloudWatch log group | `/sfb/{env}` | `/alertforge/{env}` (new env; old logs retained) |

## Back-compat policy

One minor release (`alertforge-2.0.x`) accepts **both** old and new surfaces:

- **Env keys:** read `ALERTFORGE_X` first, fall back to `SFB_X`, log a deprecation warning per old key.
- **Paths:** `/var/lib/sfb` is a symlink → `/var/lib/alertforge`; same for `/etc/sfb` → `/etc/alertforge`.
- **Webhook paths:** old `POST /webhooks/sentry` still routes (now via the generic `/webhooks/:sourceType` handler delegating to the Sentry adapter).
- **Slash command:** `/sfb` and `/alertforge` both trigger the follow-up loop.

`alertforge-2.1.0` drops the old surface. Operators get one release cycle (≈ 2–4 weeks) to migrate.

## Migration 0003 — data backfill

See [trigger-config-schema](2026-05-21-trigger-config-schema.md) for the migration SQL. It is **forward-only**, idempotent (`ON CONFLICT DO NOTHING`), and re-runnable.

Pre-migration verification:
- Snapshot DB via existing `pg_dump → S3` cron run.
- Note current count of `repos_config` rows, `runs` (per status), `prs`.

Post-migration verification queries (see trigger-config-schema spec):
- `triggers` count == `repos_config` count.
- `runs.trigger_id IS NULL AND status IN ('queued','triaging','agenting','testing')` count = 0.
- `channel_configs WHERE channel_type='slack'` count == `repos_config WHERE slack_channel IS NOT NULL` count.

## Rename PR composition

P7 ships as **one PR** containing:

1. Workspace package renames (package.json files across the monorepo).
2. systemd unit renames (`deploy/systemd/*.service` files).
3. Env key handling: read new first, fall back to old with warning (`packages/env/src/server.ts`).
4. Working/config dir constants updated; runtime creates symlinks if missing.
5. Branch prefix updated in `packages/steps/commit-push/`.
6. UI strings: title bar, footer, README of `apps/web/`.
7. Webhook path: generic route added; old route kept as wrapper.
8. `/sfb` and `/alertforge` both recognized in `packages/steps/follow-up/`.
9. README + top-level docs updated to point at `docs/alertforge/`.
10. CI workflow env vars: read both `SFB_*` and `ALERTFORGE_*`.

## Deploy sequence at cutover

1. Merge rename PR to main.
2. Tag commit `alertforge-2.0.0`.
3. Run `gh repo rename alertforge`. GitHub creates redirect.
4. Update CI/CD secrets store: add `ALERTFORGE_*` keys alongside existing `SFB_*` (server reads both during 2.0.x).
5. Deploy to staging. Verify warn-logs on old env keys + new behavior.
6. Deploy to production. Monitor for 24 h.
7. Open follow-up PR adding documentation to remove `SFB_*` keys after one release.
8. Schedule P9 (`alertforge-2.1.0`) cleanup PR for two weeks later.

## Rollback

If post-cutover issues require rollback:

- Code: revert to pre-rename commit. Workspace package names are restored; deploy.
- DB: migration 0003 is forward-only but additive only. Reverting code is sufficient; new tables become orphans (no behavior impact).
- Webhook URLs: old paths still work, so no customer action needed during rollback.
- `gh repo rename` is reversible (`gh repo rename sentry-fixer-bot`); GitHub redirect updates.
- systemd: revert deploy artifact → systemd reloads → old unit names take effect.

Rollback cost: low. The only irreversible action is the data backfill, which leaves the old `repos_config` table intact, so reverting code restores the working setup.
