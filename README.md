# Alertforge

> Renamed from `sentry-fixer-bot` in P7 (2026-05-23). The legacy name is
> preserved in the git history and in historical docs under `docs/`. The
> canonical home for new specs + plans is [`docs/alertforge/`](docs/alertforge/).

Open-source, self-hosted bot that listens for alerts from Sentry (and
soon: PostHog, PagerDuty, custom webhooks), triages with Claude Sonnet,
runs a Claude Code agent in a per-alert git worktree, opens a draft PR
with a proposed fix, **runs a second-pass code review**, and stays in a
`/alertforge` (legacy `/sfb` still accepted) conversation loop with the
human reviewer. Never auto-merges.

**Status:** approaching `alertforge-2.0.0` (the rename cutover release).
The MVP `mvp-1.x` tag still points at the pre-rename behaviour for any
operator who needs to roll back.

---

## What it does

1. **Alert arrives** — webhook `/webhooks/sentry` (HMAC-verified) or the
   15-min Sentry poll picks up new issues. P3a+ added a generic
   `POST /webhooks/:sourceType` route so future adapters (PostHog,
   PagerDuty) ride the same lane.
2. **Triage** — Sonnet classifies severity, posts a triage comment on
   the source issue, auto-discovers the GitHub repo from the project
   slug via `gh search repos`.
3. **Agent run** — clones (or re-uses the cached clone via
   `git worktree`), spawns `claude --print --dangerously-skip-permissions
   --model sonnet --effort high`, runs repo tests, secret-scans the
   diff, opens a PR with a structured description (problem /
   alternatives considered / chosen fix).
4. **Automated review** — a second Claude pass reviews the diff with a
   strict reviewer persona. Posts findings as a PR comment. Blocker
   verdict → PR flips to draft + `humanReviewState=waiting_human`.
5. **`/alertforge` follow-up loop** — when a reviewer (allow-listed in
   `reposConfig.prReviewers`) comments `/alertforge apply` or
   `/alertforge <instruction>` (legacy `/sfb` still accepted during
   `alertforge-2.0.x`), the bot re-attaches the worktree, applies the
   changes, commits + pushes back to the same branch, replies, and
   flips back to ready. GitHub webhook `/webhooks/github` is primary; a
   5-min cron polls comments as a fallback.
6. **Human merges.** The bot never merges its own PR.

Live run logs at `/runs/<id>` (live tail, 2s poll). Webhook setup UI on
the home page.

For the full picture: [`docs/alertforge/`](docs/alertforge/) (canonical
post-rename docs), plus historical [`docs/design.md`](docs/design.md),
[`docs/architecture.md`](docs/architecture.md), and
[`docs/PROGRESS.md`](docs/PROGRESS.md).

## Stack

- **Runtime:** Bun 1.3.x
- **Server:** Hono + tRPC
- **Web:** React 19 + Vite + Tailwind 4 + TanStack Router + Query + Form
  + shadcn/ui (Base UI) + xterm.js
- **DB:** Postgres 16 via Drizzle, pg-boss queue
- **Auth:** Better-Auth (email + password by default; first signup =
  admin, subsequent = invite-only)
- **Agent:** Claude Code CLI subprocess per alert; default model
  `claude-sonnet-4-6` with `--effort high`; per-run git-worktree off a
  cached clone under `/alertforge/state/repos/<owner>__<name>/`
  (container) or `/var/lib/alertforge/work/` (EC2)
- **Reviewer:** second Claude pass on the diff with an adversarial
  persona prompt; same model, different prompt

## Local development

```bash
# Prereqs: bun 1.3.x, docker, gh, claude CLI on PATH
bun install

# Bring up postgres on 5433 (the compose file maps to 5433 to avoid 5432 collision)
docker compose up -d

# Apply migrations + seed local repo config
bun --filter=@alertforge/db db:migrate
bun --filter=@alertforge/db db:seed

# Run server + web + worker
bun dev
```

Web app lives at <http://localhost:3001>. Hono server at
<http://localhost:3000>. Sidebar nav: **Overview** (Home, Chat,
Dashboard) → **Operate** (Repos, MCPs, Skills) → **Observe** (Runs) →
**System** (Doctor, Settings). The home page hosts the setup wizard and
the optional webhook configuration cards.

### First-signup-becomes-admin

In `authenticated` mode (the default outside loopback), the first
account created at `/sign-up` is automatically promoted to
`instance_admin`. Subsequent accounts require an `invites` row (added by
an admin). In `local_trusted` mode (loopback dev), the `local-board`
bootstrap user is the admin and no sign-in is required.

To switch modes after accumulating state, the server logs a one-time
`/board-claim/<token>?code=<code>` URL on the next boot; visit it as the
new admin to demote `local-board`.

### Webhooks (optional but recommended)

Both webhooks are optional — without them, the Sentry poll (15 min) and
the PR comment poll (5 min) cover the same surface, just with delay.
With them, end-to-end latency drops to seconds.

