# Alertforge

> Renamed from `sentry-fixer-bot` in P7 (2026-05-23). The legacy name is
> preserved in git history + historical docs under `docs/`. The canonical
> home for new specs + plans is [`docs/alertforge/`](docs/alertforge/).

Open-source, self-hosted bot that listens for alerts from any **source
adapter** (Sentry today; PostHog / PagerDuty / custom webhooks plug in
via `packages/sources/<name>/`), triages with Claude, runs a Claude Code
agent in a per-alert git worktree, opens a draft PR with a proposed fix,
**runs a second-pass code review**, and stays in an `/alertforge`
conversation loop with the human reviewer. Routes notifications through
any **channel adapter** (Slack + email today; PagerDuty-out / Teams /
Discord plug in the same way via `packages/channels/<name>/`). Never
auto-merges.

**Status:** ready to tag `alertforge-2.1.0`. The Alertforge 2.0 → 2.1
rollout (P6 UI, P7 rename, P8 outcome feedback, P9 cleanup) shipped on
2026-05-23. The MVP `mvp-1.x` tag still points at the pre-rename
behaviour for any operator who needs to roll back.

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
   `repos.prReviewers`) comments `/alertforge apply` or
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

## Triggers + presets (the core UX abstraction)

A **trigger** is the addressable unit one pipeline config attaches to.
Granularity: per `(source_type, source_project, repo)` tuple. Examples:

- `(sentry, backend-api, acme-corp/api)` — Sentry alerts from project
  `backend-api` fix code in repo `acme-corp/api`.
- `(sentry, web-frontend, acme-corp/web)` — separate config; different
  preset, different model picks possible.
- `(posthog, signup-flow, acme-corp/web)` — future, same target repo,
  different source adapter.

Every trigger picks one **preset**:

| Preset | Behaviour | Est. cost/alert |
|---|---|---|
| `triage_only` | Classify + notify; no agent, no PR | ~$0.001 |
| `auto_fix` | Classify + fix + tests + PR (default for new triggers) | ~$1.00–$1.50 |
| `auto_fix_review` | Above + second LLM reviews the PR before marking ready | ~$1.50–$2.50 |
| `custom` | Exposes individual toggles (auto-review, follow-up loop, secret-scan strictness) |  varies |

Triggers + their channels are managed at **`/triggers`** in the web UI
(P6). A trigger card surfaces preset, last alert, 7-day stats, edit /
disable / "Trigger fix from URL" actions. The wizard at
`/triggers/new` walks source → source-project → repo → preset →
channels in four steps. Per-step model picks (classifier / fix agent /
reviewer / follow-up agent) live on the Pipeline tab; channel cards
(Slack / email) live on the Channels tab.

### Manual URL trigger

Paste any source's URL (Sentry issue, PostHog event, PagerDuty
incident) into the **Trigger fix from URL** input on `/triggers` or
`/runs/new`. The router auto-detects the source via the adapter
registry's `urlPatterns`, surfaces the matching trigger + preset, and
fires the same pipeline a real webhook would. Useful for re-running a
fix manually, testing a new trigger config, or recovering a missed
event.

### Outcome feedback + daily digest (P8, self-improvement loop V1)

Two pg-boss cron jobs run by default:

- **`outcome-poll`** (daily 02:00 UTC): walks bot PRs that have been
  open ≤14 days and records `prs.outcome` ∈ {`merged_clean`,
  `merged_with_edits`, `closed_unmerged`, `stale_open`} + captures
  review comments for closed-unmerged PRs.
- **`daily-digest`** (daily 06:00 UTC): per-trigger 7-day roll-up
  (merge rate, top recurring fingerprints not getting fixed, cost vs
  cap, suggested action) sent to channels with `digest` in their
  `notify_on` list.

The `/triggers/$id` audit tab includes a 30-day outcome chart powered
by these columns + a "Digest preview" button that renders what the next
daily digest will say without firing it.

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
Dashboard) → **Triggers** (primary) → **Operate** (Repos, MCPs, Skills)
→ **Observe** (Runs, Usage) → **System** (Doctor, Settings). The home
page hosts the setup wizard and the optional webhook configuration
cards.

### Environment variables

All keys are read by `packages/env/src/server.ts` via
`@t3-oss/env-core` + zod. Required keys fail-fast at boot; optional
keys gate specific features.

