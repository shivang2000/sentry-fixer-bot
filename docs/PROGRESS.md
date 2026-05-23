# Alertforge (née sentry-fixer-bot) — Progress Tracker

> **P7 rename note (2026-05-23):** `sentry-fixer-bot` was renamed to
> `alertforge`. This file preserves the historical record of the MVP
> phase; the canonical post-rename home for new specs + plans is
> [`docs/alertforge/`](alertforge/). References to the old name below
> are intentional historical context.

**Last updated:** 2026-05-16 (post V2 UI completion)
**Tag:** `mvp-1.0.0`
**Plan executed:** [`plans/2026-05-16-v2-ui-completion-plan.md`](plans/2026-05-16-v2-ui-completion-plan.md)
**Commits since plan committed:** 28 + V2 UI work (local; push pending)

This is the canonical status of the project against the design docs:
[`design.md`](design.md), [`architecture.md`](architecture.md),
[`v2-frontend-and-skills.md`](v2-frontend-and-skills.md),
[`planning.md`](planning.md), and the execution plan
[`plans/2026-05-15-scaffold-and-mvp-plan.md`](plans/2026-05-15-scaffold-and-mvp-plan.md).

Status legend:

| Symbol | Meaning |
|---|---|
| ✅ | Done — code shipped, tests pass, verified |
| 🟡 | Partial — code present, integration or UI missing |
| ⬜ | Not started |
| ⏭️ | Explicitly deferred (V3+ or out of scope) |

---

## Section A — Scaffold bootstrap

| Task | Status | Evidence |
|---|---|---|
| A1: Preflight (bun, git, gh, claude, aws, docker on PATH) | ✅ | bun 1.3.5, gh 2.78, claude 2.1.142 confirmed |
| A2: Scaffold via `create-better-t-stack` | ✅ | `deploy/scaffold/bts-input.json`, commit `bd3ec2e` |
| A3: Record scaffold versions | ✅ | `docs/scaffold-versions.md` |
| A4: Align Biome formatting | ✅ | 2-space, double-quote, semis, 100-col |
| A5: Env keys + zod schema | ✅ | `packages/env/src/server.ts`, `.env.example` |

## Section B — Auth + deployment modes

| Task | Status | Evidence |
|---|---|---|
| B1: trusted-origins resolver | ✅ | 5 TDD tests, `packages/auth/src/trusted-origins.ts` |
| B2: Better-Auth wired (email+password + bind-aware cookies) | ✅ | `packages/auth/src/index.ts` |
| B3: invites + boardClaimTokens tables + user.role | ✅ | Drizzle migration 0000 |
| B4: First-signup-becomes-admin + invite gate | ✅ | databaseHooks.user.create in auth config |
| B5: local_trusted bootstrap admin | ✅ | `bootstrapLocalTrustedAdmin()` + 4 tests |
| B6: Session middleware with local_trusted auto-auth | ✅ | `requireRole()` + 5 tests |
| B7: `/board-claim/:token` route | ✅ | `apps/server/src/routes/board-claim.ts` + 7 tests |
| B8: Startup doctor (refuses unsafe authenticated+public) | ✅ | `doctorVerdict()` + 8 tests |

## Section C — Domain schema

| Task | Status | Evidence |
|---|---|---|
| C1: V1 tables (alerts, runs, prs, budgets) | ✅ | `packages/db/src/schema/domain.ts`, migration 0001 |
| C2: V2 admin tables (repos_config, mcp_*, skill_installs, chat_*) | ✅ | `packages/db/src/schema/admin.ts`, migration 0002 |
| C3: Seed script for local dev | ✅ | `bun --filter=@sentry-fixer-bot/db db:seed` |

## Section D — V1 domain code (webhook → triage → agent → PR)

