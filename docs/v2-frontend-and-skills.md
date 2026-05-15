# v2 — Frontend, Auth, MCP & Skill Management, Chat

**Date:** 2026-05-15
**Companion to:** [`design.md`](design.md), [`architecture.md`](architecture.md), [`planning.md`](planning.md)
**Plan:** [`plans/2026-05-15-v2-frontend-mcp-skills.md`](plans/2026-05-15-v2-frontend-mcp-skills.md)

This document expands the MVP from a **headless bot** into a **full operator product** with:

- React frontend served from the same EC2
- **WorkOS** authentication (admin + invited members, single-tenant)
- MCP server install + per-repo configuration UI
- Skill install UI: built-in catalog + custom upload + **skills.sh** integration
- Secret management UI (paste once, persisted to `/etc/sfb/env`)
- **Chat interface** that spawns a Claude Code subprocess and forwards interactive prompts (OAuth URLs, login flows) back to the user

Backend invariants from V1 are unchanged: HMAC-verified webhook, pg-boss queue, dedup, triage → agent → PR.

---

## 1. Why this is one release, not two

The V1 MVP plan (Tasks 0–48 in `plans/2026-05-15-mvp-webhook-to-pr.md`) ships the backend. Without the UI layer:

- Repos are managed via a hand-edited `repos.yaml`.
- MCPs and skills are not configurable; the bot spawns a vanilla `claude` with no MCP servers and no custom skills.
- Secrets live in `.env` only.
- There is no record of "who configured what".

V2 reframes the bot as a self-service tool: an operator visits a URL, signs in with WorkOS, installs MCPs and skills from a catalog, registers repos, watches runs, and chats with the bot when it needs interactive OAuth (e.g. `gh auth login` analogues for new MCP servers).

V1 and V2 are bundled because the V1 install story (hand-edited YAML, manual systemd) is unacceptable to the operators who will actually run this.

## 2. New scope (everything below is V2 only)

### 2.1 Frontend

Single-page app served from the same EC2 (same nginx host).

- **Stack**: React 18 + Vite 5 + TypeScript + Tailwind 4 + Tanstack Router + Tanstack Query
- **Build output**: `/opt/sfb/current/ui/dist/` served by nginx at `/`
- **API base**: `/api/*` proxied to Hono on `127.0.0.1:3000`
- **Auth**: WorkOS AuthKit-hosted login → session cookie
- **Real-time**: Server-sent events (SSE) for run status + chat streaming

### 2.2 Pages

| Path | Purpose |
| --- | --- |
| `/login` | WorkOS-hosted login redirect target |
| `/` (dashboard) | Recent runs, daily cost, active PRs, alert volume |
| `/repos` | List + add + edit + remove repos (replaces `repos.yaml`) |
| `/repos/:repo` | Per-repo settings: test command, reviewers, caps, per-repo MCPs and skills |
| `/mcps` | Two tabs: **Catalog** (browse + install) and **Installed** (configure + remove) |
| `/skills` | Three tabs: **Built-in** (ship with the bot), **Custom** (uploaded), **skills.sh** (community browser) |
| `/runs` | Run history with filter (repo, status, severity, date) |
| `/runs/:id` | Single run drill-down: triage, prompt, transcript, PR link, cost |
| `/prs` | Open + merged + closed bot PRs |
| `/chat` | Interactive chat with a Claude Code session; surfaces OAuth URLs |
| `/settings` | Anthropic key, GitHub App config, member invites, daily caps, kill switch |
| `/audit` | Append-only log of mutating actions, filterable by user + action |

### 2.3 Authentication — WorkOS

- **Provider**: WorkOS AuthKit (hosted login UI, OAuth, magic-link, SSO when available)
- **Free tier**: 1M MAU — easily covers single-tenant deployment
- **Flow**:
  1. User hits `/` → server checks session cookie → no session → redirect to `/login`
  2. `/login` → server-side redirect to WorkOS-hosted login
  3. WorkOS callback → `/api/auth/callback` exchanges code for user profile
  4. Server: first user gets `role='admin'`; subsequent users must match an `invites` row keyed by email
  5. Issue opaque session token → httpOnly cookie → redirect `/`