| Key | Required? | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (compose ships 5433) |
| `BETTER_AUTH_SECRET` | yes, ≥32 chars | Cookie signing for the admin UI |
| `BETTER_AUTH_URL` | yes | Public URL where the admin UI lives |
| `CORS_ORIGIN` | yes | Allowed CORS origin for the web app |
| `NODE_ENV` | optional | `development` / `production` / `test` (default `development`) |
| `DEPLOYMENT_MODE` | optional | `local_trusted` / `authenticated` (default `local_trusted`) |
| `SERVER_BIND` | optional | `loopback` / `lan` / `tailnet` / `custom` (default `loopback`) |
| `SERVER_BIND_HOST` | optional | Host override when `SERVER_BIND=custom` |
| `PUBLIC_BASE_URL` | optional | Public URL written into Sentry comments + PR bodies |
| `SENTRY_WEBHOOK_SECRET` | optional | Enables `POST /webhooks/sentry` HMAC verification |
| `SENTRY_API_TOKEN` | optional | Sentry API token (event fetch + issue comments) |
| `SENTRY_ORG_SLUG` | optional | Used to render Sentry issue links in prompts + PR bodies |
| `ANTHROPIC_API_KEY` | optional | Falls back to `claude auth login` when unset |
| `S3_BUCKET`, `S3_REGION` | optional | Archive run logs + Sentry payloads (dev uses `local://` sentinel) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID` | optional | Preferred GitHub auth; falls back to `gh auth token` |
| `GITHUB_WEBHOOK_SECRET` | optional | Enables real-time `/sfb` follow-up via the GitHub webhook |
| `RESEND_API_KEY` | optional | Required if any trigger uses the email channel |
| `ALERTFORGE_DEFAULT_FROM` | optional | Default `from:` for email notifications |
| `WORK_DIR` | optional | Workspace root (default `/var/lib/alertforge/work` in prod, `/tmp/alertforge` in dev) |
| `CLAUDE_BIN` | optional | Claude CLI binary path (default `claude`) |
| `CLAUDE_MODEL` | optional | Default model (default `claude-sonnet-4-6`) |
| `AGENT_TIMEOUT_SECONDS` | optional | Wall-clock kill for an agent run (default 900) |
| `ALERTFORGE_RUN_MODE` | optional | `container` to run worker in-band with server (single-process dev) |
| `ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL` | optional | Skip first-signup race by pre-seeding the admin account |

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
`repos.prReviewers` via `/repos`) can comment `/alertforge apply`
or `/alertforge <free-form instruction>` to drive another iteration.
Without the webhook, the same comments are picked up by the 5-min cron.

### Upgrading from `sentry-fixer-bot` / `alertforge-2.0.x`

`alertforge-2.1.0` (P9, shipped 2026-05-23) drops every back-compat
shim. Operators who deployed any earlier `mvp-*` or `alertforge-2.0.x`
release must migrate before pulling this code:

1. **Env keys**: `SFB_*` no longer fallback to `ALERTFORGE_*`. Switch
   every env var in `/etc/alertforge/env` + GitHub Actions secrets to
   the `ALERTFORGE_*` prefix.
2. **Filesystem paths**: `/var/lib/sfb`, `/etc/sfb`, `/opt/sfb`
   symlinks are no longer auto-created at boot. Operators on stale
   layouts should manually `ln -s` or move data to
   `/var/lib/alertforge`, `/etc/alertforge`, `/opt/alertforge`.
3. **Slash command**: `/sfb` PR comments are no longer recognised.
   Reviewers must use `/alertforge` (or `/alertforge apply`,
   `/alertforge <instruction>`).
4. **Database**: migration `0008_drop_repos_config.sql` renames the
   legacy `repos_config` table to its canonical name `repos` with a
   pre-flight `DO $$` safety block that aborts if any `repos_config`
   row lacks a matching `triggers` row. Operators verify with
   `psql -c "SELECT (SELECT count(*) FROM repos_config) AS rc,
   (SELECT count(*) FROM triggers WHERE source_type='sentry') AS t;"`
   BEFORE running `bun --filter=@alertforge/db db:migrate`.
5. **Cookie prefix** stays at `sfb` deliberately — switching it would
   invalidate every active session at deploy. Future coordinated
   session-rollover release will flip it.

The MVP `mvp-1.x` tag points at the pre-rename behaviour for any
operator who cannot upgrade and needs to stay on the old surface.

## Deploy

See [`docs/runbook.md`](docs/runbook.md) for the EC2 + systemd + nginx
setup, env file shape, key rotation, and recovery procedures.

## Project layout