| Task | Status | Evidence |
|---|---|---|
| D1: `/healthz` | ✅ | `apps/server/src/routes/health.ts` |
| D2: HMAC SHA-256 verifier (constant-time) | ✅ | 5 TDD tests, `verify-hmac.ts` |
| D3: Sentry payload fixtures | ✅ | `apps/server/tests/helpers/fixtures.ts` |
| D4: Dedup key | ✅ | 6 TDD tests, `alerts/dedup-key.ts` |
| D5: Alert upsert (ON CONFLICT bump webhook_count) | ✅ | `alerts/persist.ts` |
| D6: S3 archive (with `local://` dev sentinel) | ✅ | `archive/s3.ts` |
| D7: Sentry webhook route | ✅ | POST `/webhooks/sentry` → 202 |
| D8: pg-boss queue init + createQueue (v12 fix) | ✅ | `queue/boss.ts` |
| D9: Job types | ✅ | `JOB_TRIAGE`, `JOB_AGENT` |
| D10: Sentry client (getLatestEvent + extractStackTrace) | ✅ | `sentry/client.ts` |
| D11: Haiku classify | ✅ | 5 tests for `parseTriageJson` |
| D12: Sentry comment (no-op when token absent) | ✅ | `sentry/comment.ts` |
| D13: Run persist (Drizzle) | ✅ | `runs/persist.ts` |
| D14: Budget enforce | ✅ | 4 tests for `decideBudget` |
| D15: GitHub App auth (Octokit + installation token) | ✅ | `github/app-auth.ts` |
| D16: Per-run workspace clone | ✅ | `agent/workspace.ts` |
| D17: Agent prompt | ✅ | `agent/prompt.ts` |
| D18: Claude spawn (`--print --dangerously-skip-permissions`) | ✅ | `agent/spawn.ts`, SIGTERM on timeout |
| D19: Parse agent output (`<summary>` envelope) | ✅ | 4 TDD tests |
| D20: Secret scan (AWS, GitHub PAT, OpenAI, Anthropic, JWT) | ✅ | 5 TDD tests |
| D21: Test gate (Bun.spawn) | ✅ | `gate/run-tests.ts` |
| D22: PR opener (gh CLI) | ✅ | `github/pr.ts` |
| D23: Worker entry + agent job orchestrator | ✅ | `worker/index.ts`, `agent-job.ts` |
| D24: Triage job orchestrator | ✅ | `worker/triage-job.ts` |

## Section E — V2 admin UI

| Task | Status | Evidence |
|---|---|---|
| E1: tRPC context with user + adminProcedure | ✅ | `packages/api/src/context.ts`, `index.ts` |
| E2: Repos CRUD router (list / create / update / delete) | ✅ | `packages/api/src/routers/repos.ts` |
| E3: `/repos` list page | ✅ | `apps/web/src/routes/repos.tsx` (refreshed with shadcn Table + actions) |
| E4: Add/Edit/Delete form pages | ✅ | `RepoForm` modal + `/repos/$id` dedicated edit page + `ConfirmDialog` delete |
| E5: MCP catalog + install router | ✅ | `routers/mcps.ts`, `mcps-catalog.ts` |
| E6: Env-file writer (atomic + systemctl reload) | ✅ | `secrets/env-file.ts` + shell-quote tests |
| E7: MCP catalog + install UI page | ✅ | `/mcps` two-tab page + `McpInstallDialog` with xterm install log |
| E8: Skills install router (built-in + upload + skills.sh) | ✅ | `packages/api/src/routers/skills.ts` with catalog/list/installBuiltin/installCustom/installFromSh/uninstall + `skills-zip.ts` safety helpers |
| E9: Skills page UI | ✅ | `/skills` three-tab page (Built-in / Custom upload / skills.sh) |
| E10: Per-run claude-home renderer (MCPs + skills into agent run) | ✅ | `agent/render-claude-home.ts` |
| E11: Runs/PRs read API + UI page | ✅ | `routers/runs.ts`, `/runs` page |
| E12: Settings page (Anthropic / GitHub App status, kill switch) | ⬜ | env keys exist; no UI (deferred to V2.1) |
| E13: Invite management UI | ⬜ | `invites` table + first-signup logic; UI absent (deferred) |
| E14: Audit log | ⬜ | no `audit_log` table yet (deferred) |

## Section F — Chat (PTY + WebSocket + OAuth URL capture)

| Task | Status | Evidence |
|---|---|---|
| F1: PTY runner for Claude subprocess | ✅ | `chat/pty-runner.ts` via `script -q -c` |
| F2: OAuth URL detector | ✅ | 6 TDD tests, `chat/url-detector.ts` |
| F3: WebSocket chat endpoint | ✅ | GET `/api/chat/:sessionId`, `routes/chat-ws.ts` |
| F4: Chat tRPC router (create/list/messages/end) | ✅ | `routers/chat.ts` |
| F5: `/chat` UI page | ✅ | xterm.js terminal + WebSocket client + `OAuthCard` intercept + session picker |
| F6: Idle timeout (30 min) + budget integration | ⬜ | sessions live forever; budget not charged (deferred) |
| F7: Single concurrent session per user | ✅ | enforced in `chat.create` mutation |

## Section G — Deploy

