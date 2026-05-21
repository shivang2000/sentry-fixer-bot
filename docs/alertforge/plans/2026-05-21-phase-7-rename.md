---
plan: phase-7-rename
phase: 7
status: draft
date: 2026-05-21
implements_specs:
  - rename-migration
risk: medium
size: large (broad-touch but mechanical)
---

# P7 — Rename sentry-fixer-bot → alertforge

Single PR + deploy + `gh repo rename`. Atomic cutover with one-release back-compat for old surfaces.

## Scope

- Rename every workspace package, systemd unit, env key, working dir path, branch prefix, slash command, UI string per [rename-migration](../specs/2026-05-21-rename-migration.md) §Asset rename table.
- Add one-release back-compat: read both old + new env keys, accept both webhook paths, recognize both `/sfb` and `/alertforge` slash commands.
- After PR merges, run `gh repo rename alertforge`.
- Tag `alertforge-2.0.0`.

## File-level changes — broad-touch, mostly mechanical

### Workspace package renames

```
package.json (root)                              "name": "alertforge"
packages/server/package.json                     @sentry-fixer-bot/server → @alertforge/server
packages/api/package.json                        ...
packages/auth/package.json                       ...
packages/db/package.json                         ...
packages/env/package.json                        ...
packages/config/package.json                     ...
packages/ui/package.json                         ...

# imports across the monorepo:
find . -name '*.ts' -o -name '*.tsx' -o -name '*.json' | xargs sed -i '' \
  's/@sentry-fixer-bot\//@alertforge\//g'
```

### Env keys

```ts
// packages/env/src/server.ts
const envSchema = z.object({
  // new keys preferred; old keys accepted with deprecation warning
  ALERTFORGE_WEBHOOK_BIND_HOST: z.string().default('127.0.0.1'),
  // ... etc

  // legacy
  SFB_WEBHOOK_BIND_HOST: z.string().optional(),
  // ... etc
}).transform((env) => {
  // for each pair, prefer new; warn-log if old set
  if (env.SFB_WEBHOOK_BIND_HOST !== undefined && env.ALERTFORGE_WEBHOOK_BIND_HOST === '127.0.0.1') {
    log.warn('SFB_WEBHOOK_BIND_HOST is deprecated; use ALERTFORGE_WEBHOOK_BIND_HOST');
    env.ALERTFORGE_WEBHOOK_BIND_HOST = env.SFB_WEBHOOK_BIND_HOST;
  }
  // ... repeat for every key
  return env;
});
```

### systemd

```bash
git mv deploy/systemd/sfb-web.service deploy/systemd/alertforge-web.service
git mv deploy/systemd/sfb-worker.service deploy/systemd/alertforge-worker.service
git mv deploy/systemd/sfb-cron.service deploy/systemd/alertforge-cron.service
git mv deploy/systemd/sfb-backup.service deploy/systemd/alertforge-backup.service
git mv deploy/systemd/sfb-backup.timer deploy/systemd/alertforge-backup.timer
# update WorkingDirectory= and ExecStart= paths inside each unit
```

### Working / config dirs

```ts
// packages/config/src/paths.ts
export const ALERTFORGE_WORK_DIR = process.env.ALERTFORGE_WORK_DIR ?? '/var/lib/alertforge';
export const ALERTFORGE_CONFIG_DIR = process.env.ALERTFORGE_CONFIG_DIR ?? '/etc/alertforge';

// at boot, alertforge-cron creates symlinks if old paths exist and new don't:
//   /var/lib/sfb → /var/lib/alertforge
//   /etc/sfb → /etc/alertforge
```

### Branch prefix

```ts
// packages/steps/commit-push/src/branch-name.ts
export function makeBranchName(sourceType: string, shortId: string): string {
  return `alertforge/${sourceType}-${shortId}-${Date.now()}`;
}
```

### Webhook back-compat

`/webhooks/sentry` remains routed (P2 already did this).

### Slash command back-compat

```ts
// packages/steps/follow-up/src/parse-mention.ts
const MENTION_RE = /\/(sfb|alertforge)\b/;
export function hasMention(commentBody: string): boolean {
  return MENTION_RE.test(commentBody);
}
```

### UI strings

```
apps/web/src/components/AppHeader.tsx     "sentry-fixer-bot" → "Alertforge"
apps/web/src/routes/__root.tsx            title bar
apps/web/index.html                       <title>
apps/web/src/components/AppSidebar.tsx    sidebar header
README.md (top-level)                     full rewrite around Alertforge
docs/PROGRESS.md                          rename header + add banner pointing to docs/alertforge/
docs/runbook.md                           rename throughout
```