- **Roles**: `admin` (everything) / `member` (read-only by default; configurable per-feature)
- **Invites**: admin adds an email → on next login attempt for that email, the invite is consumed and a `users` row is created

### 2.4 Repo management (replaces `repos.yaml`)

Move `repos.yaml` into Postgres. Backwards-compat: keep a "sync from yaml" import button for migration.

DB:

```sql
CREATE TABLE repos_config (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sentry_project        TEXT NOT NULL UNIQUE,
  github                TEXT NOT NULL,
  default_branch        TEXT NOT NULL,
  test_command          TEXT NOT NULL,
  pr_reviewers          JSONB NOT NULL DEFAULT '[]'::jsonb,
  daily_token_cap       INT NOT NULL,
  daily_cost_cap_cents  INT NOT NULL,
  min_severity_to_fix   TEXT NOT NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            UUID REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`src/config/repos.ts` becomes a thin wrapper that reads from this table instead of YAML.

### 2.5 MCP install + management

#### Catalog

Maintained in `src/mcps-catalog/index.ts` (curated). One entry per supported MCP server:

```ts
{
  id: "sentry",
  name: "Sentry",
  description: "Read Sentry issues, fetch event details",
  transport: "stdio",
  command: "npx",
  argsTemplate: ["-y", "@sentry/mcp-server"],
  envSchema: {
    SENTRY_TOKEN: { required: true, secret: true, description: "Internal integration token" },
    SENTRY_ORG_SLUG: { required: true, secret: false, description: "e.g. acme-corp" },
  },
  tags: ["observability"],
  homepage: "https://github.com/sentry/mcp-server-sentry",
}
```

#### Install schema

```sql
CREATE TABLE mcp_installs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL,                       -- 'global' | 'repo'
  repo          TEXT,                                -- nullable; FK by name
  catalog_id    TEXT NOT NULL,                       -- references catalog entry
  display_name  TEXT NOT NULL,
  transport     TEXT NOT NULL,
  command       TEXT,
  args          JSONB NOT NULL DEFAULT '[]'::jsonb,
  env_keys      JSONB NOT NULL DEFAULT '[]'::jsonb,  -- list of env keys this MCP reads; values live in /etc/sfb/env
  url           TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  installed_by  UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, repo, catalog_id)
);