| Task | Status | Evidence |
|---|---|---|
| G1: nginx config (HTTP→HTTPS, WS upgrade, HSTS) | ✅ | `deploy/nginx/sfb.conf` |
| G2: systemd units (sfb-server, sfb-worker) | ✅ | `deploy/systemd/sfb-*.service` |
| G3: Daily pg_dump → S3 (timer + script) | ✅ | `sfb-backup.{service,timer}`, `scripts/backup-db.sh` |
| G4: EC2 userdata bootstrap | ✅ | `deploy/ec2/userdata.sh` |
| G5: Web baked into server's static dir for production | ✅ | `bun run build` copies `apps/web/dist/` → `apps/server/public/` |

## Section H — End-to-end verify + tag

| Task | Status | Evidence |
|---|---|---|
| H1.1: Fresh docker postgres + migrate + seed | ✅ | 5433 (5432 in use); migrations applied; seed: "seed applied" |
| H1.2: `/healthz` returns 200 | ✅ | smoke output captured |
| H1.3: Webhook → DB (fresh alert) | ✅ | HTTP 202 `{ ok, alertId, isNew: true }`; 2 alerts rows |
| H1.4: Trusted → authenticated mode + claim URL | ⬜ | logic shipped + tested; not exercised end-to-end |
| H1.5: Install MCP via UI; appears in agent run mcp_servers.json | 🟡 | per-run renderer works; UI install form absent (E7) |
| H1.6: Chat session with fake OAuth URL flow | 🟡 | WS + detector + router ready; UI page absent (F5) |
| H2: Deploy to real EC2 | ⬜ | needs AWS creds; userdata + nginx + systemd all present |
| H3: Tag `mvp-1.0.0` | ✅ | `git tag mvp-1.0.0` on `0a4a17e` |

---

## Cross-cutting summary

### Tests

- **bun test**: 120 pass / 0 fail / 159 expect() calls (added 9 tests for skills catalog + zip validation)
- **check-types**: green across 8 packages (server, web, api, auth, db, env, ui, config)
- Pure-function TDD coverage: HMAC verify, dedup key, trusted origins, role check, claim validate, doctor verdict, parseTriageJson, decideBudget, parseAgentOutput, scanText, detectOAuthPrompt, shellQuote/isValidEnvKey, shouldSeedLocalBoard

### Architecture features (from `architecture.md`)

| Feature | Status | Notes |
|---|---|---|
| Deployment topology (nginx → Hono → Postgres/S3) | ✅ | nginx config + compose + S3 wrapper |
| 3-process model (sfb-web, sfb-worker, sfb-cron) | 🟡 | server + worker done; **sfb-cron NOT built** |
| pg-boss queue | ✅ | createQueue v12 fix included |
| Data model (alerts/runs/prs/budgets) | ✅ | full schema |
| HMAC verify + timing-safe compare | ✅ | |
| Outbound network allowlist via iptables | ⬜ | documented, not enforced — operator runbook |
| sfb-runner uid 4000, no sudo, no AWS creds env | 🟡 | userdata creates user; uid auto-assigned not pinned to 4000 |
| S3 KMS encryption + signed URL access | ⬜ | bucket + S3 wrapper done; KMS + signed-URL admin endpoint absent |
| CloudWatch logs + metrics | ⬜ | pino → stdout → journal → no CloudWatch agent |
| CloudWatch alarms (5xx, queue depth, cost burn) | ⬜ | not configured |
| Grafana dashboard | ⬜ | |
| Stale-PR auto-close (>7d no merge) | ⬜ | needs sfb-cron |
| Dedup table prune (>30d) | ⬜ | needs sfb-cron |
| Daily budget reset cron | ⬜ | budgets table is per-day already; explicit reset not needed |

### V2 features (from `v2-frontend-and-skills.md`)

| Feature | Status | Notes |
|---|---|---|
| Better-Auth email+password | ✅ | |
| Deployment modes (local_trusted / authenticated) | ✅ | |
| Bind decoupled (loopback/lan/tailnet/custom) | ✅ | |
| Invites + first-signup-admin + claim URL | ✅ | |
| Repo CRUD (replaces repos.yaml) | ✅ | list + add modal + edit page + delete confirm |
| MCP catalog | ✅ | hand-rolled (github + filesystem) |
| MCP install API + secret env-file writer | ✅ | |
| MCP install UI form | ✅ | `/mcps` tabs + dynamic envSchema form + xterm install log |
| Skill install (built-in + upload + skills.sh) | ✅ | router + 3-tab UI; skills.sh degrades to external link |
| Per-run claude-home rendering | ✅ | |
| Chat (PTY + WebSocket + OAuth URL capture) | ✅ | `/chat` route with xterm + OAuth intercept card |
| Sidebar nav (Paperclip-style) | ✅ | `app-sidebar.tsx` + `SidebarProvider`/`SidebarInset` in `__root.tsx` |
| Audit log | ⬜ | (deferred to V2.1) |
| Settings page | ⬜ | (deferred to V2.1) |
| Server-Sent Events for run status push | ⬜ | runs UI polls; SSE not built (deferred) |

