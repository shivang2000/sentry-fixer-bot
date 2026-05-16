# V2 UI completion — design spec

**Date:** 2026-05-16
**Status:** Approved, ready for implementation plan
**Scope:** Finish the V2 operator product UI gaps left after `mvp-1.0.0`
**Companion docs:** [`design.md`](../../design.md), [`architecture.md`](../../architecture.md), [`v2-frontend-and-skills.md`](../../v2-frontend-and-skills.md), [`PROGRESS.md`](../../PROGRESS.md)

This spec captures the design decisions for completing the V2 admin UI. Backend (tRPC routers, schema, env-file writer) is already shipped. Remaining work is **frontend + one new router (skills) + CI + docs**.

---

## 1. Goals

- Give operators a self-service UI for: repo CRUD, MCP install, skill install, chat with Claude, settings (deferred — see §10).
- Match the V2 spec (`v2-frontend-and-skills.md` §2.2).
- Use shadcn/ui consistently for forms, dialogs, tabs, and the sidebar nav.
- Use xterm.js for terminal-style streaming output in chat, MCP install logs, and skill install logs.
- Ship CI (check-types + tests on PR) and an operator-grade README + runbook.

## 2. Non-goals (deferred)

- E12 Settings page (Anthropic key / GitHub App / kill switch UI) — schema + writers exist, UI is V2.1.
- E13 Invite management UI — backend `invites` table exists; UI in V2.1.
- E14 Audit log — no `audit_log` table yet; out of scope for this spec.
- F6 Chat idle timeout + budget integration — backend wiring, not UI.
- SSE for run status push — `/runs` keeps polling.

## 3. Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│ shadcn Sidebar (left rail, Paperclip-style)             │
│ ┌──────────┬───────────────────────────────────────────┐│
│ │ ▣ SFB    │                                           ││
│ │ ⌂ Home   │  Outlet (TanStack Router)                 ││
│ │ ▦ Repos  │                                           ││
│ │ ⚙ MCPs   │   /            dashboard                  ││
│ │ ✦ Skills │   /repos       list + modal add + delete  ││
│ │ ↻ Runs   │   /repos/$id   full-page edit form        ││
│ │ ◉ Chat   │   /mcps        Catalog | Installed tabs   ││
│ │ ─────    │   /skills      Built-in|Custom|skills.sh  ││
│ │ ⚙ Settings   /chat        xterm + OAuth card         ││
│ │ ─────    │   /runs        existing list              ││
│ │ ◐ Theme  │                                           ││
│ │ ◯ User   │                                           ││
│ └──────────┴───────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

### Tech additions

| What | Why | Where |
|---|---|---|
| shadcn `sidebar` block | Paperclip-style nav, collapsible, icon + label | `__root.tsx` wraps all routes |
| shadcn `dialog`, `select`, `tabs`, `textarea`, `tooltip`, `separator` | Form + tab UI | `packages/ui/src/components/` |
| `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` | ANSI-correct terminal rendering for chat and install logs | `apps/web/src/components/xterm-panel.tsx` |
| shadcn MCP (`.mcp.json`) | Component install via MCP in future sessions | repo root, already added |

### Shared components

- `apps/web/src/components/app-sidebar.tsx` — sidebar nav with all links + icons (lucide)
- `apps/web/src/components/xterm-panel.tsx` — reusable xterm.js wrapper (controlled, accepts write API via ref or props)
- `apps/web/src/components/confirm-dialog.tsx` — shadcn Dialog wrapper for destructive actions

---

## 4. E4 — Repo CRUD

**Files:**
- `apps/web/src/routes/repos.tsx` — list page; add "Add repo" button; row actions (edit link, delete dialog)
- `apps/web/src/routes/repos.$id.tsx` — **new** full-page edit form
- `apps/web/src/components/repo-form.tsx` — **new** shared form used by add modal + edit page

**RepoForm fields** (mapped 1:1 from `reposRouter.create` zod input):

