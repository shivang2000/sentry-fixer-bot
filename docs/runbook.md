# sentry-fixer-bot — Operator Runbook

This is the on-call runbook for operating a `sentry-fixer-bot` deployment. Read it before you start the EC2 instance, then keep it open.

## 1. Environment file (`/etc/sfb/env`)

Single env file consumed by systemd (`EnvironmentFile=` directive). Mode `0640`, owned by `root:sfb-runner`. The UI writes here when an admin saves a secret in `/mcps`.

Required keys:

| Key | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://sfb:<pw>@127.0.0.1:5432/sfb` |
| `SENTRY_WEBHOOK_SECRET` | HMAC secret configured in Sentry Service Hook |
| `ANTHROPIC_API_KEY` | Used by Haiku triage + Opus agent runs |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | PKCS#8 private key (multi-line OK if env file supports it) |
| `GITHUB_APP_INSTALLATION_ID` | Per-org installation id |
| `BETTER_AUTH_SECRET` | ≥ 32 chars random; rotates sessions if changed |
| `BETTER_AUTH_URL` | `https://sfb.example.com` |
| `SFB_DEPLOYMENT_MODE` | `local_trusted` or `authenticated` |
| `SFB_BIND` | `loopback`, `lan`, `tailnet`, or `custom` |
| `S3_BUCKET` | Sentry payload + run-log archive bucket |
| `AWS_REGION` | Bucket region |

UI-managed (filled in by admins via `/mcps` install dialog): any keys referenced by `mcpInstalls.envKeys`.

## 2. systemd

Services (under `/etc/systemd/system/`):

```
sfb-web.service        # Hono server, port 3000
sfb-worker.service     # pg-boss consumer, no port
sfb-backup.service     # one-shot pg_dump
sfb-backup.timer       # daily at 03:00 UTC
```

Common operations:

```bash
systemctl status sfb-web sfb-worker
systemctl restart sfb-web                 # zero-state restart
systemctl reload sfb-web                  # re-reads /etc/sfb/env
journalctl -fu sfb-worker                 # tail worker logs
journalctl -u sfb-web --since '1 hour ago'
```

The UI's "MCP install" flow writes to `/etc/sfb/env` and calls `systemctl reload-or-restart sfb-web sfb-worker` so the new env is picked up on the next agent spawn.

## 3. EC2 boot sequence

`deploy/ec2/userdata.sh` runs on instance launch and:

1. Installs Docker, Bun, gh, claude CLI, and required system packages.
2. Creates user `sfb-runner` (uid 4000, no sudo).
3. Pulls the latest tag from this repo into `/opt/sfb/current`.
4. Runs `bun install --production --frozen-lockfile` + `bun run build`.
5. Brings up Postgres via `docker-compose.yml` (host network, EBS-backed volume).
6. Applies migrations.
7. Enables the systemd units listed in §2.
8. Configures `nginx` from `deploy/nginx/sfb.conf` and reloads it.

If the boot fails, ssh in and check `/var/log/cloud-init-output.log`.

## 4. Backup + restore

### Backup

`sfb-backup.timer` triggers `scripts/backup-db.sh` daily. It:

1. Runs `pg_dump -Fc` to `/tmp/sfb-YYYY-MM-DD.dump`
2. `aws s3 cp` to `s3://<bucket>/db-backups/`
3. Deletes the local file

### Restore

```bash
# Stop the worker first so nothing writes during restore
systemctl stop sfb-worker

aws s3 cp s3://<bucket>/db-backups/sfb-YYYY-MM-DD.dump /tmp/restore.dump
pg_restore --clean --if-exists -d "$DATABASE_URL" /tmp/restore.dump

systemctl start sfb-worker
```

## 5. Key rotation

### `SENTRY_WEBHOOK_SECRET`

Webhook verification uses timing-safe compare. To rotate:

1. Generate a new secret (`openssl rand -hex 32`).
2. Add it to Sentry's webhook config (Sentry supports multiple secrets — keep the old one during the rollover window).
3. Edit `/etc/sfb/env`, then `systemctl reload sfb-web`.
4. After ~5 minutes (Sentry retry window flushes), remove the old secret from Sentry.

### `ANTHROPIC_API_KEY`

Generate the new key in the Anthropic console, paste it in the UI's settings page (or edit `/etc/sfb/env` directly), then `systemctl reload sfb-web sfb-worker`. The Haiku/Opus calls pick up the new key on the next spawn.