CREATE TABLE mcp_secrets (
  env_key       TEXT PRIMARY KEY,                    -- e.g. SFB_MCP_SENTRY_TOKEN
  description   TEXT,
  scope_hint    TEXT,                                -- 'global' | 'repo:<repo>'
  set_by        UUID REFERENCES users(id),
  set_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Secret **values** never live in Postgres. Values are written to `/etc/sfb/env` (mode 0600, owned by `sfb-runner`) when the admin saves them in the UI. The DB row tracks *that* a secret exists, who set it, and what env key it corresponds to — for audit and UI rendering ("✓ configured").

#### Install flow (catalog → installed)

1. User opens `/mcps/catalog` and clicks "Install" on a card
2. UI shows a form built from `envSchema`: one input per required env var, masked for secrets
3. On submit, server:
   - Inserts `mcp_installs` row
   - For each secret env var, calls `setEnvSecret(envKey, value)` which:
     - Atomically rewrites `/etc/sfb/env` adding/updating the line
     - Issues `systemctl reload sfb-web sfb-worker` (or sends SIGHUP) so the running processes pick up the new value on next spawn
     - Inserts/updates `mcp_secrets` row for audit
4. UI shows the MCP in `/mcps/installed` with status "configured"

#### Per-run rendering

When the agent job spawns Claude (Task 34 in V1 plan), pre-render `~/.claude/mcp_servers.json` into the run's `claude-home/`:

```ts
async function renderMcpConfig(repo: string, claudeHome: string): Promise<string> {
  const global = await db().query(
    `SELECT * FROM mcp_installs WHERE scope='global' AND enabled=true`,
  );
  const perRepo = await db().query(
    `SELECT * FROM mcp_installs WHERE scope='repo' AND repo=$1 AND enabled=true`,
    [repo],
  );
  const merged = [...global.rows, ...perRepo.rows];
  const mcpServers = Object.fromEntries(
    merged.map((m) => [
      m.catalog_id,
      m.transport === "stdio"
        ? {
            command: m.command,
            args: m.args,
            env: Object.fromEntries(
              (m.env_keys as string[]).map((k) => [k, process.env[k] ?? ""]),
            ),
          }
        : { url: m.url },
    ]),
  );
  const file = join(claudeHome, ".claude", "mcp_servers.json");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });
  return file;
}
```

Claude spawn then becomes:

```bash
HOME=<runDir>/claude-home claude --print \
  --dangerously-skip-permissions \
  --mcp-config <runDir>/claude-home/.claude/mcp_servers.json \
  --model claude-opus-4-7 \
  --append-system-prompt "..."
```

### 2.6 Skill install + management

Three sources:

| Source | UI | Storage | Notes |
| --- | --- | --- | --- |
| **Built-in catalog** | `/skills/built-in` tab | Ship in `src/skills-catalog/<name>/SKILL.md` (+ scripts) | One-click install, version-pinned with the bot |
| **Custom upload** | `/skills/custom` tab | Zip uploaded to `/var/lib/sfb/skills/{id}/`; admin can replace | Admin pastes zip or git URL |
| **skills.sh** | `/skills/sh` tab | Pulled from https://www.skills.sh on demand; cached to `/var/lib/sfb/skills/sh-cache/` | Browse, search, install — read-only catalog |

#### Schema

```sql
CREATE TABLE skill_installs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL,                       -- 'global' | 'repo'
  repo          TEXT,
  source_type   TEXT NOT NULL,                       -- 'builtin' | 'upload' | 'skills_sh' | 'git'
  source_ref    TEXT NOT NULL,                       -- builtin name / s3 key / sh slug / git url@ref
  name          TEXT NOT NULL,
  description   TEXT,
  storage_path  TEXT NOT NULL,                       -- /var/lib/sfb/skills/<id>/
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  installed_by  UUID REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, repo, name)
);
```

#### Per-run rendering

```ts
async function renderSkills(repo: string, claudeHome: string): Promise<void> {
  const skills = await db().query(`
    SELECT * FROM skill_installs
     WHERE enabled=true AND (scope='global' OR (scope='repo' AND repo=$1))
  `, [repo]);
  const skillsDir = join(claudeHome, ".claude", "skills");
  await mkdir(skillsDir, { recursive: true });
  for (const s of skills.rows) {
    // Symlink so updates to the source propagate instantly.
    await symlink(s.storage_path, join(skillsDir, s.name));
  }
}
```

#### skills.sh integration

`https://www.skills.sh/` hosts a community catalog. Integration:

- **Browse**: `/api/skills/sh/list?q=<query>` proxies a search against skills.sh
- **Detail**: `/api/skills/sh/get/:slug` fetches a single skill's metadata + README
- **Install**: `/api/skills/sh/install/:slug` downloads the skill archive, extracts to `/var/lib/sfb/skills/{id}/`, writes a `skill_installs` row with `source_type='skills_sh'`
- **Cache**: 24h TTL on listings; admin can force-refresh

Open question to confirm with operator: is there a public skills.sh API or does the bot need to scrape HTML? Plan assumes API; falls back to a manual upload flow if API is unavailable.

### 2.7 Secret management (env file approach)

Pattern: secrets go to `/etc/sfb/env`. systemd `EnvironmentFile=` directive loads them into the process env at start. UI writes to the file via a setuid helper or via direct `sfb-config` user.

#### Files involved

- `/etc/sfb/env` (mode 0600, owner `sfb-runner`, group `sfb-config`) — single env file consumed by systemd
- `/etc/sfb/env.d/managed.env` (optional split) — UI-managed secrets only; main env file imports from this

#### Atomic update

```ts
async function setEnvSecret(envKey: string, value: string): Promise<void> {
  const file = "/etc/sfb/env";
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  // Read current
  const existing = await readFile(file, "utf8");
  const lines = existing.split("\n").filter((l) => !l.startsWith(`${envKey}=`));
  lines.push(`${envKey}=${shellQuote(value)}`);
  // Write tmp
  await writeFile(tmp, lines.join("\n"), { mode: 0o600 });
  // Atomic rename
  await rename(tmp, file);
  // Reload services
  await execa("systemctl", ["reload-or-restart", "sfb-web.service", "sfb-worker.service"]);
}
```

`shellQuote` properly escapes values (handles spaces, newlines, special chars).

#### Why env file, not Secrets Manager for V2

The V1 plan kept secrets in AWS Secrets Manager. V2 makes them user-editable through the UI. Env file is simpler to render + reload. Trade-off: secrets at rest on EC2 disk. Mitigations: EBS volume encryption (KMS), mode 0600 on the file, owner is the low-priv `sfb-runner`. For high-security deployments, swap the backing store from "env file on disk" to "Secrets Manager + lookup in setEnvSecret" — interface unchanged.

#### Persistence across container reboot

If Postgres is in docker-compose (decided earlier), `/etc/sfb/env` lives on the host (mounted from EC2 EBS). Container restart does not touch it. systemd reload re-reads the file. The env file is the source of truth; the UI writes to it; the DB stores only the *fact* of which keys are configured + audit metadata.

### 2.8 Chat interface (interactive Claude with OAuth-URL capture)

This is the most ambitious V2 feature. It lets admins run interactive Claude sessions through the browser, with the bot acting as a proxy that captures any "open this URL" prompt and forwards it to the human.

#### Use cases

1. Install a new MCP that needs OAuth: the MCP server prints a URL on first run; user opens it, completes flow, pastes the token back.
2. Debug a failing agent run by chatting with Claude using the same repo + MCPs.
3. One-off tasks that don't fit the Sentry-driven loop (e.g. "open a PR that bumps Node to 22 across all configured repos").

#### Architecture

```
                                User browser
                                     │
                                     │ WebSocket /api/chat/:session_id
                                     ▼
                         ┌──────────────────────┐
                         │  Hono ChatSession    │
                         │  (per active chat)   │
                         └──────────────────────┘
                                     │ stdin/stdout
                                     ▼
                         ┌──────────────────────┐
                         │  claude subprocess   │
                         │  (PTY, not pipes)    │
                         └──────────────────────┘
                                     │
                                  spawns
                                     ▼
                         ┌──────────────────────┐
                         │  MCP servers spawned │
                         │  by claude as needed │
                         └──────────────────────┘
```

Spawned with `node-pty` instead of `execa` so Claude believes it has a real terminal (some interactive flows refuse to render to a pipe).

#### URL capture

A small parser watches Claude's stdout for OAuth-style prompts:

```ts
const URL_PATTERN = /https?:\/\/[^\s]+/g;
const OAUTH_HINTS = [
  /open the following URL/i,
  /visit this URL/i,
  /authentication code/i,
  /paste.*code/i,
];

function detectOAuthPrompt(buffer: string): { url: string } | null {
  if (!OAUTH_HINTS.some((re) => re.test(buffer))) return null;
  const m = buffer.match(URL_PATTERN);
  return m ? { url: m[0] } : null;
}
```

When detected:

1. Stream pauses (we hold the chat output)
2. Frontend WebSocket message: `{ type: 'oauth_url', url, sessionId }`
3. UI renders a card: "Claude wants you to open: [link]. Paste the returned code below."
4. User clicks the link in their own browser, completes the flow, copies the returned token/code, pastes into the UI input
5. UI sends `{ type: 'oauth_response', code }` → backend writes `code\n` to Claude's stdin
6. Stream resumes; Claude proceeds with the dance

This is generic enough to handle `gh auth login`, `claude /login`, MCP servers using OAuth Device Code flow, etc.

#### Chat session schema

```sql
CREATE TABLE chat_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  repo          TEXT,                              -- nullable; chat may not target a repo
  status        TEXT NOT NULL,                     -- 'active' | 'ended' | 'killed'
  pid           INT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ
);

CREATE TABLE chat_messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,                     -- 'user' | 'assistant' | 'system' | 'oauth_prompt' | 'oauth_response'
  content       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_session_idx ON chat_messages (session_id, created_at);
```

#### Safety

- **Single concurrent session per user** (kill old session if new chat opens)
- **Max 30 min idle** then killed
- **Same `--dangerously-skip-permissions`** as agent runs — chat is full-power within the run dir
- **Logged + audited** like any other run
- **Cost-capped** via the same daily budget (chats charge to a synthetic repo `__chat__` or to the chat's chosen repo)
- **No write access to host secrets** — chat session runs as `sfb-runner` with same isolation as agent runs

#### Why this matters

The interactive flow is the bot's escape hatch. When the operator hits something the automated webhook→PR loop can't handle (e.g. authenticating a new MCP, exploring a one-off issue, debugging a failing agent prompt), chat covers it without dropping back to SSH. Skipping it means V2 is "manage settings only" — still useful but not the "platform" the user described.

## 3. New tech stack additions

Runtime is **Bun 1.x** (same as V1). All additions below either ship with Bun or are Bun-compatible.

| What | Why |
| --- | --- |
| **WorkOS AuthKit + `@workos-inc/node` SDK** | Auth as a service; free tier covers single-tenant; SSO ready when needed |
| **React 18 + Vite 5 + Tailwind 4** | Standard SPA stack; Vite-on-Bun works natively |
| **Tanstack Router + Tanstack Query** | Type-safe routing, server-state with revalidation |
| **Bun PTY (`Bun.spawn` + `pty: true`)** | Spawn Claude with a PTY for chat. Bun's PTY support is preferred over `node-pty` (Bun has limited compat with `node-pty` native bindings; native `Bun.spawn` with `pty: true` is the supported path). If a feature is missing at build time, fall back to spawning Claude under a `script(1)` PTY wrapper. |
| **Bun multipart parsing** | Built-in `request.formData()` parses multipart uploads; no `multer` needed |
| **adm-zip** (npm package) | Extract uploaded skill zips; works under Bun |
| **simple-git** (or `Bun.$` shell calls to `git`) | Clone skills from git URLs |
| **WebSocket via `hono/bun`** | Chat streaming + run status push. Hono's Bun adapter ships WebSocket out of the box. |

## 4. Updated topology (replaces architecture.md §1)

```
                      Sentry
                        │ POST /webhooks/sentry
                        ▼
       ┌─────────────────────────────────────────┐
       │ nginx (TLS, sfb.example.com)            │
       │   /  → /opt/sfb/current/ui/dist/        │
       │   /webhooks/sentry → 127.0.0.1:3000     │
       │   /api/* → 127.0.0.1:3000               │
       │   /api/chat/* (WS) → 127.0.0.1:3000     │
       │   /healthz → 127.0.0.1:3000             │
       └────────────────┬────────────────────────┘
                        ▼
     ┌────────────────────────────────────────────┐
     │ Hono API on EC2                            │
     │  • Static + SPA fallback                   │
     │  • Auth (WorkOS callback, sessions)        │
     │  • CRUD: repos, mcps, skills, invites      │
     │  • Skill upload + skills.sh proxy          │
     │  • Chat WebSocket (PTY-backed claude proc) │
     │  • Webhook receiver (unchanged from V1)    │
     │  • Secret writer → /etc/sfb/env (reload)   │
     └────────────────┬────────────────────────────┘
                      │
        ┌─────────────┼─────────────────────────────┐
        ▼             ▼                             ▼
   ┌─────────┐  ┌─────────────────┐         ┌──────────────────┐
   │ Postgres│  │ /etc/sfb/env    │         │ /var/lib/sfb/    │
   │ (docker)│  │ (env file)      │         │   work/{run_id}/ │
   │         │  │ ↑ reloaded on   │         │   skills/{id}/   │
   │ users   │  │ secret update   │         │   sh-cache/      │
   │ sessions│  └─────────────────┘         │   chat/{sess}/   │
   │ invites │                              └──────────────────┘
   │ repos_  │
   │  config │
   │ mcp_    │
   │  installs
   │ skill_  │
   │  installs
   │ chat_   │
   │  sessions
   │ runs+prs│
   └─────────┘
```

## 5. Why these choices

| Choice | Reason | What we considered |
| --- | --- | --- |
| **WorkOS over Clerk** | 1M MAU free tier; Clerk paid sooner | Clerk has slightly nicer SDK; price wins for a tool that may sit idle |
| **Env file over Secrets Manager (UI-managed secrets)** | Trivially editable from UI; user-stated requirement | Secrets Manager + KMS still preferred for ops-managed (bot's own creds); env file used only for UI-pasted MCP secrets |
| **PTY for chat** | Some interactive CLIs refuse to render to a pipe | `execa` pipes work for most agent runs; chat is the exception |
| **skills.sh proxy** | One-button install reduces friction | We could scrape; will try API first |
| **WebSocket over SSE for chat** | Bidirectional needed (user input mid-stream) | SSE is one-way; chat needs both |
| **No multi-tenant in V2** | YAGNI for now | Multi-tenant adds tenant tables, billing, isolation; not needed for single-org install |

## 6. Updated security model

Additions on top of V1 §7:

| Concern | V2 mitigation |
| --- | --- |
| **Cross-user secret leak in UI** | All secret read endpoints redact values; UI shows ✓ / ✗ presence, never the secret itself |
| **Env file leaked to a runaway agent** | Agent runs as `sfb-runner` (uid 4000) with no read access to `/etc/sfb/env` (owned by `sfb-runner` but read via systemd EnvironmentFile, then exec'd — the file itself is mode 0600 root-readable, processes inherit the env. Actually re-check: file must be readable by systemd to load. Set mode 0640 owner root group sfb-runner so sfb-runner can read it at exec time but agent code inside the run can't escalate to the file via fs reads after exec). Net effect: agent processes get env vars but cannot exfiltrate the on-disk file. |
| **Chat session escapes its sandbox** | Same isolation as agent runs: per-session work dir under `/var/lib/sfb/chat/{session_id}/`, deleted on session end |
| **Upload bombs** | Zip extraction bounded: max 50 files, max 5 MB total uncompressed, no symlinks pointing outside the extraction dir |
| **WorkOS misconfiguration leaks the org** | First-user auto-admin only on a fresh install; subsequent installs require explicit `SFB_BOOTSTRAP_ADMIN_EMAIL` env var to pre-seed an admin to prevent stranger from claiming admin |

## 7. What is NOT in V2 even now

To keep V2 finite:

- **Slack notifications** — operator gets them in V3
- **Cron PR-state polling, stale-PR close** — V3
- **Multi-LLM fallback (OpenAI/Gemini)** — V3
- **GitLab adapter** — V3
- **Multi-tenant SaaS** — V4+
- **Mobile-optimised UI** — basic responsive, but no native app
- **Prompt A/B harness** — V3
- **Skill authoring UI** — V3 (only install in V2; authoring is editing files on EC2 or uploading)

## 8. Updated timeline

| Phase | Calendar | Eng-days |
| --- | --- | --- |
| V1 backend (Tasks 0–48 + 44b + 44c) | 6 weeks | 22–28 |
| V2 frontend scaffold + WorkOS auth | 1 week | 5 |
| V2 repos / MCPs / skills CRUD + UI | 2 weeks | 10 |
| V2 secret env file flow | 0.5 week | 3 |
| V2 chat interface (PTY + WS + OAuth URL capture) | 2 weeks | 10 |
| V2 skills.sh integration + custom upload | 1 week | 5 |
| V2 per-run rendering integration with V1 agent path | 0.5 week | 3 |
| V2 manual verify + polish | 1 week | 5 |
| **Total** | **~14 calendar weeks** | **63–73 eng-days** |

With buffer for unknowns: **~18 weeks** single-engineer to a polished V2.

Two engineers in parallel after V1 lands: **~10 weeks**.

## 9. Open questions to lock in before V2 plan execution

1. **WorkOS account**: who creates it, who holds the org-admin login? Default: ops creates an org-account, paste WORKOS_API_KEY + WORKOS_CLIENT_ID into Secrets Manager at deploy.
2. **skills.sh API**: confirm the site exposes a JSON API. If only HTML, the integration becomes "browse-only" with an "Add this URL as a custom skill" button instead.
3. **Chat history retention**: keep transcripts forever, or auto-purge after 30 days? Default: 30 days, exportable to S3.
4. **MCP catalog source of truth**: hand-maintained in `src/mcps-catalog/`, OR pulled from a remote registry (Anthropic's official MCP marketplace when it exists)? Default: hand-maintained for V2, with an `import` button that takes a `mcp.json` URL.
5. **Chat as the only "ask Claude" surface, or also runnable headless from the API?** Default: chat-only in V2. Programmatic Claude access is V3.