### GitHub App identity (separate from code)

In GitHub App settings (manual via web UI, not code):
- Rename App: `sentry-fixer-bot` → `alertforge`
- Update icon if desired
- App ID stays the same; existing installations continue to work
- PR author shows as `alertforge[bot]` after rename

### CI/CD

```yaml
# .github/workflows/ci.yml
env:
  # accept both during 2.0.x
  ALERTFORGE_DB_URL: ${{ secrets.ALERTFORGE_DB_URL || secrets.SFB_DB_URL }}
  ALERTFORGE_ANTHROPIC_API_KEY: ${{ secrets.ALERTFORGE_ANTHROPIC_API_KEY || secrets.SFB_ANTHROPIC_API_KEY }}
  # ... etc
```

In GitHub repo Settings → Secrets → Actions, add `ALERTFORGE_*` versions of every existing `SFB_*` secret. Don't delete the old ones until P9.

## Tests

- `bun run check-types` passes after all imports renamed.
- `bun test` runs the 180-ish test suite green.
- Webhook integration: POST to both `/webhooks/sentry` and `/webhooks/sentry` (kept for compat) → 202 with same alertId.
- Env: start the server with only `SFB_*` keys set → warn-logs appear but everything works. Start with only `ALERTFORGE_*` keys → no warnings, everything works. Start with both → new keys win.
- `parse-mention.test.ts` matches both `/sfb` and `/alertforge`.

## Verification + deploy sequence

```bash
# Pre-flight on staging:
bun run check-types && bun test && bun run build
bun run dev   # smoke local; observe warn-logs on old env keys

# Merge PR to main:
gh pr merge --squash
git tag alertforge-2.0.0 && git push --tags

# Rename repo:
gh repo rename alertforge   # GitHub auto-redirects old slug

# Add new secrets to Actions (web UI step):
# ALERTFORGE_DB_URL, ALERTFORGE_ANTHROPIC_API_KEY, ALERTFORGE_GITHUB_APP_PEM, etc.

# Deploy to staging:
./deploy/scripts/deploy.sh staging
# observe deprecation warnings in journalctl on the staging EC2

# Smoke staging:
# - paste a Sentry issue URL into the manual trigger; verify pipeline runs
# - check Slack/email notifications still fire
# - check the UI title bar says "Alertforge"
# - systemctl status alertforge-web alertforge-worker alertforge-cron — all running

# Deploy to production after 24h soak:
./deploy/scripts/deploy.sh prod

# Post-deploy:
# - schedule P9 (cleanup) PR for 2 weeks later
# - announce rename to users
```

## Rollback

See [rename-migration](../specs/2026-05-21-rename-migration.md) §Rollback. Cost: low.

## Commit

```
chore: rename sentry-fixer-bot → alertforge

Single atomic rename:
- Workspace packages: @sentry-fixer-bot/* → @alertforge/*
- systemd units: sfb-* → alertforge-*
- Working dir: /var/lib/sfb → /var/lib/alertforge (symlinked for compat)
- Config dir: /etc/sfb → /etc/alertforge (symlinked for compat)
- Env keys: SFB_* → ALERTFORGE_* (old keys accepted with deprecation warn)
- Branch prefix: sentry-fix/* → alertforge/{source}-{short}-{ts}
- Slash command: both /sfb and /alertforge recognized
- Webhook path: /webhooks/sentry stays; new generic /webhooks/:type added
- UI: title bar, sidebar header, README, docs

One-release back-compat policy: alertforge-2.0.x accepts both old and
new surfaces. alertforge-2.1.0 drops old surface (P9).

Run `gh repo rename alertforge` after merge — GitHub auto-redirects.

Spec: docs/alertforge/specs/2026-05-21-rename-migration.md
Plan: docs/alertforge/plans/2026-05-21-phase-7-rename.md
ADR: docs/alertforge/decisions/ADR-0003-rename-to-alertforge.md

Constraint: zero customer rebuild work at cutover (D16)
Constraint: existing GitHub App installs remain valid (no scope change)
Rejected: new repo, fresh start | loses history + breaks customer setup
Rejected: hard-cut env keys | breaks running deployments
Confidence: high
Scope-risk: broad
Directive: Old SFB_* env keys, /var/lib/sfb path, /sfb command are
           SUPPORTED IN 2.0.x ONLY. Will be removed in 2.1.0 (P9).
           Operators must migrate to ALERTFORGE_* before 2.1.
Not-tested: production-scale env-key migration (covered by 24h staging soak)
```