| Field | shadcn control | Notes |
|---|---|---|
| `sentryProject` | Input | required, unique |
| `github` | Input | placeholder `owner/repo`, regex validated |
| `defaultBranch` | Input | default `main` |
| `testCommand` | Input | e.g. `bun test` |
| `prReviewers` | Input (comma-split on submit) | string[] in backend |
| `dailyTokenCap` | Input type=number | int positive |
| `dailyCostCapCents` | Input type=number | displayed in dollars; converted to cents on submit |
| `minSeverityToFix` | Select | `low|medium|high|critical` |
| `enabled` | Checkbox | default true |

**Add flow:** `/repos` → "Add repo" button → Dialog with `<RepoForm mode="create">` → on submit → `trpc.repos.create.mutate()` → close dialog → refetch list → toast success.

**Edit flow:** row pencil icon → `Link` to `/repos/$id` → loader fetches via `trpc.repos.list` (filter by id) or new `repos.byId` query (small router addition) → renders `<RepoForm mode="edit" initial={...}>` → on submit → `trpc.repos.update.mutate()` → toast → `navigate('/repos')`.

**Delete flow:** row trash icon → `<ConfirmDialog>` → on confirm → `trpc.repos.delete.mutate({id})` → refetch.

**Router addition:** add `byId` query to `reposRouter` (1-line: `select where id`) for the edit-page loader. Alternative: select-from-list on client. Going with `byId` for cleaner URL-driven loading.

## 5. E7 — MCP install UI

**Files:**
- `apps/web/src/routes/mcps.tsx` — **new** page with shadcn `Tabs` (Catalog | Installed)
- `apps/web/src/components/mcp-install-dialog.tsx` — **new** install form + xterm install log

**Catalog tab:**
- `useQuery(trpc.mcps.catalog.queryOptions())` → grid of `Card` per entry
- Each card: name (h3), description, tags row, homepage link icon, "Install" button (primary)
- Click Install → opens `<McpInstallDialog catalog={entry} />`

**Install dialog flow:**
1. Field `scope`: `Select` global | repo
2. If `scope === "repo"`: `Select` of `trpc.repos.list` results (sentryProject as value)
3. For each key in `entry.envSchema`: render `<Input type={spec.secret ? "password" : "text"} />` with description as hint, asterisk if required
4. Submit button → calls `trpc.mcps.install.mutate({ catalogId, scope, repo, envValues })`
5. **xterm panel** below the form shows streaming install log: `Writing secrets…`, `Updating /etc/sfb/env…`, `Reloading systemd…`, `✓ Installed`. Server emits these as the mutation runs — implemented as a synthetic message log since the actual call is a single tRPC mutation, not a stream. (Future enhancement: switch to streaming subscription.)
6. On success → close after 2s → refetch installed list

**Installed tab:**
- Table: name | scope | repo | catalog_id | enabled toggle | uninstall button
- Uninstall → `<ConfirmDialog>` → `trpc.mcps.uninstall.mutate({id})` → refetch

## 6. F5 — Chat UI

**Files:**
- `apps/web/src/routes/chat.tsx` — **new** main chat page
- `apps/web/src/components/chat-terminal.tsx` — **new**, mounts xterm.js inside a div, controlled via ref
- `apps/web/src/components/oauth-card.tsx` — **new**, OAuth URL intercept card

### Session lifecycle

1. Land on `/chat`:
   - `trpc.chat.list` to show recent sessions (last 5) with status badges
   - "Start new session" button. Optional repo Select (from `repos.list`).
2. Click start → `trpc.chat.create.mutate({ repo })` → returns `{ id, status }`
3. Open WebSocket: `new WebSocket(`${ws}://${host}/api/chat/${id}`)` (existing route in `apps/server/src/routes/chat-ws.ts`)
4. WS messages from server → write directly to xterm terminal (raw ANSI passthrough from the PTY)
5. Input field below terminal → on Enter → `ws.send(JSON.stringify({ type: "user_input", text: value + "\n" }))`
6. "End session" button → `trpc.chat.end.mutate({sessionId})` → close WS

### OAuth detection

Server already runs `detectOAuthPrompt()` (chat/url-detector.ts). When matched, server sends:

```json
{ "type": "oauth_url", "url": "https://...", "prompt": "Paste auth code:" }
```

