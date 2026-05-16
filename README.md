# sentry-fixer-bot

Open-source, self-hosted bot that reads Sentry webhooks, triages issues with Claude Haiku, runs a Claude Code agent in a per-alert git worktree, and opens a pull request with a proposed fix — never auto-merges.

**Status:** `mvp-1.0.0` (backend pipeline shipped, V2 admin UI shipped). 120 tests pass.

---

## What it does

1. Sentry fires an alert → webhook hits `/webhooks/sentry`
2. HMAC verified (timing-safe), dedup key computed, alert upserted
3. Worker job: Haiku classifies severity, posts a triage comment on the Sentry issue
4. If severity ≥ configured threshold and daily budget allows, a second job clones the repo, spawns `claude --print --dangerously-skip-permissions`, runs the repo's tests, opens a GitHub PR (draft if tests fail)
5. Human reviews + merges. The bot never merges its own PR.

For the full picture: [`docs/design.md`](docs/design.md), [`docs/architecture.md`](docs/architecture.md), [`docs/v2-frontend-and-skills.md`](docs/v2-frontend-and-skills.md), [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Stack

- **Runtime:** Bun 1.3.x
- **Server:** Hono + tRPC
- **Web:** React 19 + Vite + Tailwind 4 + TanStack Router + Query + Form + shadcn/ui (Base UI) + xterm.js
- **DB:** Postgres 16 via Drizzle, pg-boss queue
- **Auth:** Better-Auth (email + password by default; first signup = admin, subsequent = invite-only)
- **Agent:** Claude Code CLI subprocess per alert; per-run worktree under `/var/lib/sfb/work/`

## Local development

```bash
# Prereqs: bun 1.3.x, docker, gh, claude CLI on PATH
bun install

# Bring up postgres on 5433 (the compose file maps to 5433 to avoid 5432 collision)
docker compose up -d

# Apply migrations + seed local repo config
bun --filter=@sentry-fixer-bot/db db:migrate
bun --filter=@sentry-fixer-bot/db db:seed

# Run server + web + worker
bun dev
```

Web app lives at <http://localhost:3001>. Hono server at <http://localhost:3000>. The sidebar nav exposes Repos, MCPs, Skills, Runs, Chat, Settings.

### First-signup-becomes-admin

In `authenticated` mode (the default outside loopback), the first account created at `/sign-up` is automatically promoted to `instance_admin`. Subsequent accounts require an `invites` row (added by an admin). In `local_trusted` mode (loopback dev), the `local-board` bootstrap user is the admin and no sign-in is required.

To switch modes after accumulating state, the server logs a one-time `/board-claim/<token>?code=<code>` URL on the next boot; visit it as the new admin to demote `local-board`.

### Testing the webhook locally

```bash
# Expose your local server to the public internet
ngrok http 3000

# In Sentry, add a "Service Hook" with secret = $SENTRY_WEBHOOK_SECRET
# pointed at https://<ngrok-id>.ngrok-free.app/webhooks/sentry

# Trigger a test alert (any project), then:
bun --filter=@sentry-fixer-bot/server tail-runs
```

You can also send a fake webhook locally:

```bash
./scripts/seed-fake-alert.sh
```

## Deploy

See [`docs/runbook.md`](docs/runbook.md) for the EC2 + systemd + nginx setup, env file shape, key rotation, and recovery procedures.

## Project layout

```
sentry-fixer-bot/
├── apps/
│   ├── server/         # Hono API + webhook + worker + chat WS
│   └── web/            # React admin UI
├── packages/
│   ├── api/            # tRPC routers, MCP catalog, skills catalog
│   ├── auth/           # Better-Auth wiring, trusted origins, doctor
│   ├── db/             # Drizzle schema + migrations + seed
│   ├── env/            # zod-validated env schemas
│   └── ui/             # shadcn/ui components
├── deploy/
│   ├── nginx/sfb.conf
│   ├── systemd/        # sfb-{web,worker,backup}.service + timer
│   └── ec2/userdata.sh
└── docs/               # design.md, architecture.md, runbook.md, plans/
```

## Tests + checks

```bash
bun test            # 120 pass
bun run check-types # green across all workspaces
bun run build       # produces apps/server/public/ for production
```

CI runs both on every PR (see `.github/workflows/ci.yml`).

## Security model

Summary (full version in `docs/architecture.md` §7):

- HMAC-verified webhooks with timing-safe compare
- Agent runs as `sfb-runner` (uid 4000), no sudo, no AWS creds in env
- Per-run git worktree, deleted after the run
- GitHub App permissions: `contents: write`, `pull_requests: write` — no merge, no admin
- Branch protection enforced externally (the bot literally cannot bypass it)
- Outbound network allowlist via iptables on the EC2 instance

## License

MIT. See `LICENSE`.