### GitHub App private key

Generate a new PKCS#8 key in the GitHub App settings → install the new one in the same installation → update `GITHUB_APP_PRIVATE_KEY` in `/etc/sfb/env` → reload services. GitHub allows two keys to coexist during rollover.

### `BETTER_AUTH_SECRET`

Rotating this invalidates all existing sessions (every signed-in operator gets logged out). Pick a maintenance window. Generate new (`openssl rand -base64 48`), update env, reload `sfb-web`.

## 6. Switching `local_trusted` → `authenticated`

After developing on loopback under `local_trusted`, switch to authenticated mode:

1. Set `SFB_DEPLOYMENT_MODE=authenticated` in `/etc/sfb/env`.
2. `systemctl reload sfb-web`.
3. On boot, the server logs a one-time URL: `/board-claim/<token>?code=<code>`. Grep the journal for `BOARD_CLAIM_URL`.
4. Visit that URL as the new admin. The `local-board` bootstrap user is demoted; you become `instance_admin`.

If you miss the URL, the server keeps the row valid until consumed — re-grep the journal or restart `sfb-web` to print it again.

## 7. Kill switch

To pause all agent runs without taking down the server (e.g. while you investigate a misbehavior):

```bash
# Set in /etc/sfb/env then reload
SFB_DISABLE_AGENT=true
```

`sfb-worker` will accept jobs, log "agent_disabled", and skip the Claude spawn. Triage jobs continue (Haiku classification is cheap and read-only). Sentry comments still post; PRs are not opened.

To resume: remove the env var (or set to `false`), `systemctl reload sfb-worker`.

## 8. Common failures + fixes

(Adapted from `architecture.md` §9.)

| Failure | Detection | Recovery |
|---|---|---|
| EC2 dies | CloudWatch instance health | ASG of 1 auto-replaces; on boot, the worker scans `runs` for status in `(triaging, agenting, testing)` older than 10 min and marks them `failed`. Operator retries manually. |
| Postgres connection drops mid-run | pg-boss retry loop | Job not acked → re-delivered. Usually self-heals within seconds. |
| `claude` CLI hangs | 15-min wall-clock timeout | Process group killed, run marked `failed`, no PR. |
| `git push` fails (network blip) | Non-zero exit | Retry with backoff; if still failing, mark run failed, keep workspace, alert. |
| `gh pr create` fails (GitHub down) | Non-zero exit | Retry up to 5 attempts over 10 min; if still failing, save diff to S3, mark `failed_pr_open`. Operator runs `gh pr create` manually later. |
| Test command flakes | Second run also red | Open as draft + label `tests-flaky`. |
| Sentry API 429 | Response code | Exp backoff up to 5 min; mark triage failed if still 429 (webhook payload preserved). |
| Daily budget exhausted | `budgets.tokens_used >= cap` | Triage-only mode; agent skipped. Resets at midnight UTC. |
| Disk full on `/var/lib/sfb` | Hourly cron check | Force-prune oldest worktrees; alert operator. |
| Postgres disk full | CloudWatch EBS-usage alarm | Manual intervention. Bot returns 503 on `/webhooks/sentry` until cleared. |
| Webhook flood | nginx rate limit (100 req/s per IP) | Excess returns 429; Sentry retries. |

## 9. Where things live on disk

```
/etc/sfb/env                        # secrets, env vars
/opt/sfb/current/                   # checked-out repo
/var/lib/sfb/
  ├── work/{run_id}/                # per-run worktrees (deleted after run)
  ├── logs/                         # run transcripts (rotated)
  ├── skills/{install_id}/          # installed skills (built-in + custom + skills.sh)
  └── chat/{session_id}/            # per-chat work dir (deleted on session end)
```

Postgres lives in a docker container with an EBS-backed volume — back up via `pg_dump`, not by snapshotting the volume.

## 10. Escalation

- **PRs landing with malicious code**: kill switch (§7), rotate Anthropic key (§5), investigate the prompt template via `runs.<id>.log_s3`.
- **Bot pushed to a wrong branch**: branch protection on the default branch should prevent it. If it happened anyway, the GitHub App scope was misconfigured — fix in GitHub App settings.
- **Secret leaked**: rotate the affected secret (§5), then audit `prs` for any PR opened in the window between leak and rotation.