Frontend: when this message arrives:
- Pause xterm input (disable input field with a "Waiting on OAuth" state)
- Render `<OAuthCard>` above input: title "Claude needs you to authenticate", URL as `<a target="_blank">`, "Open" button, plus a text field "Paste returned code"
- On submit → `ws.send(JSON.stringify({ type: "oauth_response", code }))` → re-enable input → dismiss card

### xterm config

```ts
new Terminal({
  fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
  fontSize: 13,
  theme: { background: "#0a0a0a", foreground: "#e5e5e5" },
  cursorBlink: true,
  convertEol: true,
  scrollback: 5000,
})
```

`FitAddon` keeps terminal sized to its container. `WebLinksAddon` makes URLs in output clickable.

### Errors / disconnects

- WS `onerror` → toast "Connection lost"; show "Reconnect" button
- WS `onclose` with code 1011 → terminal banner "Session ended (timeout)"
- `chat.create` mutation rejects with `concurrent_session` if user already has an active session → show "End previous session?" dialog (calls `chat.end` on the old one, then retries)

## 7. E8/E9 — Skills

**Backend (new):**
- `packages/api/src/routers/skills.ts` — new router; mounted in `packages/api/src/index.ts` as `skills`
- `packages/api/src/skills-catalog.ts` — **new** built-in catalog (mirrors mcps-catalog.ts pattern)

**Skills router methods:**
- `catalog` (protected query) → returns `SKILLS_CATALOG`
- `list` (protected query) → DB select from `skillInstalls`
- `installBuiltin` (admin mutation) → copies built-in skill files from repo-bundled `packages/api/src/skills-catalog/<id>/` to `/var/lib/sfb/skills/{install_id}/`, inserts `skillInstalls` row
- `installCustom` (admin mutation) → accepts `{ filename, base64Zip }`; validates size (≤5MB), extracts with adm-zip, inserts row
- `installFromSh` (admin mutation) → fetches from `https://www.skills.sh/api/skills/<slug>` (if API exists), saves like custom upload. Returns `{ error: "skills_sh_api_unavailable" }` if 404 or network fails — UI falls back to "browse at skills.sh"
- `uninstall` (admin mutation) → delete row + rm -rf storage_path
- `shList` (protected query, input: `{ q?: string }`) → fetches `https://www.skills.sh/api/list` (or scrapes if no API). Cached 24h in memory.

**Initial built-in catalog** (2 entries to ship value now):
```ts
SKILLS_CATALOG = [
  { id: "sentry-triage", name: "Sentry Triage Enhancer", description: "Augments Haiku triage with breadcrumb interpretation" },
  { id: "pr-reviewer", name: "PR Self-Reviewer", description: "Have the agent self-review its diff before opening PR" },
];
```
Files for each ship in `packages/api/src/skills-catalog/<id>/SKILL.md` (+ optional scripts/).

**Frontend (new):** `apps/web/src/routes/skills.tsx` with `Tabs`:

