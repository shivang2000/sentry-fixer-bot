---
plan: phase-9-cleanup
phase: 9
status: draft
date: 2026-05-21
implements_specs:
  - rename-migration
target_release: alertforge-2.1.0
risk: low
size: small
---

# P9 — 2.1 cleanup (drop deprecated surface)

Ship `alertforge-2.1.0`. Drop the back-compat scaffolding from P7. Schedule for ~2 weeks after P7 deploys.

## Scope

- Drop `SFB_*` env key fallbacks (read-only-on-set warning becomes a hard error).
- Drop `/var/lib/sfb` and `/etc/sfb` symlinks.
- Drop `/sfb` slash command (keep `/alertforge` only).
- Remove the old `POST /webhooks/sentry` route handler (generic `/webhooks/:sourceType` continues to handle Sentry).
- Drop `repos_config` table after final backfill verification.
- Remove deprecated re-export shims left around from P2/P3 file moves.

## File-level changes

### Modify

```
packages/env/src/server.ts                     drop SFB_* shim transforms;
                                               only ALERTFORGE_* accepted
packages/config/src/paths.ts                   drop symlink-creation hook
packages/steps/follow-up/src/parse-mention.ts  /alertforge only
apps/server/src/routes/webhooks-sentry.ts      DELETE; generic route handles all
apps/server/src/routes/index.ts                drop mount of webhooks-sentry
packages/db/migrations/0004_drop_repos_config.sql NEW — drops repos_config
```

### Delete

```
packages/sources/sentry/src/legacy-reexports.ts   any compat shims from P2
packages/steps/*/legacy-reexports.ts              any compat shims from P3
deploy/systemd/sfb-*.symlinks                     if any were committed
```

## Migration 0004

```sql
-- Verify backfill complete before drop
DO $$
DECLARE
  rc_count INT;
  t_count INT;
BEGIN
  SELECT count(*) INTO rc_count FROM repos_config;
  SELECT count(*) INTO t_count
    FROM triggers WHERE source_type = 'sentry';
  IF t_count < rc_count THEN
    RAISE EXCEPTION 'Cannot drop repos_config: triggers count (%) < repos_config count (%)',
      t_count, rc_count;
  END IF;
END $$;

DROP TABLE IF EXISTS repos_config;
```

The pre-flight `DO` block prevents accidental drop if the backfill from P4 missed any rows.

## Tests

- `bun test` green with the SFB_* keys unset (they used to be accepted; now ignored).
- Webhook regression: POST to `/webhooks/sentry` still routes (via generic `/webhooks/:sourceType`).
- Mention regression: PR comment containing only `/sfb` does **not** trigger follow-up loop (only `/alertforge` does).
- Migration 0004 dry-run: against a staging DB with the full P4 backfill, the DO block passes and the DROP succeeds; against a synthetic DB where one repos_config row is missing from triggers, the DO block raises and the DROP is aborted.

## Verification

```bash
# Pre-deploy:
bun run check-types && bun test && bun run build

# Backfill verification on staging:
psql -c "SELECT (SELECT count(*) FROM repos_config) AS rc, (SELECT count(*) FROM triggers WHERE source_type='sentry') AS t;"
# expect rc == t

# Run migration:
bun --filter=@alertforge/db db:migrate

# Smoke:
# - SFB_* keys still set in env → server starts but logs warnings (or hard-error if we go that far)
# - POST /webhooks/sentry returns 202 (handled by generic route)
# - /sfb in PR comment is ignored; /alertforge triggers follow-up
```

## Deploy + tag

```bash
git tag alertforge-2.1.0
gh repo deploy ...
```

## Rollback

If issues arise post-deploy:

- Re-add `SFB_*` shim in `packages/env/src/server.ts` and hot-deploy.
- `repos_config` is gone, but no live code reads it (we verified pre-drop); rollback of code is sufficient.
- `git revert` the 0004 migration commit and re-apply if needed (Drizzle migrations are forward-only but the data is in `triggers` already; the schema can be recreated empty if desperately needed).

## Commit

```
chore(2.1): drop deprecated SFB_* surface

Cleanup of the back-compat scaffolding shipped in P7:
- Drop SFB_* env-key fallbacks; only ALERTFORGE_* accepted
- Drop /var/lib/sfb and /etc/sfb symlinks
- Drop /sfb slash command; /alertforge only
- Drop /webhooks/sentry dedicated handler (generic /webhooks/:type handles it)
- Drop repos_config table (migration 0004, with safety check that
  triggers backfill is complete before the DROP)
- Drop legacy re-export shims from P2/P3 file moves

This is the planned cutoff at alertforge-2.1.0. Operators who hadn't
migrated to ALERTFORGE_* env keys must do so before deploying this
release.

Plan: docs/alertforge/plans/2026-05-21-phase-9-cleanup.md
Spec: docs/alertforge/specs/2026-05-21-rename-migration.md

Constraint: do not drop repos_config without verified triggers backfill
Rejected: keep SFB_* indefinitely | accumulates dead code, confuses readers
Confidence: high
Scope-risk: narrow (small surface, all deletions, verified before deploy)
Directive: Future renames should follow the same one-release back-compat
           pattern: ship aliases, deprecation-warn, drop one release later.
Not-tested: drift between staging and prod backfill state (mitigated by
           migration safety check)
```