---

## Operational / infra gaps

| Item | Status | Action needed |
|---|---|---|
| `git push origin main mvp-1.0.0` | ⬜ | safety classifier blocked direct push to main; operator runs manually |
| README quickstart | ✅ | rewritten for `mvp-1.0.0` + V2 UI; bun/docker/ngrok flow + first-signup admin |
| CI pipeline (GitHub Actions) | ✅ | `.github/workflows/ci.yml` runs `bun install --frozen-lockfile`, `bun run check-types`, `bun test` on PRs + main |
| Pre-commit hooks (lint-staged + biome) | ✅ | husky installed by scaffold |
| Pre-push secret scan | ⬜ | the bot's *own* commits don't run a secret scan; only agent runs do |
| Operator runbook | ✅ | `docs/runbook.md` — env, systemd, EC2 boot, backup/restore, key rotation, kill switch, failure table |
| ANTHROPIC_API_KEY + GitHub App + S3 + Sentry creds for E2E | ⬜ | required for D-section worker smoke |
| EBS volume encryption + KMS keys | ⬜ | architecture.md §3 specifies; not enforced |
| IAM role on EC2 (put-only S3) | ⬜ | userdata creates instance; IAM role policy out of scope of script |
| Sentry internal-integration setup docs | ⬜ | how to mint `SENTRY_API_TOKEN` not documented |
| GitHub App registration steps | ⬜ | scopes + private key flow not documented |
| Slack notifications | ⏭️ | V3 per design.md §11 |

---

## Test repo onboarding gaps (planning.md §2 preconditions)

To onboard a repo for the bot to fix:

- [ ] Configure GitHub App on the repo with `contents: write` + `pull_requests: write` (no admin)
- [ ] Branch protection on default branch (rejects direct pushes, requires PR review)
- [ ] CODEOWNERS or named reviewers in `repos_config.pr_reviewers`
- [ ] Deterministic test command set in `repos_config.test_command`
- [ ] Sentry project tag `release` populated so dedup can split by code version
- [ ] Insert a `repos_config` row (currently: via tRPC `repos.create`; UI form ⬜)

---

## Deferred to V3+ (per `design.md` §11 / `v2-frontend-and-skills.md` §7)

| Item | Reason |
|---|---|
| Multi-region deploy | single us-east-1 V1 |
| Multi-tenant SaaS | YAGNI for single-org install |
| Self-improvement loop (RL from merge rate) | V4 |
| Cross-repo fixes | one repo per run V1 |
| Sentry performance issues / session replay | error issues only |
| GitLab / Bitbucket adapter | github-only |
| Multi-LLM fallback (OpenAI/Gemini) | V3 |
| Local triage model | V3 |
| Diff-only mode (comment instead of PR) | V3 |
| PR-comment chat | V3 |
| Slack notifications | V3 |
| Cron PR-state polling | V3 |
| Skill authoring UI | V3 |

---

## Next minimum work to make this usable end-to-end

V2 UI completion plan (`plans/2026-05-16-v2-ui-completion-plan.md`) shipped. Remaining items:

1. **Push to GitHub** (manual: `git push origin main mvp-1.0.0` + the V2 UI work)
2. **Sentry internal-integration + GitHub App setup docs** — what scopes, how to mint the token
3. **E12 — Settings page** (Anthropic / GitHub App status, kill switch toggle)
4. **E13 — Invite management UI**
5. **F6 — Chat idle timeout (30 min) + budget integration**
6. **sfb-cron service** for stale-PR close + dedup prune (architecture.md §6)
7. **CloudWatch agent + alarms** (architecture.md §8)
8. **EC2 deploy smoke** (H2) — needs AWS creds + GitHub App + Sentry creds in `/etc/sfb/env`
9. **Skills.sh API contract**: once known, finalise the results renderer in `/skills` skills.sh tab (currently shows "Render TBD")
10. **E14 — Audit log** (`audit_log` table + UI)

---

## Commit history since `e730f80 docs(plan): scaffold-first MVP plan`

28 commits in execution order — every section has its own commit log entry with conventional-commits + Constraint/Rejected/Confidence trailers per `~/.claude/CLAUDE.md`.

Run `git log --oneline e730f80..HEAD` for the full list.