| Tab | Content |
|---|---|
| **Built-in** | Card grid from `skills.catalog`; "Install" → `skills.installBuiltin` → install log in xterm panel |
| **Custom** | Drag-and-drop zone (Bun's `request.formData()` not needed — we base64 to JSON for tRPC); shows installed custom skills below; xterm-style extraction log on install |
| **skills.sh** | Search input → `skills.shList` query → results grid; "Install" → `skills.installFromSh`; fallback button if API unavailable |

## 8. CI + docs

### `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.5 }
      - run: bun install --frozen-lockfile
      - run: bun run check-types
      - run: bun test
```

### `README.md` quickstart

Sections (rewritten from scaffold default):
1. What it does (1 paragraph from `design.md` §1)
2. Stack (Bun, Hono, Postgres, Drizzle, React, tRPC, Claude Code CLI)
3. Local dev: `bun install`, `docker compose up`, `bun --filter=@sentry-fixer-bot/db db:migrate && db:seed`, `bun dev`
4. First-signup-becomes-admin walkthrough
5. Webhook testing (ngrok command + Sentry webhook config)
6. Deploy → links to `docs/runbook.md`

### `docs/runbook.md`

1. Environment file (`/etc/sfb/env`) shape — key list with what each does
2. systemd commands: `systemctl {start,stop,reload} sfb-{web,worker}`, journal tailing
3. EC2 boot sequence (userdata flow)
4. Backup / restore (`scripts/backup-db.sh`, restoring from S3)
5. Key rotation (Anthropic / GitHub App / Sentry)
6. Switching `local_trusted` → `authenticated` (board-claim URL flow)
7. Kill switch (env var to disable agent runs)
8. Common failures table (from `architecture.md` §9)

## 9. Risk and mitigations

| Risk | Mitigation |
|---|---|
| xterm.js bundle size | Lazy-import on `/chat` route only via TanStack Router's code splitting; ~150kb gzipped, acceptable for admin UI |
| MCP install dialog reports success but secret write fails partway | Server already does atomic env-file rename + transaction-style rollback in `setEnvSecret`. UI shows error toast on mutation reject. |
| skills.sh API doesn't exist | Router returns `{ error: "skills_sh_api_unavailable" }`; UI shows "Open skills.sh in a new tab to find a skill" button |
| Chat WS reconnect storms during deploy | Server already terminates sessions on shutdown; UI shows banner not reconnect-loop |
| Custom zip upload bombs | Server validates ≤50 files, ≤5MB uncompressed, no symlinks outside extraction dir (matches v2 doc §6) |
| TanStack Router code-splitting + xterm browser-only require | Wrap xterm import in `useEffect` to avoid SSR concerns (Vite is CSR here, but lazy is safer) |

## 10. Out of scope (future)

- E12 Settings page
- E13 Invite management UI
- E14 Audit log
- F6 Chat idle timeout enforcement
- SSE for run status push
- sfb-cron service (stale PR close, dedup prune)
- CloudWatch agent + alarms
- Multi-LLM fallback

## 11. Acceptance criteria

This spec is "done" when:

- [ ] Sidebar nav present on every authenticated route; ModeToggle + UserMenu in `SidebarFooter`
- [ ] `/repos` supports add (modal), edit (`/repos/$id`), delete (confirm); all three call existing tRPC mutations and refetch
- [ ] `/mcps` shows catalog + installed tabs; install dialog renders form from `envSchema`; install log shows in xterm panel; uninstall works
- [ ] `/skills` has 3 tabs; built-in install works; custom zip upload works; skills.sh tab degrades gracefully if API absent
- [ ] `/chat` opens session via tRPC, streams WS into xterm, OAuth card intercepts and responds correctly
- [ ] CI workflow runs on PRs and pushes; both `check-types` and `bun test` pass
- [ ] README quickstart and `docs/runbook.md` exist and are accurate
- [ ] Existing 87 tests still pass
- [ ] New: at least 3 unit tests for the skills router (catalog return, builtin install, uninstall rmtree)

## 12. Decision log

| Decision | Why | Rejected alternative |
|---|---|---|
| shadcn sidebar over custom hand-rolled | Matches Paperclip pattern user referenced; ships polished collapsing behavior | Bespoke nav — more code, less consistent |
| xterm.js over styled `<pre>` | Claude Code CLI output uses ANSI escapes (colors, cursor moves); xterm renders correctly | `pre` would render escape sequences literally |
| Modal add + dedicated edit page | Modal is fast for the common path; full page works better for the 9-field edit form | Modal-only — cramped; full-page-only — slow add path |
| New `byId` repos query for edit loader | URL-driven loading is cleaner than passing data via navigate state | Client-side select-from-list — fragile if user deep-links |
| Skills.sh: try API, degrade to "open in tab" | We don't know if API exists; degrading is honest | Block the tab entirely — bad UX |
| Custom skill upload via base64 JSON over tRPC | Reuses existing tRPC plumbing; no separate multipart endpoint | New REST upload endpoint — extra surface area for a 5MB limit |
| MCP install log is synthetic (not server-streamed) | Mutation is short; full streaming requires SSE/WS plumbing | Switch to subscription later if needed |