```
alertforge/
├── apps/
│   ├── server/         # Hono API + webhook routes + worker handlers + cron + chat WS
│   └── web/            # React admin UI (TanStack Router, file-based routes)
├── packages/
│   ├── alertforge-core/         # pipeline runtime + ctx-store + adapter registry +
│   │                            # source/channel/step types + no-ctx-in-buildprompt lint
│   ├── api/                     # tRPC routers (triggers, channels, runs, repos, ...)
│   ├── auth/                    # Better-Auth wiring, trusted origins, doctor, claim
│   ├── db/                      # Drizzle schema + migrations + seed
│   ├── env/                     # zod-validated env schemas
│   ├── ui/                      # shadcn/ui components (Base UI v2)
│   ├── sources/sentry/          # source adapter — Sentry webhook + parseUrl + dedup
│   ├── channels/slack/          # channel adapter — Slack Block Kit via incoming webhook
│   ├── channels/email/          # channel adapter — Resend HTTP API + severity floor
│   └── steps/                   # pipeline steps (one workspace package per step):
│       ├── classify/            #   LLM triage (Haiku default)
│       ├── budget/              #   daily token + cost cap enforcement
│       ├── workspace/           #   git clone + worktree management
│       ├── fix-agent/           #   Claude Code spawn + prompt + parse + stream
│       ├── secret-scan/         #   pre-PR secret pattern scanner
│       ├── test-gate/           #   detect-test-command + ensure-deps + run-tests
│       ├── open-pr/             #   commit + push + gh pr create
│       ├── review-pr/           #   LLM reviewer (second-pass)
│       ├── follow-up/           #   `/alertforge` PR comment loop
│       ├── fan-out-channels/    #   channel dispatch
│       ├── outcome-poll/        #   daily PR-outcome polling (P8)
│       └── daily-digest/        #   per-trigger 7d roll-up to channels (P8)
├── deploy/
│   ├── nginx/alertforge.conf
│   ├── systemd/                 # alertforge-{web,worker,cron,backup}.{service,timer}
│   └── ec2/userdata.sh
└── docs/
    ├── alertforge/              # canonical post-rename specs + plans + ADRs + catalog
    ├── design.md                # original MVP design (pre-rename, historical)
    ├── architecture.md          # deployment topology + data model (pre-rename)
    ├── runbook.md               # operator runbook
    └── PROGRESS.md              # rolling status tracker
```

## Adding a new source or channel adapter

The pluggable pipeline is the whole point of the 2.0 abstraction. New
sources (PostHog, PagerDuty, Datadog, OpsGenie, …) and new channels
(PagerDuty-out, Teams, Discord, Linear-issue, generic-webhook) land as
**one workspace package + one line in `register-adapters.ts`** — no
core changes.

### Source adapter (new alert source)

1. Create `packages/sources/<name>/` from the Sentry adapter as
   template (`packages/sources/sentry/` is the reference shape).
2. Default-export a `SourceAdapter` from `@alertforge/core` with
   these methods: `verifyWebhook(req, secret)`, `parsePayload(body)`,
   `dedupKey(alert)`, optional `fetchEventDetail(...)`, optional
   `postAlertComment(...)`. For the manual-URL-trigger surface (D17):
   `urlPatterns: RegExp[]`, `parseUrl(url)`, `fetchByExternalId(...)`.
3. Add `configSchema` (zod) for the per-source-project install config
   + `catalogEntry` (description, `setupGuide` markdown string,
   `requiresEnvKeys`, `urlExamples`).
4. Add tests: `parsePayload` fixtures, `dedupKey` parity, `parseUrl`
   positive + negative cases, `fetchByExternalId` mocked HTTP.
5. Wire in `apps/server/src/register-adapters.ts`:

   ```ts
   import myAdapter from "@alertforge/source-<name>";
   registry.registerSource(myAdapter);
   ```
6. Add a row to `docs/alertforge/catalog/sources.md`.

The generic `POST /webhooks/:sourceType` route + the trigger-resolver
+ the manual URL trigger UI auto-pick up the new adapter at boot. No
schema migration; per-source-project install config lives on
`triggers.config.sourceConfig` (jsonb, validated by your adapter's
`configSchema` at insert time).

### Channel adapter (new notification outbound)

1. Create `packages/channels/<name>/` from the Slack adapter as
   template.
2. Default-export a `ChannelAdapter` with `configSchema` (per-channel
   install config), `send(notification, config)`, and `catalogEntry`.
3. Tests: configSchema validation, `send` POST shape (mocked
   transport).
4. Wire in `apps/server/src/register-adapters.ts`:

   ```ts
   import myChannel from "@alertforge/channel-<name>";
   registry.registerChannel(myChannel);
   ```
5. Add a row to `docs/alertforge/catalog/channels.md`.

The fan-out step (`packages/steps/fan-out-channels/`) iterates
`channel_configs` rows for a trigger + dispatches to your adapter at
notification time. The trigger detail page's **Channels** tab + the
**+ Add channel** dialog auto-discover your adapter from
`channels.listAdapters` tRPC + render its `configSchema` as a dynamic
form via `RegistryConfigForm`.

See [`docs/alertforge/specs/2026-05-21-source-adapter-contract.md`](docs/alertforge/specs/2026-05-21-source-adapter-contract.md)
and [`docs/alertforge/specs/2026-05-21-channel-adapter-contract.md`](docs/alertforge/specs/2026-05-21-channel-adapter-contract.md)
for the full contract.

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
  `repos.prReviewers` allow-list — comments from anyone else are
  ignored
- Branch protection enforced externally (the bot literally cannot
  bypass it)
- Outbound network allowlist via iptables on the EC2 instance

## License

MIT. See `LICENSE`.
