# V2 UI completion — implementation plan

**Repo:** `/Users/shivang/dev/sentry-fixer-bot`  
**Spec:** `docs/superpowers/specs/2026-05-16-v2-ui-completion-design.md` (approved)  
**Date:** 2026-05-16

## Context

`sentry-fixer-bot` shipped `mvp-1.0.0` with the full backend pipeline (webhook → triage → agent → PR), 87 passing tests, and a partial admin UI. The remaining gaps from `docs/PROGRESS.md` are entirely frontend (E4 repo CRUD forms, E7 MCP install UI, F5 `/chat` page, E8/E9 skills install + UI) plus CI and operator docs.

Without these the app is unusable as the "self-service operator product" described in `docs/v2-frontend-and-skills.md`: operators have to hand-edit `repos.yaml`, can't install MCPs without SSH, and can't reach the chat WebSocket from a browser.

Outcome: every existing tRPC mutation reachable from the UI; xterm-style terminal for chat + install logs; Paperclip-style shadcn sidebar nav; CI + README + runbook shipped. Backend stays untouched except for one read-only `repos.byId` query and a new `skills` router.

## Verified codebase facts (drive the plan)

- shadcn config (`packages/ui/components.json`) uses **Base UI** (`@base-ui/react`), style `base-lyra`, lucide icons. shadcn MCP already wired in `.mcp.json`.
- Forms use **TanStack React Form 1.28.0**. Reference pattern: `apps/web/src/components/sign-in-form.tsx`. Do NOT introduce react-hook-form (the `@hookform/resolvers` dep in `apps/web/package.json` is dead — remove in Phase F).
- `lucide-react` already in `apps/web` deps. `xterm` is NOT — install it in Phase A.
- 8 shadcn components installed in `packages/ui/src/components/`: `button card checkbox dropdown-menu input label skeleton sonner`. Missing: `sidebar dialog select tabs textarea separator tooltip table sheet` — install via `bunx shadcn add` in Phase A.
- WS protocol (verified in `apps/server/src/routes/chat-ws.ts`):
  - server → client: `{type:"stdout", data}` | `{type:"oauth_url", url, sessionId}` | `{type:"exit", code}` | `{type:"error", message}`
  - client → server: `{type:"user_input", data}` | `{type:"oauth_response", code}` — note **`data`**, not `text`.
- Auth pattern: `authClient.getSession()` in TanStack Router `beforeLoad`, `authClient.useSession()` on client. Pattern in `apps/web/src/routes/dashboard.tsx`.
- `skillInstalls` table already exists in `packages/db/src/schema/admin.ts` — **no migration** needed for E8.
- Existing tRPC routers in `packages/api/src/routers/`: `repos`, `mcps`, `chat`, `runs`, plus `whoami` + `healthCheck` in root.
- MCP catalog pattern lives at `packages/api/src/mcps-catalog.ts` — mirror its shape for `skills-catalog.ts`.

## Phase A — Foundation (sidebar + xterm scaffolding)

Lands first; every later phase mounts into this shell.

**A1.** Install shadcn primitives — run from repo root:  
```
bunx shadcn@latest add sidebar dialog select tabs textarea separator tooltip table sheet
```  
Files land in `packages/ui/src/components/` and are exported via existing `@sentry-fixer-bot/ui/components/<name>` alias.

**A2.** Install xterm in `apps/web`:  
```
cd apps/web && bun add @xterm/xterm @xterm/addon-fit @xterm/addon-web-links
```  
Add `@import "@xterm/xterm/css/xterm.css";` to `apps/web/src/index.css`.

**A3.** Create `apps/web/src/components/app-sidebar.tsx` — uses `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarMenu`, `SidebarMenuItem`, `SidebarMenuButton`, `SidebarFooter`. Nav items (lucide icons): Home (`Home`), Dashboard (`LayoutDashboard`), Repos (`Database`), MCPs (`Plug`), Skills (`Sparkles`), Runs (`History`), Chat (`MessageSquareCode`). Footer hosts existing `ModeToggle` + `UserMenu`. Use TanStack `<Link to=… />` inside `SidebarMenuButton` for active-state composition.

**A4.** Swap `apps/web/src/routes/__root.tsx` layout: wrap `<Outlet />` in `<SidebarProvider><AppSidebar/><SidebarInset>…</SidebarInset></SidebarProvider>`. Add a thin topbar containing `<SidebarTrigger/>` for mobile/collapsed state. Remove `<Header/>` import (delete the component file in Phase F).