**Configure from the home page** — the wizard ships two collapsible
cards (`GitHub PR webhook`, `Sentry alert webhook`) that show the
delivery URL, generate a 256-bit hex secret in the browser, and persist
it via `settings.setSecret` into the on-disk env file. Operator just
pastes the same value into the provider.

Or wire it up by hand:

```bash
# Expose your local server to the public internet
ngrok http 3000

# --- Sentry side ---
# Sentry → Settings → Developer Settings → Internal Integrations → New Integration
# Webhook URL:    https://<ngrok-id>.ngrok-free.app/webhooks/sentry
# Permissions:    Issue & Event: Read
# Subscribe to:   issue
# Save → Sentry generates a "Client Secret" → paste into SENTRY_WEBHOOK_SECRET

# --- GitHub side (for the /alertforge follow-up loop) ---
# GitHub → Settings → Developer settings → GitHub Apps → <your app>
# Webhook URL:    https://<ngrok-id>.ngrok-free.app/webhooks/github
# Subscribe to:   Issue comment
# Webhook secret: paste into GITHUB_WEBHOOK_SECRET
# Content type:   application/json

# Trigger a fake Sentry alert without leaving the terminal:
./scripts/seed-fake-alert.sh
# Or from the /runs page, paste a Sentry issue URL into "Trigger a run".
```

Once a PR is open, an allow-listed reviewer (added to
`reposConfig.prReviewers` via `/repos`) can comment `/alertforge apply`
or `/alertforge <free-form instruction>` to drive another iteration.
Without the webhook, the same comments are picked up by the 5-min cron.

### Back-compat policy (alertforge-2.0.x)

The rename cutover (P7) keeps the legacy surface working for one
release cycle so deployments can migrate gradually:

- **Env keys:** `ALERTFORGE_*` is canonical; `SFB_*` fallback is read
  with a one-shot deprecation warning per key. `applyLegacyEnvFallbacks`
  in `packages/env/src/legacy-fallback.ts`.
- **Paths:** `/var/lib/sfb`, `/etc/sfb`, `/opt/sfb` are symlinked to the
  new `/var/lib/alertforge`, `/etc/alertforge`, `/opt/alertforge` at boot
  (idempotent + tolerant of EACCES).
- **Slash command:** both `/alertforge` and `/sfb` are recognised by the
  GitHub webhook + cron fallback.
- **Webhook path:** `POST /webhooks/sentry` keeps working via the
  generic `POST /webhooks/:sourceType` route.
- **Branch prefix:** new runs open `alertforge/<runId>` branches; the
  follow-up worker still re-attaches to legacy `sfb/<runId>` branches
  recorded on the `runs` row.

`alertforge-2.1.0` (P9) drops every back-compat shim. Operators should
migrate to `ALERTFORGE_*` env keys and the new paths during the 2.0.x
window.

## Deploy

See [`docs/runbook.md`](docs/runbook.md) for the EC2 + systemd + nginx
setup, env file shape, key rotation, and recovery procedures.

## Project layout

```
alertforge/
├── apps/
│   ├── server/         # Hono API + webhook + worker + chat WS
│   └── web/            # React admin UI
├── packages/
│   ├── alertforge-core/ # pipeline runtime + ctx-store + adapter registry
│   ├── api/             # tRPC routers, MCP catalog, skills catalog
│   ├── auth/            # Better-Auth wiring, trusted origins, doctor
│   ├── db/              # Drizzle schema + migrations + seed
│   ├── env/             # zod-validated env schemas + legacy fallback
│   ├── ui/              # shadcn/ui components
│   ├── sources/sentry/  # source adapter (P2)
│   ├── channels/        # email + slack channel adapters (P5)
│   └── steps/           # pluggable pipeline steps (P3a/b/c)
├── deploy/
│   ├── nginx/alertforge.conf
│   ├── systemd/         # alertforge-{server,worker,backup}.service + timer
│   └── ec2/userdata.sh
└── docs/                # design.md, architecture.md, runbook.md, alertforge/
```

## Tests + checks

```bash
bun test
bun run check-types # green across all workspaces
bun run build       # produces apps/server/public/ for production
```

CI runs both on every PR (see `.github/workflows/ci.yml`). CI env
accepts both `ALERTFORGE_*` and `SFB_*` secrets during 2.0.x; P9 drops
the `SFB_*` arm.

## Security model

Summary (full version in `docs/architecture.md` §7):

- HMAC-verified webhooks with timing-safe compare (Sentry + GitHub)
- Agent runs as `alertforge-runner` (uid 4000), no sudo, no AWS creds
  in env
- Per-run git worktree off a cached partial clone; worktree deleted
  after the run, branch ref retained so `/alertforge` follow-ups can
  re-attach
- GitHub App permissions: `contents: write`, `pull_requests: write` —
  no merge, no admin
- `/alertforge` commands authorized via the magic-prefix +
  `reposConfig.prReviewers` allow-list — comments from anyone else are
  ignored
- Branch protection enforced externally (the bot literally cannot
  bypass it)
- Outbound network allowlist via iptables on the EC2 instance

## License

MIT. See `LICENSE`.