**A5.** Create `apps/web/src/components/xterm-panel.tsx` — `forwardRef` exposing `{ write(s), clear(), fit() }`. Mounts `Terminal` (+ `FitAddon` + `WebLinksAddon`) inside `useEffect` so xterm only runs in browser. Props: `className`, optional `onInput?(data:string):void` (used by Chat), `initialBanner?:string`. Theme matches dark variables.

**Verify A:** `bun dev` boots; every existing route renders inside the sidebar shell; sidebar collapse works; `bun run check-types` + `bun test` green.

## Phase B — E4 Repo CRUD (spec §4)

**B1.** Add to `packages/api/src/routers/repos.ts`:
```ts
byId: protectedProcedure
  .input(z.object({ id: z.string().uuid() }))
  .query(async ({ input }) => {
    const db = createDb();
    const rows = await db.select().from(reposConfig)
      .where(eq(reposConfig.id, input.id)).limit(1);
    return rows[0] ?? null;
  }),
```

**B2.** Create `apps/web/src/components/repo-form.tsx` — TanStack `useForm` + Zod (copy pattern from `sign-in-form.tsx`). Fields per spec §4 table. UI/backend transforms: `prReviewers` comma-split on submit; `dailyCostCapCents` shown as dollars × 100 on submit; `minSeverityToFix` uses shadcn `Select`. Props: `mode: "create" | "edit"`, `initial?`, `onSuccess()`.

**B3.** Create `apps/web/src/components/confirm-dialog.tsx` — shadcn `Dialog` wrapper. Props: `title`, `description`, `confirmLabel`, `variant: "destructive"`, `onConfirm():Promise<void>`. Reused by all 4 destructive flows in this plan.

**B4.** Modify `apps/web/src/routes/repos.tsx`: replace `<table>` with shadcn `Table`. Add "Add repo" button → `Dialog` with `<RepoForm mode="create" />`. Add pencil + trash actions per row.

**B5.** Create `apps/web/src/routes/repos.$id.tsx` — TanStack file route. `beforeLoad` redirects to `/login` if no session (pattern from `dashboard.tsx`). Loader: `queryClient.ensureQueryData(trpc.repos.byId.queryOptions({id: params.id}))`. Renders `<RepoForm mode="edit" initial={data} onSuccess={() => navigate({to:'/repos'})} />`.

**Verify B:** Add via modal, edit via row → `/repos/$id`, delete via confirm. All 87 tests still pass (only additive backend change is `repos.byId`).

## Phase C — E7 MCP install UI (spec §5)

**C1.** Create `apps/web/src/routes/mcps.tsx` — shadcn `Tabs` with `Catalog` + `Installed`.  
- Catalog: `trpc.mcps.catalog` → `Card` grid (name, description, tag chips, homepage link icon, Install button → opens `<McpInstallDialog>`).  
- Installed: `trpc.mcps.installed` → shadcn `Table`: name | scope | repo | catalog_id | uninstall → `ConfirmDialog` → `trpc.mcps.uninstall`.

**C2.** Create `apps/web/src/components/mcp-install-dialog.tsx` — shadcn `Dialog` + TanStack form.  
- `scope`: `Select` global/repo. If repo, secondary `Select` from `trpc.repos.list` showing `sentryProject`.
- For each key in `entry.envSchema`: render `<Input type={spec.secret ? "password" : "text"} />` with description text; asterisk if `required`.  
- Below form: `<XtermPanel ref={termRef} />`. On submit, write synthetic lines (`Writing secrets…`, `Updating /etc/sfb/env…`, `Reloading systemd…`) before/around `trpc.mcps.install.useMutation()`. On success → `✓ Installed` → close after 2s + refetch. On error → red `✗ Failed: …` + `toast.error`.

**Verify C:** Install GitHub catalog entry → password input + commit → install log streams → installed list refetches. Uninstall round-trips. Scope switch hides repo picker correctly.

## Phase D — E8 + E9 Skills (spec §7)

**D1.** Create catalog data:
- `packages/api/src/skills-catalog.ts` — exports `SKILLS_CATALOG: SkillEntry[]` with 2 entries: `sentry-triage`, `pr-reviewer` (spec §7).
- `packages/api/src/skills-catalog/sentry-triage/SKILL.md` + `…/pr-reviewer/SKILL.md` — placeholder skill files (frontmatter + 1 paragraph each).

**D2.** Create `packages/api/src/routers/skills.ts` with methods (spec §7):
- `catalog` (protected) → `SKILLS_CATALOG`
- `list` (protected) → DB select from `skillInstalls`
- `installBuiltin` (admin) → `cp -r` from `packages/api/src/skills-catalog/<id>/` to `${SFB_SKILLS_DIR ?? "/var/lib/sfb/skills"}/<install_id>/` via `fs/promises.cp`; insert `skillInstalls` row
- `installCustom` (admin) — accepts `{ filename, base64Zip, name, scope, repo? }`; validate ≤5MB; extract with `adm-zip`; reject any entry whose resolved path escapes target dir, and any symlinks
- `installFromSh` (admin) — `fetch('https://www.skills.sh/api/skills/<slug>')`; on 4xx/5xx/network fail return `{error:'skills_sh_api_unavailable'}`; on success save like custom
- `shList` (protected, `{q?}`) — `fetch('https://www.skills.sh/api/list')`, in-memory 24h cache; same error shape on fail
- `uninstall` (admin) — DB delete + `fs/promises.rm(storage_path, { recursive: true, force: true })`

Mount in `packages/api/src/index.ts` (or wherever `appRouter` is composed — verify exact file). Install dep: `cd packages/api && bun add adm-zip && bun add -d @types/adm-zip`.

**D3.** Create `packages/api/tests/skills.test.ts` — 3 tests minimum:
1. `catalog` returns array containing `sentry-triage`
2. `installBuiltin` creates DB row + writes files (use tmp `SFB_SKILLS_DIR`)
3. `uninstall` removes row + rm-rf storage dir

**D4.** Create `apps/web/src/routes/skills.tsx` — shadcn `Tabs` (Built-in | Custom | skills.sh):
- **Built-in**: `Card` grid from `trpc.skills.catalog`; Install → `XtermPanel` synthetic log + `skills.installBuiltin`
- **Custom**: native `<input type="file" accept=".zip" />` → `FileReader.readAsDataURL` → strip prefix → `skills.installCustom`. Show installed customs list below. Reuse XtermPanel for extraction log
- **skills.sh**: debounced `trpc.skills.shList` query → results grid → `skills.installFromSh` per result. If query returns `{error:'skills_sh_api_unavailable'}` render `<a href="https://skills.sh" target="_blank">Browse skills.sh in a new tab →</a>`

**Verify D:** New skills tests pass (90 total). Install built-in → row appears → uninstall → row gone + storage cleaned. skills.sh tab degrades to external link when offline.

## Phase E — F5 Chat UI (spec §6)

**E1.** Create `apps/web/src/components/chat-terminal.tsx` — wraps `XtermPanel`, owns WS lifecycle. Props: `sessionId`, `onOAuthPrompt(url)`, `onExit(code)`. In `useEffect`, open `new WebSocket(`${proto}://${host}/api/chat/${sessionId}`)` (cookie carries over same-origin upgrade). On `message`, JSON-parse and switch:
- `stdout` → `term.write(msg.data)` (raw ANSI passthrough)
- `oauth_url` → `onOAuthPrompt(msg.url)` (parent renders the card)
- `exit` → `onExit(msg.code)` + banner
- `error` → `toast.error(msg.message)`

Input row below terminal: shadcn `Input` + Send button. On Enter → `ws.send(JSON.stringify({type:'user_input', data: text}))` (note `data`, not `text`). Disabled when an OAuth prompt is pending.

**E2.** Create `apps/web/src/components/oauth-card.tsx` — shadcn `Card`. Props: `url`, `onSubmit(code)`, `onCancel()`. Body: "Claude needs you to authenticate", `<a href={url} target="_blank">Open URL</a>`, paste-code `Input`, Submit/Cancel buttons.

**E3.** Create `apps/web/src/routes/chat.tsx` — auth `beforeLoad`. Layout: left column `trpc.chat.list` (last 5 sessions, status badges) + "Start new session" button (+ optional repo `Select`). Right column: when `activeId` set, render `<ChatTerminal sessionId={activeId} onOAuthPrompt={setOauth} onExit={…} />`, and conditionally `<OAuthCard url={oauth} onSubmit={code => wsRef.current?.send(JSON.stringify({type:'oauth_response', code}))} />`. "End session" button → `trpc.chat.end`.

Handle `chat.create` rejection with code `concurrent_session` → `ConfirmDialog` "End previous and start new?" → calls `chat.end` for prior session, then retries `chat.create`.

**Verify E:** Start session → Claude prompt streams in (ANSI colors render correctly). Send input → response appears. Manually trigger an OAuth flow (e.g. ask Claude to run a CLI that needs `gh auth login`) → OAuthCard appears, paste code → resumes. `chat.list` shows previous sessions.

## Phase F — CI + docs + cleanup (spec §8)

**F1.** Create `.github/workflows/ci.yml`:
```yaml
name: CI
on:
  pull_request: { branches: [main] }
  push: { branches: [main] }
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

**F2.** Rewrite `README.md` with 6 sections per spec §8: what it does (from `design.md` §1), stack, local dev (`bun install`, docker compose up, db:migrate + db:seed, `bun dev`), first-signup admin walkthrough, ngrok-based webhook testing, deploy link.

**F3.** Create `docs/runbook.md` with 8 sections per spec §8: env file shape, systemd commands, EC2 boot, backup/restore (`scripts/backup-db.sh` + S3 restore), key rotation, `local_trusted → authenticated` board-claim flow, kill switch, common failures (pull from `architecture.md` §9).

**F4.** Cleanup:
- Delete `apps/web/src/components/header.tsx` (superseded by sidebar)
- Remove `@hookform/resolvers` from `apps/web/package.json`

**Verify F:** Push branch + PR → CI green. Clean-checkout walkthrough of README lands at a running app.

## Sequencing summary

A → (B, C, D in parallel since each is self-contained UI work, but recommend B first because RepoForm/ConfirmDialog patterns set the template) → E → F.

Within Phase B: **B1 must precede B5** (router query before edit-page loader). Within D: **D1 → D2 → D3 → D4** (catalog data → router → tests → UI).

Every phase ends with `bun run check-types` + `bun test`. Tag a checkpoint commit after each phase.

## Critical files

- `apps/web/src/routes/__root.tsx` — layout swap (Phase A); everything depends on this
- `apps/web/src/components/app-sidebar.tsx` — shared chrome carrying all nav (Phase A)
- `apps/web/src/components/xterm-panel.tsx` — reusable terminal, consumed by C/D/E (Phase A)
- `apps/web/src/components/repo-form.tsx` + `confirm-dialog.tsx` — patterns reused everywhere (Phase B)
- `packages/api/src/routers/skills.ts` — only new backend code (Phase D)
- `apps/web/src/routes/chat.tsx` + `components/chat-terminal.tsx` — highest complexity (Phase E)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| shadcn add behavior with Base UI | Components.json already targets Base UI; shadcn CLI handles correctly. Verify install output after A1. |
| xterm bundle size | TanStack Router file routes auto-split; `/chat` cost only loads when visited. |
| zip-slip / symlink escape in `installCustom` | Resolve each entry path with `path.resolve(target, entryName)`; reject if not within `target`. Reject `symlinks`. |
| skills.sh API may not exist | Router returns explicit `{error}` shape; UI degrades to external link. |
| WS payload field name drift | Use `data` (codebase truth), not `text` (spec wording). |
| Existing 87 tests | Only `repos.byId` (additive read) + new skills tests change router surface. No regressions expected. |
| `@hookform/resolvers` dep removal could break something I missed | Grep before removing: `grep -r '@hookform/resolvers' apps/ packages/` — only remove if zero hits. |

## End-to-end verification (after all phases)

1. `bun install && bun run check-types && bun test` — all green, ≥90 tests
2. `bun dev` — every nav link in sidebar renders its page without console errors
3. Add a repo via modal → edit it → delete it → list reflects each change
4. Install the GitHub MCP from catalog with a fake token → installed list shows it → uninstall removes it
5. Install built-in skill `sentry-triage` → row in list → check `/var/lib/sfb/skills/<id>/SKILL.md` exists → uninstall → both gone
6. Open `/chat` → start session → send `hi` → response streams with colors
7. Push a branch with these changes → CI workflow runs `check-types` + `bun test` → green
