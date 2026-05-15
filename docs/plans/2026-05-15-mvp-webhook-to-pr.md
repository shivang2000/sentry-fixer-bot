# sentry-fixer-bot — MVP Implementation Plan (Webhook → PR)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployable EC2 service that completes the entire loop without any skips: receive Sentry webhook → verify HMAC → deduplicate → archive payload → triage with Claude Haiku → comment on Sentry issue → clone the target GitHub repo → spawn Claude Code in a per-run worktree → let the agent inspect and fix → run the repo's test command → commit, push, and open a pull request (draft if tests fail) → record cost and audit.

**Architecture:** **Bun 1.x** + TypeScript service running two processes (web, worker) under systemd. Postgres for state and queue (pg-boss). Hono as the HTTP framework. Claude Code CLI spawned headless per run with `--dangerously-skip-permissions`. GitHub App used for authentication. PRs opened via the `gh` CLI. Strict-mode TypeScript, zod-validated env, pino logging. TDD with `bun:test`; integration tests run against a real Postgres provided by docker-compose; agent end-to-end test exercises a tiny fixture repo on disk with stub `claude` and `gh` binaries.

**Tech Stack:** **Bun 1.x** (runtime + package manager + test runner + TS executor), TypeScript 5.7, Hono 4, pg 8, pg-boss 9, zod 3, pino 9, `@anthropic-ai/sdk` 0.30, `@aws-sdk/client-s3` 3, `@octokit/auth-app` 7, `js-yaml` 4, `nock` 13. Local toolchain on EC2: `bun`, `git`, `gh` (GitHub CLI), `claude` (Claude Code CLI), `openssl`. No `node`/`pnpm`/`tsx`/`vitest` installed — Bun replaces all four.

**What is in scope for MVP:** every step from webhook to merged-able pull request, including budget enforcement that hard-stops when a daily cap is hit.

**What is intentionally out of scope for MVP (will be added immediately after MVP in a follow-up plan):** Slack notifications, the cron process that polls PR state and closes stale PRs, the admin dashboard, the prompt-A/B harness, multi-LLM fallback, GitLab support, multi-tenant isolation. These do not block end-to-end operation; an engineer can still see every PR by visiting GitHub.

---

## File map

Every file this plan creates, in dependency order. Each has one responsibility.

```
sentry-fixer-bot/
├── package.json                       Task 1
├── tsconfig.json                      Task 2
├── .eslintrc.cjs                      Task 3
├── .prettierrc                        Task 3
├── bunfig.toml                        Task 4
├── docker-compose.yml                 Task 5
├── .env.example                       Task 6
├── .gitignore                         Task 1
├── repos.yaml.example                 Task 7
├── src/
│   ├── env.ts                         Task 8
│   ├── log.ts                         Task 9
│   ├── db/
│   │   ├── client.ts                  Task 10
│   │   ├── schema.sql                 Task 11
│   │   └── migrate.ts                 Task 12
│   ├── config/
│   │   └── repos.ts                   Task 14
│   ├── web/
│   │   ├── server.ts                  Task 16
│   │   ├── routes/
│   │   │   ├── health.ts              Task 17
│   │   │   └── sentry-webhook.ts      Task 23
│   │   └── verify-hmac.ts             Task 18
│   ├── alerts/
│   │   ├── dedup-key.ts               Task 20
│   │   └── persist.ts                 Task 21
│   ├── archive/
│   │   └── s3.ts                      Task 22
│   ├── queue/
│   │   ├── boss.ts                    Task 24
│   │   └── jobs.ts                    Task 25
│   ├── sentry/
│   │   ├── client.ts                  Task 26
│   │   └── comment.ts                 Task 28
│   ├── triage/
│   │   └── classify.ts                Task 27
│   ├── runs/
│   │   └── persist.ts                 Task 29
│   ├── budget/
│   │   └── enforce.ts                 Task 30
│   ├── github/
│   │   ├── app-auth.ts                Task 31
│   │   └── pr.ts                      Task 38
│   ├── agent/
│   │   ├── workspace.ts               Task 32
│   │   ├── prompt.ts                  Task 33
│   │   ├── spawn.ts                   Task 34
│   │   ├── parse-output.ts            Task 35
│   │   └── secret-scan.ts             Task 36
│   ├── gate/
│   │   └── run-tests.ts               Task 37
│   ├── worker/
│   │   ├── triage-job.ts              Task 41
│   │   ├── agent-job.ts               Task 39
│   │   └── index.ts                   Task 40
│   └── index.ts                       Task 42
├── deploy/
│   ├── systemd/
│   │   ├── sfb-web.service            Task 43
│   │   └── sfb-worker.service         Task 43
│   └── nginx/sfb.conf                 Task 44
├── scripts/
│   ├── dev-up.sh                      Task 5
│   └── seed-fake-alert.sh             Task 45
└── tests/
    ├── helpers/
    │   ├── setup.ts                   Task 4
    │   ├── db.ts                      Task 13
    │   └── fixtures.ts                Task 19
    ├── unit/
    │   ├── env.test.ts                Task 8
    │   ├── verify-hmac.test.ts        Task 18
    │   ├── dedup-key.test.ts          Task 20
    │   ├── sentry-client.test.ts      Task 26
    │   ├── sentry-comment.test.ts     Task 28
    │   ├── classify.test.ts           Task 27
    │   ├── repos-config.test.ts       Task 14
    │   ├── prompt.test.ts             Task 33
    │   ├── parse-output.test.ts       Task 35
    │   ├── secret-scan.test.ts        Task 36
    │   └── budget.test.ts             Task 30
    └── integration/
        ├── health.test.ts             Task 17
        ├── alert-persist.test.ts      Task 21
        ├── webhook.test.ts            Task 23
        ├── triage-job.test.ts         Task 41
        └── agent-job.test.ts          Task 46
```

---

## Task 0: Local toolchain prerequisites

Before writing any code, every developer working on this repo (and the EC2 build user) needs the following binaries on `PATH`. This is a one-time setup step; it does not produce a commit. The next task scaffolds the Node project on top of these.

### macOS / Linux install

```bash
# Bun 1.x (runtime + package manager + test runner + TS executor — replaces node+pnpm+tsx+vitest)
curl -fsSL https://bun.sh/install | bash
# Reload shell so $HOME/.bun/bin is on PATH.

# Docker + docker compose v2 plugin
# macOS: install Docker Desktop
# Linux: https://docs.docker.com/engine/install/

# git (usually pre-installed)
git --version

# GitHub CLI
#   macOS:   brew install gh
#   Ubuntu:  see https://github.com/cli/cli/blob/trunk/docs/install_linux.md
gh --version

# Claude Code CLI
#   bun install -g @anthropic-ai/claude-code
#   or:  curl -fsSL https://claude.ai/install.sh | bash   (vendor-provided installer)
claude --version

# AWS CLI v2 (used by backup script in Task 44b and by deploy ops)
#   https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html
aws --version
```

### Verify versions

```bash
bun --version               # 1.1.x or higher
docker --version
docker compose version
git --version               # 2.30 or higher (recommended)
gh --version                # 2.40 or higher
claude --version
aws --version               # aws-cli/2.x
```

**Note**: There is intentionally no `node` / `pnpm` / `tsx` / `vitest` install step. Bun ships its own JS runtime, package manager, TypeScript executor, and test runner. Installing Node alongside Bun is fine for personal workflows but the bot does not need it.

### Authenticate `gh` for local development

The bot itself uses **GitHub App installation tokens** in production (Task 31 + 38) and does **not** need `gh auth login`. But while developing locally — running ad-hoc `gh` commands to inspect PRs, configure repos, or test branch protection — you want a real `gh auth login`.

```bash
gh auth login
# Choose:
#   - GitHub.com
#   - HTTPS
#   - Authenticate with browser
gh auth status
# Should show your login + scopes
```

Then verify access to a test repo:

```bash
gh repo view your-sandbox-org/test-bot-target
```

### Authenticate Anthropic for local Claude Code use

```bash
export ANTHROPIC_API_KEY=sk-ant-...
claude -p "say hello" --print
# Should print a short response.
```

The bot passes `ANTHROPIC_API_KEY` through to spawned `claude` processes (Task 34), so the dev shell variable is not used by the bot at runtime — but having it lets you sanity-check the CLI separately.

### `secrets/` directory

Create it now so later tasks have somewhere to drop the GitHub App private key:

```bash
mkdir -p /Users/shivang/dev/sentry-fixer-bot/secrets
echo "secrets/" >> /Users/shivang/dev/sentry-fixer-bot/.gitignore.tmp  # if not already
# (Task 1 adds the .gitignore proper; for now keep `secrets/` out of git manually.)
```

### Smoke check `gh` + `claude` work in a non-interactive shell

The bot spawns both binaries via `execa` with no TTY. Verify they don't hang waiting for prompts:

```bash
gh --help < /dev/null > /dev/null      # exits 0
claude --help < /dev/null > /dev/null  # exits 0
```

### Done when

- All five `--version` checks pass.
- `gh auth status` shows logged in.
- `claude -p "hello"` returns a response.

This task produces no commit. Move on to Task 1.

---

## Task 1: Repo scaffold and `.gitignore`

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/package.json`
- Create: `/Users/shivang/dev/sentry-fixer-bot/.gitignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "sentry-fixer-bot",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "bun": ">=1.1" },
  "scripts": {
    "dev": "bun --watch src/index.ts web",
    "dev:worker": "bun --watch src/index.ts worker",
    "start": "bun src/index.ts",
    "test": "bun test",
    "test:watch": "bun test --watch",
    "lint": "bun x eslint src tests",
    "format": "bun x prettier --write src tests",
    "typecheck": "bun x tsc --noEmit",
    "db:migrate": "bun run src/db/migrate.ts",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@octokit/auth-app": "^7.1.0",
    "hono": "^4.6.0",
    "js-yaml": "^4.1.0",
    "pg": "^8.13.0",
    "pg-boss": "^9.0.3",
    "pino": "^9.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/bun": "^1.1.0",
    "@types/js-yaml": "^4.0.9",
    "@types/pg": "^8.11.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "eslint": "^9.16.0",
    "nock": "^13.5.0",
    "prettier": "^3.4.0",
    "typescript": "^5.7.0"
  }
}
```

**Why this is different from a Node project**:
- No `engines.node`; `engines.bun` instead.
- No `tsx` or `vitest`: Bun runs TypeScript natively and ships a `bun test` runner.
- No `@hono/node-server`: Bun has built-in `fetch` server support; Hono picks the Bun adapter automatically.
- No `execa`: Bun ships `Bun.spawn` / `Bun.$` with the same ergonomics.
- `@types/bun` replaces `@types/node` for the Bun-specific globals.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules/
dist/
.env
.env.local
*.log
coverage/
.DS_Store
work/
.omc/
secrets/
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/shivang/dev/sentry-fixer-bot && bun install`

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore bun.lockb
git commit -m "chore: scaffold package.json for MVP (webhook→PR, bun runtime)"
```

---

## Task 2: TypeScript configuration

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/tsconfig.json`

- [ ] **Step 1: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*", "tests/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Verify compile**

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: tsconfig strict mode"
```

---

## Task 3: ESLint + Prettier

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/.eslintrc.cjs`
- Create: `/Users/shivang/dev/sentry-fixer-bot/.prettierrc`

- [ ] **Step 1: Write `.eslintrc.cjs`**

```js
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "no-console": ["warn", { allow: ["error"] }],
  },
};
```

- [ ] **Step 2: Write `.prettierrc`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 3: Commit**

```bash
git add .eslintrc.cjs .prettierrc
git commit -m "chore: eslint and prettier"
```

---

## Task 4: Bun test runner config (`bunfig.toml`)

Bun's test runner is built in; there is no `vitest.config.ts`. We only need a minimal `bunfig.toml` to fix the test layout and timeout, plus a setup shim if needed.

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/bunfig.toml`

- [ ] **Step 1: Write `bunfig.toml`**

```toml
[test]
# Test files are discovered by Bun via *.test.ts pattern; we just set timeout.
timeout = 30000
# Run tests serially in a single process so the shared Postgres test DB
# from helpers/db.ts is not torn down under concurrent runs.
# Bun uses a single test process per file by default; we additionally pass
# --no-isolation in scripts when integration tests need cross-file DB state.
```

- [ ] **Step 2: Verify Bun's test runner loads**

Run: `bun test --bail --rerun-each 0 tests/_does_not_exist.test.ts || true`
Expected: Bun prints "0 pass / 0 fail" or "no tests found"; either is fine. The point is that `bun test` works.

- [ ] **Step 3: Commit**

```bash
git add bunfig.toml
git commit -m "chore: bunfig for test runner"
```

---

## Task 5: Docker Compose for local Postgres

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/docker-compose.yml`
- Create: `/Users/shivang/dev/sentry-fixer-bot/scripts/dev-up.sh`

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sfb
      POSTGRES_PASSWORD: sfb
      POSTGRES_DB: sfb
    ports:
      - "5433:5432"
    volumes:
      - sfb_pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sfb -d sfb"]
      interval: 2s
      timeout: 2s
      retries: 15

volumes:
  sfb_pg:
```

- [ ] **Step 2: Write `scripts/dev-up.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d postgres
echo "Waiting for postgres..."
until docker compose exec -T postgres pg_isready -U sfb -d sfb >/dev/null 2>&1; do
  sleep 1
done
echo "Postgres ready on localhost:5433"
```

- [ ] **Step 3: Make executable and start**

```bash
chmod +x scripts/dev-up.sh
./scripts/dev-up.sh
```

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml scripts/dev-up.sh
git commit -m "chore: docker-compose postgres + dev-up script"
```

---

## Task 6: `.env.example`

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/.env.example`

- [ ] **Step 1: Write `.env.example`**

```bash
# Database
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb

# Sentry
SENTRY_WEBHOOK_SECRET=replace-with-shared-secret
SENTRY_API_TOKEN=replace-with-internal-integration-token
SENTRY_ORG_SLUG=acme

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# S3
S3_BUCKET=sfb-archives-dev
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# GitHub App (PR creation)
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
GITHUB_APP_INSTALLATION_ID=

# Agent runtime
WORK_DIR=/var/lib/sfb/work
CLAUDE_BIN=claude
CLAUDE_MODEL=claude-opus-4-7
AGENT_TIMEOUT_SECONDS=900

# Repo config
REPOS_CONFIG_PATH=./repos.yaml

# Service
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: env example with MVP keys"
```

---

## Task 7: `repos.yaml.example`

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/repos.yaml.example`

- [ ] **Step 1: Write `repos.yaml.example`**

```yaml
# Map Sentry project slug → GitHub repo and bot policy.
# Copy to repos.yaml and edit. Reloaded on SIGHUP at runtime.
repos:
  - sentry_project: backend-api
    github: acme-corp/api
    default_branch: main
    test_command: pnpm test --run
    pr_reviewers: ["acme-corp/backend"]
    daily_token_cap: 1000000
    daily_cost_cap_cents: 2500
    min_severity_to_fix: medium       # low|medium|high|critical
  - sentry_project: web-frontend
    github: acme-corp/web
    default_branch: main
    test_command: pnpm test:ci
    pr_reviewers: ["acme-corp/web"]
    daily_token_cap: 500000
    daily_cost_cap_cents: 1500
    min_severity_to_fix: medium
```

- [ ] **Step 2: Commit**

```bash
git add repos.yaml.example
git commit -m "chore: repos.yaml example"
```

---

## Task 8: Env schema

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/env.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/env.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/env.test.ts
import { describe, it, expect } from "bun:test";
import { parseEnv } from "../../src/env.js";

const validEnv = {
  DATABASE_URL: "postgres://u:p@localhost:5433/sfb",
  SENTRY_WEBHOOK_SECRET: "secret",
  SENTRY_API_TOKEN: "token",
  SENTRY_ORG_SLUG: "acme",
  ANTHROPIC_API_KEY: "sk-ant-x",
  S3_BUCKET: "bucket",
  S3_REGION: "us-east-1",
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY_PATH: "./key.pem",
  GITHUB_APP_INSTALLATION_ID: "67890",
  WORK_DIR: "/tmp/sfb",
  CLAUDE_BIN: "claude",
  CLAUDE_MODEL: "claude-opus-4-7",
  AGENT_TIMEOUT_SECONDS: "900",
  REPOS_CONFIG_PATH: "./repos.yaml",
  PORT: "3000",
  LOG_LEVEL: "info",
  NODE_ENV: "test",
};

describe("parseEnv", () => {
  it("accepts a valid environment", () => {
    const env = parseEnv(validEnv);
    expect(env.PORT).toBe(3000);
    expect(env.AGENT_TIMEOUT_SECONDS).toBe(900);
  });

  it("rejects missing required fields", () => {
    const { DATABASE_URL: _, ...rest } = validEnv;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("rejects missing GitHub App fields", () => {
    const { GITHUB_APP_ID: _, ...rest } = validEnv;
    expect(() => parseEnv(rest)).toThrow(/GITHUB_APP_ID/);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/env.test.ts`

- [ ] **Step 3: Implement `src/env.ts`**

```ts
// src/env.ts
import { z } from "zod";

export const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  SENTRY_WEBHOOK_SECRET: z.string().min(1),
  SENTRY_API_TOKEN: z.string().min(1),
  SENTRY_ORG_SLUG: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().min(1),
  GITHUB_APP_ID: z.string().min(1),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1),
  GITHUB_APP_INSTALLATION_ID: z.string().min(1),
  WORK_DIR: z.string().min(1).default("/var/lib/sfb/work"),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CLAUDE_MODEL: z.string().min(1).default("claude-opus-4-7"),
  AGENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),
  REPOS_CONFIG_PATH: z.string().min(1).default("./repos.yaml"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type Env = z.infer<typeof EnvSchema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return EnvSchema.parse(source);
}

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/env.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/env.ts tests/unit/env.test.ts
git commit -m "feat(env): zod-validated env schema"
```

---

## Task 9: Pino logger

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/log.ts`

- [ ] **Step 1: Write `src/log.ts`**

```ts
// src/log.ts
import pino from "pino";
import { env } from "./env.js";

export const log = pino({
  level: env().LOG_LEVEL,
  base: { service: "sfb", env: env().NODE_ENV },
  redact: {
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.secret",
      "*.token",
      "*.private_key",
      "*.apiKey",
    ],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof log;
```

- [ ] **Step 2: Commit**

```bash
git add src/log.ts
git commit -m "feat(log): pino logger"
```

---

## Task 10: Postgres pool

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/db/client.ts`

- [ ] **Step 1: Write `src/db/client.ts`**

```ts
// src/db/client.ts
import pg from "pg";
import { env } from "../env.js";
import { log } from "../log.js";

const { Pool } = pg;
let pool: pg.Pool | null = null;

export function db(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => log.error({ err }, "pg pool error"));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/db/client.ts
git commit -m "feat(db): pg pool"
```

---

## Task 11: Database schema (MVP, full)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/db/schema.sql`

This schema includes `prs` and full agent fields on `runs` from day one. One migration, no later migrations needed for MVP.

- [ ] **Step 1: Write `src/db/schema.sql`**

```sql
-- src/db/schema.sql
-- MVP schema. Idempotent; safe to re-run.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS alerts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sentry_issue_id TEXT NOT NULL,
  sentry_project  TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  code_version    TEXT,
  dedup_key       TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  level           TEXT NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL,
  last_seen_at    TIMESTAMPTZ NOT NULL,
  webhook_count   INT NOT NULL DEFAULT 1,
  raw_payload_s3  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS alerts_sentry_issue_id_idx ON alerts (sentry_issue_id);
CREATE INDEX IF NOT EXISTS alerts_created_at_idx ON alerts (created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id         UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  repo             TEXT,
  branch           TEXT,
  status           TEXT NOT NULL,
    -- triaging | triage_done | triage_failed
    -- agent_pending | agent_running | agent_done | agent_failed
    -- pr_opened | budget_blocked
  severity         TEXT,
  triage_summary   TEXT,
  suspected_files  JSONB,
  stack_trace      TEXT,
  agent_summary    TEXT,
  agent_confidence TEXT,
  agent_risk       TEXT,
  test_passed      BOOLEAN,
  tokens_input     INT NOT NULL DEFAULT 0,
  tokens_output    INT NOT NULL DEFAULT 0,
  cost_cents       INT NOT NULL DEFAULT 0,
  log_s3           TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  error            TEXT,
  retry_of         UUID REFERENCES runs(id)
);

CREATE INDEX IF NOT EXISTS runs_alert_id_idx ON runs (alert_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);

CREATE TABLE IF NOT EXISTS prs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id        UUID NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  run_id          UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,
  number          INT NOT NULL,
  url             TEXT NOT NULL,
  is_draft        BOOLEAN NOT NULL,
  needs_human     BOOLEAN NOT NULL DEFAULT FALSE,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo, number)
);

CREATE INDEX IF NOT EXISTS prs_run_id_idx ON prs (run_id);

CREATE TABLE IF NOT EXISTS budgets (
  repo               TEXT NOT NULL,
  date               DATE NOT NULL,
  tokens_used        INT NOT NULL DEFAULT 0,
  cost_cents         INT NOT NULL DEFAULT 0,
  cap_tokens         INT NOT NULL,
  cap_cost_cents     INT NOT NULL,
  PRIMARY KEY (repo, date)
);
```

- [ ] **Step 2: Commit**

```bash
git add src/db/schema.sql
git commit -m "feat(db): MVP schema (alerts, runs, prs, budgets)"
```

---

## Task 12: Migration runner

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/db/migrate.ts`

- [ ] **Step 1: Write `src/db/migrate.ts`**

```ts
// src/db/migrate.ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { db, closeDb } from "./client.js";
import { log } from "../log.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const sqlPath = join(here, "schema.sql");
  const sql = await readFile(sqlPath, "utf8");
  await db().query(sql);
  log.info("migration applied");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(closeDb)
    .catch((err) => {
      log.error({ err }, "migration failed");
      process.exit(1);
    });
}
```

- [ ] **Step 2: Apply migration**

```bash
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb \
SENTRY_WEBHOOK_SECRET=x SENTRY_API_TOKEN=x SENTRY_ORG_SLUG=x \
ANTHROPIC_API_KEY=x S3_BUCKET=x S3_REGION=us-east-1 \
GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY_PATH=./k.pem GITHUB_APP_INSTALLATION_ID=1 \
NODE_ENV=test bun run db:migrate
```
Expected: `migration applied`. `docker compose exec postgres psql -U sfb -d sfb -c "\dt"` lists `alerts`, `runs`, `prs`, `budgets`. Re-run to confirm idempotency.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat(db): migration runner"
```

---

## Task 13: Test DB helper

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/tests/helpers/db.ts`

- [ ] **Step 1: Write `tests/helpers/db.ts`**

```ts
// tests/helpers/db.ts
import { db, closeDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

export async function setupTestDb(): Promise<void> {
  await migrate();
  await db().query(`TRUNCATE TABLE alerts, runs, prs, budgets RESTART IDENTITY CASCADE`);
}

export async function teardownTestDb(): Promise<void> {
  await closeDb();
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/helpers/db.ts
git commit -m "test: db lifecycle helper"
```

---

## Task 14: Repo config loader

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/config/repos.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/repos-config.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/repos-config.test.ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReposConfig, repoForProject, __resetForTest } from "../../src/config/repos.js";

let tmp: string;
const sample = `
repos:
  - sentry_project: backend-api
    github: acme/api
    default_branch: main
    test_command: pnpm test --run
    pr_reviewers: ["acme/back"]
    daily_token_cap: 1000000
    daily_cost_cap_cents: 2500
    min_severity_to_fix: medium
`;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "sfb-config-"));
  await writeFile(join(tmp, "repos.yaml"), sample, "utf8");
  process.env.REPOS_CONFIG_PATH = join(tmp, "repos.yaml");
  __resetForTest();
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("loadReposConfig", () => {
  it("parses and validates the yaml", async () => {
    const cfg = await loadReposConfig();
    expect(cfg.repos).toHaveLength(1);
    expect(cfg.repos[0]?.github).toBe("acme/api");
  });
  it("repoForProject returns matching entry", async () => {
    const entry = await repoForProject("backend-api");
    expect(entry?.github).toBe("acme/api");
  });
  it("repoForProject returns undefined when unknown", async () => {
    expect(await repoForProject("unknown")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/repos-config.test.ts`

- [ ] **Step 3: Implement `src/config/repos.ts`**

```ts
// src/config/repos.ts
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { z } from "zod";
import { env } from "../env.js";

const Severity = z.enum(["low", "medium", "high", "critical"]);

const RepoEntrySchema = z.object({
  sentry_project: z.string().min(1),
  github: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/repo"),
  default_branch: z.string().min(1),
  test_command: z.string().min(1),
  pr_reviewers: z.array(z.string().min(1)).default([]),
  daily_token_cap: z.number().int().positive(),
  daily_cost_cap_cents: z.number().int().positive(),
  min_severity_to_fix: Severity.default("medium"),
});

const ReposConfigSchema = z.object({ repos: z.array(RepoEntrySchema) });

export type RepoEntry = z.infer<typeof RepoEntrySchema>;
export type ReposConfig = z.infer<typeof ReposConfigSchema>;
export const SeverityValues = ["low", "medium", "high", "critical"] as const;
export type SeverityValue = (typeof SeverityValues)[number];

let cache: ReposConfig | null = null;

export function __resetForTest(): void { cache = null; }

export async function loadReposConfig(): Promise<ReposConfig> {
  if (cache) return cache;
  const raw = await readFile(env().REPOS_CONFIG_PATH, "utf8");
  cache = ReposConfigSchema.parse(yaml.load(raw));
  return cache;
}

export async function repoForProject(project: string): Promise<RepoEntry | undefined> {
  const cfg = await loadReposConfig();
  return cfg.repos.find((r) => r.sentry_project === project);
}

export function severityRank(s: SeverityValue): number {
  return SeverityValues.indexOf(s);
}

export function severityAtLeast(actual: SeverityValue, threshold: SeverityValue): boolean {
  return severityRank(actual) >= severityRank(threshold);
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/repos-config.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/config/repos.ts tests/unit/repos-config.test.ts
git commit -m "feat(config): repos.yaml loader"
```

---

## Task 15: Reserved

(Numbering kept stable with the file map. Continue to Task 16.)

---

## Task 16: Hono app factory

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/server.ts`

- [ ] **Step 1: Write `src/web/server.ts`**

```ts
// src/web/server.ts
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { log } from "../log.js";
import { env } from "../env.js";

export function createApp(): Hono {
  const app = new Hono();
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((err, c) => {
    log.error({ err: { message: err.message, stack: err.stack } }, "unhandled error");
    return c.json({ error: "internal" }, 500);
  });
  return app;
}

export async function startServer(app: Hono): Promise<{ close: () => Promise<void> }> {
  const port = env().PORT;
  const server = serve({ fetch: app.fetch, port });
  log.info({ port }, "web server listening");
  return { close: () => new Promise<void>((r) => server.close(() => r())) };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): hono app factory"
```

---

## Task 17: Health route

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/routes/health.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/health.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/health.test.ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createApp } from "../../src/web/server.js";
import { mountHealth } from "../../src/web/routes/health.js";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";

describe("GET /healthz", () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  it("returns 200 with db ok", async () => {
    const app = createApp();
    mountHealth(app);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, db: true });
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/integration/health.test.ts`

- [ ] **Step 3: Implement `src/web/routes/health.ts`**

```ts
// src/web/routes/health.ts
import type { Hono } from "hono";
import { db } from "../../db/client.js";

export function mountHealth(app: Hono): void {
  app.get("/healthz", async (c) => {
    let dbOk = false;
    try { await db().query("SELECT 1"); dbOk = true; }
    catch { dbOk = false; }
    return c.json({ ok: dbOk, db: dbOk }, dbOk ? 200 : 503);
  });
}
```

- [ ] **Step 4: Run test (PASS)**

Run: `bun test tests/integration/health.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/health.ts tests/integration/health.test.ts
git commit -m "feat(web): /healthz"
```

---

## Task 18: HMAC verifier

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/verify-hmac.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/verify-hmac.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/verify-hmac.test.ts
import { describe, it, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySentrySignature } from "../../src/web/verify-hmac.js";

const SECRET = "shared-secret";
const sign = (b: string) => createHmac("sha256", SECRET).update(b).digest("hex");

describe("verifySentrySignature", () => {
  it("accepts matching", () => {
    const body = '{"x":1}';
    expect(verifySentrySignature(body, sign(body), SECRET)).toBe(true);
  });
  it("rejects tampered body", () => {
    const body = '{"x":1}';
    expect(verifySentrySignature(body + "y", sign(body), SECRET)).toBe(false);
  });
  it("rejects tampered signature", () => {
    const body = '{"x":1}';
    const sig = sign(body);
    const t = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(verifySentrySignature(body, t, SECRET)).toBe(false);
  });
  it("rejects empty signature", () => {
    expect(verifySentrySignature("b", "", SECRET)).toBe(false);
  });
  it("rejects wrong-length without throwing", () => {
    expect(verifySentrySignature("b", "abc", SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/verify-hmac.test.ts`

- [ ] **Step 3: Implement `src/web/verify-hmac.ts`**

```ts
// src/web/verify-hmac.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySentrySignature(body: string, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/verify-hmac.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/web/verify-hmac.ts tests/unit/verify-hmac.test.ts
git commit -m "feat(web): timing-safe hmac verify"
```

---

## Task 19: Sentry payload fixture

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/tests/helpers/fixtures.ts`

- [ ] **Step 1: Write fixture builder**

```ts
// tests/helpers/fixtures.ts
import { createHmac } from "node:crypto";

export type SentryWebhookPayload = {
  action: string;
  data: {
    issue: {
      id: string;
      shortId: string;
      project: { slug: string };
      title: string;
      level: string;
      firstSeen: string;
      lastSeen: string;
      metadata?: { fingerprint?: string };
    };
    release?: { version?: string };
  };
  installation: { uuid: string };
};

export function makeSentryPayload(overrides: Partial<{
  issueId: string; shortId: string; project: string; title: string;
  level: string; fingerprint: string; firstSeen: string; lastSeen: string; release: string;
}> = {}): SentryWebhookPayload {
  const now = new Date().toISOString();
  return {
    action: "issue.created",
    data: {
      issue: {
        id: overrides.issueId ?? "1234567890",
        shortId: overrides.shortId ?? "PROJ-1A",
        project: { slug: overrides.project ?? "backend-api" },
        title: overrides.title ?? "TypeError: cannot read property 'x' of undefined",
        level: overrides.level ?? "error",
        firstSeen: overrides.firstSeen ?? now,
        lastSeen: overrides.lastSeen ?? now,
        metadata: { fingerprint: overrides.fingerprint ?? "abc123" },
      },
      release: { version: overrides.release ?? "v1.0.0" },
    },
    installation: { uuid: "00000000-0000-0000-0000-000000000000" },
  };
}

export function signPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/helpers/fixtures.ts
git commit -m "test: sentry payload fixture"
```

---

## Task 20: Dedup key

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/alerts/dedup-key.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/dedup-key.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/dedup-key.test.ts
import { describe, it, expect } from "bun:test";
import { computeDedupKey } from "../../src/alerts/dedup-key.js";

describe("computeDedupKey", () => {
  it("is stable", () => {
    const a = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v" });
    const b = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v" });
    expect(a).toEqual(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("differs on project", () => {
    expect(computeDedupKey({ project: "p1", fingerprint: "f", codeVersion: "v" }))
      .not.toEqual(computeDedupKey({ project: "p2", fingerprint: "f", codeVersion: "v" }));
  });
  it("differs on fingerprint", () => {
    expect(computeDedupKey({ project: "p", fingerprint: "f1", codeVersion: "v" }))
      .not.toEqual(computeDedupKey({ project: "p", fingerprint: "f2", codeVersion: "v" }));
  });
  it("differs on codeVersion", () => {
    expect(computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" }))
      .not.toEqual(computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v2" }));
  });
  it("treats null codeVersion as empty", () => {
    expect(computeDedupKey({ project: "p", fingerprint: "f", codeVersion: null }))
      .toEqual(computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "" }));
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/dedup-key.test.ts`

- [ ] **Step 3: Implement `src/alerts/dedup-key.ts`**

```ts
// src/alerts/dedup-key.ts
import { createHash } from "node:crypto";

export type DedupInput = { project: string; fingerprint: string; codeVersion: string | null };

export function computeDedupKey(input: DedupInput): string {
  const v = input.codeVersion ?? "";
  return createHash("sha256")
    .update(`${input.project}|${input.fingerprint}|${v}`)
    .digest("hex");
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/dedup-key.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/alerts/dedup-key.ts tests/unit/dedup-key.test.ts
git commit -m "feat(alerts): dedup key"
```

---

## Task 21: Alert upsert

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/alerts/persist.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/alert-persist.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/alert-persist.test.ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { upsertAlert } from "../../src/alerts/persist.js";

describe("upsertAlert", () => {
  beforeEach(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });

  const fixed = {
    sentryIssueId: "111",
    sentryProject: "p",
    fingerprint: "f",
    codeVersion: "v1",
    dedupKey: "deadbeef",
    title: "X",
    level: "error",
    firstSeenAt: new Date("2026-05-15T00:00:00Z"),
    lastSeenAt: new Date("2026-05-15T00:00:00Z"),
    rawPayloadS3: "s3://bucket/key",
  };

  it("inserts new and reports isNew=true", async () => {
    const out = await upsertAlert(fixed);
    expect(out.isNew).toBe(true);
    expect(out.webhookCount).toBe(1);
  });

  it("bumps on conflict", async () => {
    await upsertAlert(fixed);
    const out2 = await upsertAlert({ ...fixed, lastSeenAt: new Date() });
    expect(out2.isNew).toBe(false);
    expect(out2.webhookCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/integration/alert-persist.test.ts`

- [ ] **Step 3: Implement `src/alerts/persist.ts`**

```ts
// src/alerts/persist.ts
import { db } from "../db/client.js";

export type AlertInput = {
  sentryIssueId: string;
  sentryProject: string;
  fingerprint: string;
  codeVersion: string | null;
  dedupKey: string;
  title: string;
  level: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  rawPayloadS3: string;
};

export type AlertUpsertResult = { id: string; isNew: boolean; webhookCount: number };

export async function upsertAlert(input: AlertInput): Promise<AlertUpsertResult> {
  const sql = `
    INSERT INTO alerts (
      sentry_issue_id, sentry_project, fingerprint, code_version, dedup_key,
      title, level, first_seen_at, last_seen_at, raw_payload_s3
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (dedup_key) DO UPDATE
      SET webhook_count = alerts.webhook_count + 1,
          last_seen_at  = EXCLUDED.last_seen_at
    RETURNING id, webhook_count, (xmax = 0) AS is_new
  `;
  const res = await db().query(sql, [
    input.sentryIssueId, input.sentryProject, input.fingerprint, input.codeVersion,
    input.dedupKey, input.title, input.level,
    input.firstSeenAt, input.lastSeenAt, input.rawPayloadS3,
  ]);
  const row = res.rows[0];
  return { id: row.id, isNew: row.is_new === true, webhookCount: row.webhook_count };
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/integration/alert-persist.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/alerts/persist.ts tests/integration/alert-persist.test.ts
git commit -m "feat(alerts): upsert"
```

---

## Task 22: S3 archive

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/archive/s3.ts`

- [ ] **Step 1: Write `src/archive/s3.ts`**

```ts
// src/archive/s3.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";
import { log } from "../log.js";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({ region: env().S3_REGION });
  return client;
}

function datePrefix(): { yyyy: number; mm: string } {
  const now = new Date();
  return {
    yyyy: now.getUTCFullYear(),
    mm: String(now.getUTCMonth() + 1).padStart(2, "0"),
  };
}

export type ArchiveInput = { alertId: string; body: string };

export async function archiveSentryPayload(input: ArchiveInput): Promise<string> {
  const { yyyy, mm } = datePrefix();
  const key = `sentry-payloads/${yyyy}/${mm}/${input.alertId}.json`;
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: input.body,
    ContentType: "application/json",
  }));
  return `s3://${env().S3_BUCKET}/${key}`;
}

export async function archiveSentryPayloadSafe(input: ArchiveInput): Promise<string> {
  try { return await archiveSentryPayload(input); }
  catch (err) {
    log.error({ err, alertId: input.alertId }, "s3 archive failed; degrading");
    return `s3://unavailable/${input.alertId}`;
  }
}

export type ArchiveLogInput = { runId: string; body: string };

export async function archiveRunLog(input: ArchiveLogInput): Promise<string> {
  const { yyyy, mm } = datePrefix();
  const key = `run-logs/${yyyy}/${mm}/${input.runId}.log`;
  await s3().send(new PutObjectCommand({
    Bucket: env().S3_BUCKET,
    Key: key,
    Body: input.body,
    ContentType: "text/plain",
  }));
  return `s3://${env().S3_BUCKET}/${key}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/archive/s3.ts
git commit -m "feat(archive): s3 helpers"
```

---

## Task 23: Sentry webhook route

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/routes/sentry-webhook.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/webhook.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
// tests/integration/webhook.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { createApp } from "../../src/web/server.js";
import { mountSentryWebhook } from "../../src/web/routes/sentry-webhook.js";
import { makeSentryPayload, signPayload } from "../helpers/fixtures.js";

const SECRET = "test-secret";

mock.module("../../src/archive/s3.js", () => ({
  archiveSentryPayloadSafe: mock(async ({ alertId }: { alertId: string }) => `s3://test/${alertId}.json`),
  archiveRunLog: mock(async () => "s3://test/log"),
}));

const enqueueTriage = mock(async (_alertId: string) => "job-id");

beforeAll(async () => { process.env.SENTRY_WEBHOOK_SECRET = SECRET; });
beforeEach(async () => { await setupTestDb(); enqueueTriage.mockClear(); });
afterAll(async () => { await teardownTestDb(); });

function buildRequest(body: object) {
  const raw = JSON.stringify(body);
  const sig = signPayload(raw, SECRET);
  return new Request("http://localhost/webhooks/sentry", {
    method: "POST",
    headers: { "content-type": "application/json", "sentry-hook-signature": sig },
    body: raw,
  });
}

describe("POST /webhooks/sentry", () => {
  it("rejects no-signature with 401", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(makeSentryPayload()),
    });
    expect(res.status).toBe(401);
    expect(enqueueTriage).not.toHaveBeenCalled();
  });

  it("rejects tampered body", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const p = makeSentryPayload();
    const raw = JSON.stringify(p);
    const sig = signPayload(raw, SECRET);
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "content-type": "application/json", "sentry-hook-signature": sig },
      body: raw + " ",
    });
    expect(res.status).toBe(401);
  });

  it("inserts new and enqueues", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const res = await app.request(buildRequest(makeSentryPayload()));
    expect(res.status).toBe(202);
    const r = await db().query("SELECT count(*)::int as c FROM alerts");
    expect(r.rows[0].c).toBe(1);
    expect(enqueueTriage).toHaveBeenCalledTimes(1);
  });

  it("dedups storms", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const p = makeSentryPayload();
    await app.request(buildRequest(p));
    await app.request(buildRequest(p));
    await app.request(buildRequest(p));
    const r = await db().query("SELECT count(*)::int as c, max(webhook_count)::int as wc FROM alerts");
    expect(r.rows[0].c).toBe(1);
    expect(r.rows[0].wc).toBe(3);
    expect(enqueueTriage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/integration/webhook.test.ts`

- [ ] **Step 3: Implement `src/web/routes/sentry-webhook.ts`**

```ts
// src/web/routes/sentry-webhook.ts
import type { Hono } from "hono";
import { env } from "../../env.js";
import { log } from "../../log.js";
import { verifySentrySignature } from "../verify-hmac.js";
import { computeDedupKey } from "../../alerts/dedup-key.js";
import { upsertAlert } from "../../alerts/persist.js";
import { archiveSentryPayloadSafe } from "../../archive/s3.js";

const SIGNATURE_HEADER = "sentry-hook-signature";

type Deps = { enqueueTriage?: (alertId: string) => Promise<string> };

type SentryIssue = {
  id: string;
  shortId?: string;
  project: { slug: string };
  title: string;
  level: string;
  firstSeen: string;
  lastSeen: string;
  metadata?: { fingerprint?: string };
};

type SentryBody = { data?: { issue?: SentryIssue; release?: { version?: string } } };

export function mountSentryWebhook(app: Hono, deps: Deps = {}): void {
  app.post("/webhooks/sentry", async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header(SIGNATURE_HEADER) ?? "";
    if (!verifySentrySignature(raw, signature, env().SENTRY_WEBHOOK_SECRET)) {
      log.warn({ sig_present: signature.length > 0 }, "sentry webhook rejected");
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: SentryBody;
    try { body = JSON.parse(raw) as SentryBody; }
    catch { return c.json({ error: "invalid_json" }, 400); }

    const issue = body.data?.issue;
    if (!issue) return c.json({ error: "no_issue" }, 400);

    const project = issue.project.slug;
    const fingerprint = issue.metadata?.fingerprint ?? issue.id;
    const codeVersion = body.data?.release?.version ?? null;
    const dedupKey = computeDedupKey({ project, fingerprint, codeVersion });

    const upsert = await upsertAlert({
      sentryIssueId: issue.id,
      sentryProject: project,
      fingerprint,
      codeVersion,
      dedupKey,
      title: issue.title,
      level: issue.level,
      firstSeenAt: new Date(issue.firstSeen),
      lastSeenAt: new Date(issue.lastSeen),
      rawPayloadS3: "pending",
    });

    if (upsert.isNew) {
      const s3Url = await archiveSentryPayloadSafe({ alertId: upsert.id, body: raw });
      try {
        const { db } = await import("../../db/client.js");
        await db().query("UPDATE alerts SET raw_payload_s3=$1 WHERE id=$2", [s3Url, upsert.id]);
      } catch (err) { log.error({ err }, "failed to backfill s3 path"); }

      const enqueue = deps.enqueueTriage ?? (await import("../../queue/jobs.js")).enqueueTriage;
      try { await enqueue(upsert.id); }
      catch (err) { log.error({ err, alertId: upsert.id }, "failed to enqueue triage"); }
    } else {
      log.info({ alertId: upsert.id, count: upsert.webhookCount }, "deduped");
    }

    return c.json({ alertId: upsert.id, isNew: upsert.isNew }, 202);
  });
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/integration/webhook.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/sentry-webhook.ts tests/integration/webhook.test.ts
git commit -m "feat(web): sentry webhook"
```

---

## Task 24: pg-boss init

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/queue/boss.ts`

- [ ] **Step 1: Write `src/queue/boss.ts`**

```ts
// src/queue/boss.ts
import PgBoss from "pg-boss";
import { env } from "../env.js";
import { log } from "../log.js";

let boss: PgBoss | null = null;

export async function getBoss(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({ connectionString: env().DATABASE_URL });
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();
  return boss;
}

export async function stopBoss(): Promise<void> {
  if (boss) { await boss.stop({ graceful: true }); boss = null; }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/queue/boss.ts
git commit -m "feat(queue): pg-boss init"
```

---

## Task 25: Job types (triage + agent)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/queue/jobs.ts`

- [ ] **Step 1: Write `src/queue/jobs.ts`**

```ts
// src/queue/jobs.ts
import type PgBoss from "pg-boss";
import { getBoss } from "./boss.js";

export const Q = { triage: "triage", agent: "agent" } as const;

export type TriagePayload = { alertId: string };
export type AgentPayload = { runId: string };

export async function enqueueTriage(alertId: string): Promise<string> {
  const boss = await getBoss();
  const jobId = await boss.send<TriagePayload>(Q.triage, { alertId }, {
    retryLimit: 2, retryDelay: 30, retryBackoff: true, expireInHours: 1,
  });
  if (!jobId) throw new Error("null triage job id");
  return jobId;
}

export async function enqueueAgent(runId: string): Promise<string> {
  const boss = await getBoss();
  const jobId = await boss.send<AgentPayload>(Q.agent, { runId }, {
    retryLimit: 1, retryDelay: 60, expireInHours: 1,
  });
  if (!jobId) throw new Error("null agent job id");
  return jobId;
}

export async function onTriage(
  handler: (p: TriagePayload, j: PgBoss.Job<TriagePayload>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.work<TriagePayload>(Q.triage, { teamSize: 3, teamConcurrency: 1 }, async (j) => {
    await handler(j.data, j);
  });
}

export async function onAgent(
  handler: (p: AgentPayload, j: PgBoss.Job<AgentPayload>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.work<AgentPayload>(Q.agent, { teamSize: 3, teamConcurrency: 1 }, async (j) => {
    await handler(j.data, j);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/queue/jobs.ts
git commit -m "feat(queue): triage and agent jobs"
```

---

## Task 26: Sentry REST client

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/sentry/client.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/sentry-client.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/sentry-client.test.ts
import { describe, it, expect, afterEach } from "bun:test";
import nock from "nock";
import { fetchLatestEvent } from "../../src/sentry/client.js";

afterEach(() => nock.cleanAll());

describe("fetchLatestEvent", () => {
  it("returns parsed event", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    process.env.SENTRY_ORG_SLUG = "acme";
    nock("https://sentry.io")
      .get("/api/0/issues/1234/events/latest/")
      .reply(200, { eventID: "abc", entries: [], tags: [] });
    const out = await fetchLatestEvent("1234");
    expect(out.eventID).toBe("abc");
  });
  it("throws on 4xx", async () => {
    process.env.SENTRY_API_TOKEN = "tok";
    process.env.SENTRY_ORG_SLUG = "acme";
    nock("https://sentry.io").get("/api/0/issues/2222/events/latest/").reply(404, {});
    await expect(fetchLatestEvent("2222")).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/sentry-client.test.ts`

- [ ] **Step 3: Implement `src/sentry/client.ts`**

```ts
// src/sentry/client.ts
import { env } from "../env.js";

export type SentryEvent = {
  eventID: string;
  message?: string;
  entries?: unknown[];
  tags?: Array<{ key: string; value: string }>;
};

export async function fetchLatestEvent(sentryIssueId: string): Promise<SentryEvent> {
  const url = `https://sentry.io/api/0/issues/${encodeURIComponent(sentryIssueId)}/events/latest/`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${env().SENTRY_API_TOKEN}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sentry api ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SentryEvent;
}

export function extractStackTrace(event: SentryEvent): string {
  if (!event.entries || !Array.isArray(event.entries)) return "(no stack trace)";
  for (const entry of event.entries) {
    if (typeof entry === "object" && entry !== null && "type" in entry &&
        (entry as { type: string }).type === "exception") {
      const data = (entry as { data?: { values?: Array<{ stacktrace?: { frames?: unknown[] } }> } }).data;
      const frames = data?.values?.[0]?.stacktrace?.frames ?? [];
      return JSON.stringify(frames, null, 2);
    }
  }
  return "(no exception entry)";
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/sentry-client.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/sentry/client.ts tests/unit/sentry-client.test.ts
git commit -m "feat(sentry): rest client + stack extract"
```

---

## Task 27: Haiku triage classifier

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/triage/classify.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/classify.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/classify.test.ts
import { describe, it, expect, mock, spyOn } from "bun:test";

mock.module("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      create: mock(async () => ({
        id: "msg_1",
        content: [{
          type: "tool_use",
          name: "report_triage",
          input: {
            severity: "high", summary: "Null deref",
            suspected_files: ["src/auth.ts"], confidence: 0.82,
          },
        }],
        usage: { input_tokens: 1000, output_tokens: 200 },
      })),
    };
  },
}));

import { classify } from "../../src/triage/classify.js";

describe("classify", () => {
  it("returns structured output with tokens", async () => {
    const out = await classify({
      alertTitle: "TypeError", level: "error",
      stackTrace: "Error\n  at foo", eventTags: [],
    });
    expect(out.severity).toBe("high");
    expect(out.suspectedFiles).toEqual(["src/auth.ts"]);
    expect(out.tokensIn).toBe(1000);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/classify.test.ts`

- [ ] **Step 3: Implement `src/triage/classify.ts`**

```ts
// src/triage/classify.ts
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env.js";

export type TriageInput = {
  alertTitle: string;
  level: string;
  stackTrace: string;
  eventTags: Array<{ key: string; value: string }>;
};

export type TriageOutput = {
  severity: "low" | "medium" | "high" | "critical";
  summary: string;
  suspectedFiles: string[];
  confidence: number;
  tokensIn: number;
  tokensOut: number;
};

const TOOL = {
  name: "report_triage",
  description: "Report the triage result for the Sentry alert.",
  input_schema: {
    type: "object",
    properties: {
      severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
      summary: { type: "string" },
      suspected_files: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["severity", "summary", "suspected_files", "confidence"],
  },
} as const;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env().ANTHROPIC_API_KEY });
  return client;
}

export async function classify(input: TriageInput): Promise<TriageOutput> {
  const tagBlock = input.eventTags.map((t) => `  ${t.key}=${t.value}`).join("\n");
  const userPrompt = [
    `Title: ${input.alertTitle}`,
    `Level: ${input.level}`,
    `Tags:\n${tagBlock || "  (none)"}`,
    ``,
    `Stack trace:`,
    "```",
    input.stackTrace.slice(0, 8000),
    "```",
    ``,
    `Classify severity, summarise the likely cause in one sentence,`,
    `and list up to 5 repo-relative file paths you suspect contain the bug.`,
    `Call report_triage. If unclear, return low confidence rather than guess.`,
  ].join("\n");

  const res = await anthropic().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    tool_choice: { type: "tool", name: TOOL.name },
    tools: [TOOL],
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("claude did not call report_triage");
  const args = toolUse.input as {
    severity: TriageOutput["severity"];
    summary: string;
    suspected_files: string[];
    confidence: number;
  };
  return {
    severity: args.severity,
    summary: args.summary,
    suspectedFiles: args.suspected_files,
    confidence: args.confidence,
    tokensIn: res.usage.input_tokens,
    tokensOut: res.usage.output_tokens,
  };
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/classify.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/triage/classify.ts tests/unit/classify.test.ts
git commit -m "feat(triage): haiku classifier"
```

---

## Task 28: Sentry comment poster

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/sentry/comment.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/sentry-comment.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/sentry-comment.test.ts
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import nock from "nock";
import { postTriageComment } from "../../src/sentry/comment.js";

beforeEach(() => { process.env.SENTRY_API_TOKEN = "tok"; });
afterEach(() => nock.cleanAll());

describe("postTriageComment", () => {
  it("POSTs", async () => {
    const scope = nock("https://sentry.io")
      .post("/api/0/issues/9999/comments/", (b: { text: string }) => b.text.includes("severity"))
      .reply(201, { id: "c1" });
    await postTriageComment({ sentryIssueId: "9999", body: "severity=high" });
    expect(scope.isDone()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/sentry-comment.test.ts`

- [ ] **Step 3: Implement `src/sentry/comment.ts`**

```ts
// src/sentry/comment.ts
import { env } from "../env.js";

export type CommentInput = { sentryIssueId: string; body: string };

export async function postTriageComment(input: CommentInput): Promise<void> {
  const url = `https://sentry.io/api/0/issues/${encodeURIComponent(input.sentryIssueId)}/comments/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env().SENTRY_API_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ text: input.body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sentry comment ${res.status}: ${text.slice(0, 200)}`);
  }
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/sentry-comment.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/sentry/comment.ts tests/unit/sentry-comment.test.ts
git commit -m "feat(sentry): comment poster"
```

---

## Task 29: Run persistence

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/runs/persist.ts`

- [ ] **Step 1: Write `src/runs/persist.ts`**

```ts
// src/runs/persist.ts
import { db } from "../db/client.js";

export type CreateRunInput = { alertId: string; status: "triaging" };

export async function createRun(input: CreateRunInput): Promise<string> {
  const r = await db().query(
    "INSERT INTO runs (alert_id, status) VALUES ($1,$2) RETURNING id",
    [input.alertId, input.status],
  );
  return r.rows[0].id;
}

export type RunUpdate = {
  status?: string;
  severity?: string;
  triageSummary?: string;
  suspectedFiles?: string[];
  stackTrace?: string;
  agentSummary?: string | null;
  agentConfidence?: string | null;
  agentRisk?: string | null;
  testPassed?: boolean;
  repo?: string;
  branch?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costCents?: number;
  logS3?: string;
  error?: string;
  endedAt?: Date | null;
};

const FIELD_MAP: Record<keyof RunUpdate, string> = {
  status: "status",
  severity: "severity",
  triageSummary: "triage_summary",
  suspectedFiles: "suspected_files",
  stackTrace: "stack_trace",
  agentSummary: "agent_summary",
  agentConfidence: "agent_confidence",
  agentRisk: "agent_risk",
  testPassed: "test_passed",
  repo: "repo",
  branch: "branch",
  tokensInput: "tokens_input",
  tokensOutput: "tokens_output",
  costCents: "cost_cents",
  logS3: "log_s3",
  error: "error",
  endedAt: "ended_at",
};

export async function updateRun(runId: string, patch: RunUpdate): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [runId];
  let i = 2;
  for (const [k, v] of Object.entries(patch) as Array<[keyof RunUpdate, unknown]>) {
    if (v === undefined) continue;
    const col = FIELD_MAP[k];
    if (!col) continue;
    if (k === "suspectedFiles") {
      sets.push(`${col} = $${i}::jsonb`);
      params.push(JSON.stringify(v));
    } else {
      sets.push(`${col} = $${i}`);
      params.push(v);
    }
    i += 1;
  }
  if (sets.length === 0) return;
  await db().query(`UPDATE runs SET ${sets.join(", ")} WHERE id = $1`, params);
}

export type RunRow = {
  id: string;
  alert_id: string;
  repo: string | null;
  branch: string | null;
  status: string;
  severity: string | null;
  triage_summary: string | null;
  suspected_files: string[] | null;
  stack_trace: string | null;
};

export async function getRun(runId: string): Promise<RunRow | null> {
  const r = await db().query(
    `SELECT id, alert_id, repo, branch, status, severity,
            triage_summary, suspected_files, stack_trace
       FROM runs WHERE id = $1`,
    [runId],
  );
  return r.rows[0] ?? null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/runs/persist.ts
git commit -m "feat(runs): persist + getRun"
```

---

## Task 30: Budget enforcement

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/budget/enforce.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/budget.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/budget.test.ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { checkBudget, recordBudgetSpend } from "../../src/budget/enforce.js";

beforeEach(async () => { await setupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

const repo = "acme/api";

describe("budget", () => {
  it("allows under cap", async () => {
    const out = await checkBudget({ repo, capTokens: 1000, capCostCents: 100 });
    expect(out.allowed).toBe(true);
    if (out.allowed) expect(out.tokensRemaining).toBe(1000);
  });
  it("blocks when tokens exhausted", async () => {
    await recordBudgetSpend({ repo, tokens: 1000, costCents: 50, capTokens: 1000, capCostCents: 100 });
    const out = await checkBudget({ repo, capTokens: 1000, capCostCents: 100 });
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toBe("tokens_exhausted");
  });
  it("blocks when cost cap exhausted", async () => {
    await recordBudgetSpend({ repo, tokens: 100, costCents: 100, capTokens: 1000, capCostCents: 100 });
    const out = await checkBudget({ repo, capTokens: 1000, capCostCents: 100 });
    expect(out.allowed).toBe(false);
    if (!out.allowed) expect(out.reason).toBe("cost_exhausted");
  });
  it("accumulates", async () => {
    await recordBudgetSpend({ repo, tokens: 100, costCents: 10, capTokens: 1000, capCostCents: 100 });
    await recordBudgetSpend({ repo, tokens: 200, costCents: 20, capTokens: 1000, capCostCents: 100 });
    const r = await db().query("SELECT tokens_used, cost_cents FROM budgets WHERE repo=$1", [repo]);
    expect(r.rows[0].tokens_used).toBe(300);
    expect(r.rows[0].cost_cents).toBe(30);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/budget.test.ts`

- [ ] **Step 3: Implement `src/budget/enforce.ts`**

```ts
// src/budget/enforce.ts
import { db } from "../db/client.js";

export type BudgetCheckInput = { repo: string; capTokens: number; capCostCents: number };
export type BudgetCheckResult =
  | { allowed: true; tokensRemaining: number; costRemainingCents: number }
  | { allowed: false; reason: "tokens_exhausted" | "cost_exhausted" };

function utcDateString(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export async function checkBudget(input: BudgetCheckInput): Promise<BudgetCheckResult> {
  const date = utcDateString();
  const r = await db().query(
    `SELECT tokens_used, cost_cents FROM budgets WHERE repo = $1 AND date = $2`,
    [input.repo, date],
  );
  const used = r.rows[0] ?? { tokens_used: 0, cost_cents: 0 };
  if (used.tokens_used >= input.capTokens) return { allowed: false, reason: "tokens_exhausted" };
  if (used.cost_cents >= input.capCostCents) return { allowed: false, reason: "cost_exhausted" };
  return {
    allowed: true,
    tokensRemaining: input.capTokens - used.tokens_used,
    costRemainingCents: input.capCostCents - used.cost_cents,
  };
}

export type BudgetSpendInput = {
  repo: string;
  tokens: number;
  costCents: number;
  capTokens: number;
  capCostCents: number;
};

export async function recordBudgetSpend(input: BudgetSpendInput): Promise<void> {
  const date = utcDateString();
  await db().query(
    `INSERT INTO budgets (repo, date, tokens_used, cost_cents, cap_tokens, cap_cost_cents)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (repo, date) DO UPDATE
       SET tokens_used = budgets.tokens_used + EXCLUDED.tokens_used,
           cost_cents  = budgets.cost_cents  + EXCLUDED.cost_cents,
           cap_tokens     = EXCLUDED.cap_tokens,
           cap_cost_cents = EXCLUDED.cap_cost_cents`,
    [input.repo, date, input.tokens, input.costCents, input.capTokens, input.capCostCents],
  );
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/budget.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/budget/enforce.ts tests/unit/budget.test.ts
git commit -m "feat(budget): per-repo daily cap"
```

---

## Task 31: GitHub App auth

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/github/app-auth.ts`

- [ ] **Step 1: Write `src/github/app-auth.ts`**

```ts
// src/github/app-auth.ts
import { readFile } from "node:fs/promises";
import { createAppAuth } from "@octokit/auth-app";
import { env } from "../env.js";

type CachedToken = { token: string; expiresAt: number };
let cached: CachedToken | null = null;

async function loadPrivateKey(): Promise<string> {
  return await readFile(env().GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
}

export async function getInstallationToken(): Promise<string> {
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;
  const privateKey = await loadPrivateKey();
  const auth = createAppAuth({
    appId: env().GITHUB_APP_ID,
    privateKey,
    installationId: env().GITHUB_APP_INSTALLATION_ID,
  });
  const installation = await auth({ type: "installation" });
  const token = (installation as { token: string }).token;
  const expiresAt = new Date((installation as { expiresAt: string }).expiresAt).getTime();
  cached = { token, expiresAt };
  return token;
}

export function __resetForTest(): void { cached = null; }
```

- [ ] **Step 2: Commit**

```bash
git add src/github/app-auth.ts
git commit -m "feat(github): app installation token (cached)"
```

---

## Task 32: Workspace clone / branch / cleanup

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/agent/workspace.ts`

- [ ] **Step 1: Write `src/agent/workspace.ts`**

```ts
// src/agent/workspace.ts
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { env } from "../env.js";
import { log } from "../log.js";
import { getInstallationToken } from "../github/app-auth.js";

export type WorkspaceHandle = {
  dir: string;
  branch: string;
  cleanup: () => Promise<void>;
};

export type CreateWorkspaceInput = {
  runId: string;
  repo: string;
  defaultBranch: string;
  branch: string;
};

export async function createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceHandle> {
  await mkdir(env().WORK_DIR, { recursive: true });
  const dir = join(env().WORK_DIR, input.runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const token = await getInstallationToken();
  const url = `https://x-access-token:${token}@github.com/${input.repo}.git`;

  log.info({ runId: input.runId, repo: input.repo, dir }, "cloning");
  await execa("git", ["clone", "--depth", "50", url, dir], { stdio: "inherit" });
  await execa("git", ["-C", dir, "checkout", input.defaultBranch], { stdio: "inherit" });
  await execa("git", ["-C", dir, "checkout", "-b", input.branch], { stdio: "inherit" });
  await execa("git", ["-C", dir, "config", "user.name", "sentry-fixer-bot"], { stdio: "inherit" });
  await execa("git", ["-C", dir, "config", "user.email", "bot@sentry-fixer.local"], { stdio: "inherit" });

  return {
    dir,
    branch: input.branch,
    cleanup: async () => {
      try { await rm(dir, { recursive: true, force: true }); }
      catch (err) { log.warn({ err, dir }, "workspace cleanup failed"); }
    },
  };
}

export function makeBranchName(shortId: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const safe = shortId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  return `sentry-fix/${safe}-${ts}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/workspace.ts
git commit -m "feat(agent): workspace clone/branch/cleanup"
```

---

## Task 33: Agent prompt builder

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/agent/prompt.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/prompt.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/prompt.test.ts
import { describe, it, expect } from "bun:test";
import { buildAgentPrompt } from "../../src/agent/prompt.js";

describe("buildAgentPrompt", () => {
  it("includes alert info, stack, and test command", () => {
    const out = buildAgentPrompt({
      repo: "acme/api",
      alertTitle: "TypeError: cannot read 'x' of undefined",
      level: "error",
      sentryShortId: "PROJ-1A",
      sentryUrl: "https://sentry.io/issue/123",
      stackTrace: "at foo (src/a.ts:10:5)",
      severity: "high",
      triageSummary: "null deref in handler",
      suspectedFiles: ["src/a.ts"],
      testCommand: "pnpm test --run",
    });
    expect(out).toContain("TypeError");
    expect(out).toContain("src/a.ts:10:5");
    expect(out).toContain("pnpm test --run");
    expect(out).toContain("HARD RULES");
    expect(out).toContain("## Summary");
    expect(out).toContain("## Confidence");
    expect(out).toContain("## Risk");
  });
  it("strips control chars from stack", () => {
    const out = buildAgentPrompt({
      repo: "r", alertTitle: "t", level: "error",
      sentryShortId: "S-1", sentryUrl: "https://x",
      stackTrace: "frame\x00with\x07null",
      severity: "low", triageSummary: "s",
      suspectedFiles: [], testCommand: "true",
    });
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("\x07");
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/prompt.test.ts`

- [ ] **Step 3: Implement `src/agent/prompt.ts`**

```ts
// src/agent/prompt.ts
export type PromptInput = {
  repo: string;
  alertTitle: string;
  level: string;
  sentryShortId: string;
  sentryUrl: string;
  stackTrace: string;
  severity: string;
  triageSummary: string;
  suspectedFiles: string[];
  testCommand: string;
};

function stripControl(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

export function buildAgentPrompt(i: PromptInput): string {
  const stack = stripControl(i.stackTrace).slice(0, 8000);
  const title = stripControl(i.alertTitle);
  const summary = stripControl(i.triageSummary);
  const suspected = i.suspectedFiles.length
    ? i.suspectedFiles.map((f) => `  - ${f}`).join("\n")
    : "  (none — search the repo yourself)";

  return `You are sentry-fixer-bot, an automated SRE agent. You are running inside a git
worktree of ${i.repo}. The branch is already created and you are on it.

Your job is to investigate this Sentry alert and write a minimal correct fix.

HARD RULES:
- Only modify files needed to fix this specific error.
- Do NOT refactor unrelated code.
- Do NOT add new dependencies.
- Do NOT change build, lint, CI, or dependency configuration.
- Write or update at least one test that fails before your change and passes after.
- Run \`${i.testCommand}\` before claiming the fix is complete.
- If you cannot identify a fix with reasonable confidence, write SENTRY_TRIAGE.md
  with your analysis and exit. Do not guess.

When done, emit a final block in this exact form (do NOT wrap in code fences):

## Summary
<one paragraph: what you changed and why>
## Confidence
<high | medium | low>
## Risk
<one paragraph: what could break>

---

Sentry alert:
  Project: ${i.repo}
  Issue: ${i.sentryShortId}  ${i.sentryUrl}
  Title: ${title}
  Level: ${i.level}

Triage classification (from a smaller model — treat as hint not authority):
  Severity: ${i.severity}
  Summary: ${summary}
  Suspected files:
${suspected}

Stack trace:
\`\`\`
${stack}
\`\`\`

You have these tools: Read, Glob, Grep, Edit, Write, Bash. The test command is:
\`${i.testCommand}\`.

Go.`;
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/prompt.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt.ts tests/unit/prompt.test.ts
git commit -m "feat(agent): prompt builder"
```

---

## Task 34: Claude Code spawn

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/agent/spawn.ts`

- [ ] **Step 1: Write `src/agent/spawn.ts`**

```ts
// src/agent/spawn.ts
import { execa } from "execa";
import { env } from "../env.js";
import { log } from "../log.js";

export type SpawnInput = { cwd: string; prompt: string };
export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export async function spawnClaudeAgent(input: SpawnInput): Promise<SpawnResult> {
  const args = [
    "--print",
    "--dangerously-skip-permissions",
    "--model", env().CLAUDE_MODEL,
    "--append-system-prompt", input.prompt,
  ];
  log.info({ cwd: input.cwd, model: env().CLAUDE_MODEL }, "spawning claude");

  const start = Date.now();
  try {
    const result = await execa(env().CLAUDE_BIN, args, {
      cwd: input.cwd,
      timeout: env().AGENT_TIMEOUT_SECONDS * 1000,
      env: { ...process.env, ANTHROPIC_API_KEY: env().ANTHROPIC_API_KEY },
      reject: false,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      timedOut: result.timedOut ?? false,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; timedOut?: boolean };
    return {
      exitCode: e.exitCode ?? null,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      timedOut: e.timedOut ?? false,
      durationMs: Date.now() - start,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/spawn.ts
git commit -m "feat(agent): claude code spawn"
```

---

## Task 35: Output parser

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/agent/parse-output.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/parse-output.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/parse-output.test.ts
import { describe, it, expect } from "bun:test";
import { parseAgentOutput } from "../../src/agent/parse-output.js";

describe("parseAgentOutput", () => {
  it("extracts blocks", () => {
    const out = parseAgentOutput(`
noise

## Summary
Fixed null deref.
## Confidence
high
## Risk
Callers may rely on the thrown error.
`);
    expect(out).toEqual({
      summary: "Fixed null deref.",
      confidence: "high",
      risk: "Callers may rely on the thrown error.",
    });
  });
  it("returns nulls when missing", () => {
    const out = parseAgentOutput("plain text");
    expect(out.summary).toBeNull();
    expect(out.confidence).toBeNull();
    expect(out.risk).toBeNull();
  });
  it("normalises confidence", () => {
    const out = parseAgentOutput(`## Summary\nX\n## Confidence\nHIGH\n## Risk\nY`);
    expect(out.confidence).toBe("high");
  });
  it("rejects unknown confidence", () => {
    const out = parseAgentOutput(`## Summary\nX\n## Confidence\nmaybe\n## Risk\nY`);
    expect(out.confidence).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/parse-output.test.ts`

- [ ] **Step 3: Implement `src/agent/parse-output.ts`**

```ts
// src/agent/parse-output.ts
export type ParsedAgentOutput = {
  summary: string | null;
  confidence: "high" | "medium" | "low" | null;
  risk: string | null;
};

const SECTION = /^##\s+(Summary|Confidence|Risk)\s*$/m;

function extractBlock(text: string, name: "Summary" | "Confidence" | "Risk"): string | null {
  const re = new RegExp(
    `^##\\s+${name}\\s*$([\\s\\S]*?)(?=^##\\s+(?:Summary|Confidence|Risk)\\s*$|\\Z)`,
    "m",
  );
  const m = text.match(re);
  if (!m || !m[1]) return null;
  const body = m[1].trim();
  return body.length ? body : null;
}

export function parseAgentOutput(stdout: string): ParsedAgentOutput {
  if (!SECTION.test(stdout)) return { summary: null, confidence: null, risk: null };
  const summary = extractBlock(stdout, "Summary");
  const risk = extractBlock(stdout, "Risk");
  const confRaw = extractBlock(stdout, "Confidence");
  let confidence: ParsedAgentOutput["confidence"] = null;
  if (confRaw) {
    const c = confRaw.toLowerCase();
    if (c === "high" || c === "medium" || c === "low") confidence = c;
  }
  return { summary, confidence, risk };
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/parse-output.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/parse-output.ts tests/unit/parse-output.test.ts
git commit -m "feat(agent): output parser"
```

---

## Task 36: Pre-push secret scan

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/agent/secret-scan.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/secret-scan.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/secret-scan.test.ts
import { describe, it, expect } from "bun:test";
import { scanFilesForSecrets } from "../../src/agent/secret-scan.js";

describe("scanFilesForSecrets", () => {
  it("flags .env", () => { expect(scanFilesForSecrets(["src/x.ts", ".env"])).toContain(".env"); });
  it("flags pem", () => { expect(scanFilesForSecrets(["a/key.pem"])).toContain("a/key.pem"); });
  it("flags id_rsa", () => { expect(scanFilesForSecrets(["secrets/id_rsa"])).toContain("secrets/id_rsa"); });
  it("allows normal files", () => { expect(scanFilesForSecrets(["src/i.ts", "x.test.ts"])).toEqual([]); });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/unit/secret-scan.test.ts`

- [ ] **Step 3: Implement `src/agent/secret-scan.ts`**

```ts
// src/agent/secret-scan.ts
const DENY = [
  /^\.env(\..+)?$/,
  /(^|\/)\.env(\..+)?$/,
  /(^|\/)id_rsa$/,
  /(^|\/)id_ed25519$/,
  /\.pem$/,
  /\.pfx$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)secrets\//,
];

export function scanFilesForSecrets(files: string[]): string[] {
  return files.filter((f) => DENY.some((re) => re.test(f)));
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/unit/secret-scan.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/secret-scan.ts tests/unit/secret-scan.test.ts
git commit -m "feat(agent): pre-push secret scan"
```

---

## Task 37: Test gate

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/gate/run-tests.ts`

- [ ] **Step 1: Write `src/gate/run-tests.ts`**

```ts
// src/gate/run-tests.ts
import { execa } from "execa";
import { log } from "../log.js";

export type RunTestsInput = { cwd: string; command: string; timeoutSeconds: number };
export type RunTestsResult = {
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runTests(input: RunTestsInput): Promise<RunTestsResult> {
  log.info({ cwd: input.cwd, command: input.command }, "running tests");
  const start = Date.now();
  try {
    const res = await execa(input.command, {
      cwd: input.cwd,
      shell: true,
      timeout: input.timeoutSeconds * 1000,
      reject: false,
    });
    return {
      passed: res.exitCode === 0,
      exitCode: res.exitCode,
      stdout: (res.stdout ?? "").slice(-4000),
      stderr: (res.stderr ?? "").slice(-4000),
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string };
    return {
      passed: false,
      exitCode: e.exitCode ?? null,
      stdout: (e.stdout ?? "").slice(-4000),
      stderr: (e.stderr ?? "").slice(-4000),
      durationMs: Date.now() - start,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/gate/run-tests.ts
git commit -m "feat(gate): test runner"
```

---

## Task 38: Commit / push / open PR

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/github/pr.ts`

- [ ] **Step 1: Write `src/github/pr.ts`**

```ts
// src/github/pr.ts
import { execa } from "execa";
import { db } from "../db/client.js";
import { log } from "../log.js";
import { getInstallationToken } from "./app-auth.js";

export type CommitAndPushInput = { cwd: string; branch: string; commitMessage: string };

export async function commitAndPush(input: CommitAndPushInput): Promise<{ pushed: boolean }> {
  const diff = await execa("git", ["-C", input.cwd, "status", "--porcelain"]);
  if (!diff.stdout.trim()) {
    log.warn({ cwd: input.cwd }, "no changes to commit");
    return { pushed: false };
  }
  await execa("git", ["-C", input.cwd, "add", "-A"], { stdio: "inherit" });
  await execa("git", ["-C", input.cwd, "commit", "-m", input.commitMessage], { stdio: "inherit" });
  await execa("git", ["-C", input.cwd, "push", "-u", "origin", input.branch], { stdio: "inherit" });
  return { pushed: true };
}

export async function listChangedFiles(cwd: string): Promise<string[]> {
  const r = await execa("git", ["-C", cwd, "diff", "--name-only", "HEAD~1..HEAD"]);
  return r.stdout.split("\n").filter(Boolean);
}

export type OpenPrInput = {
  cwd: string;
  repo: string;
  title: string;
  body: string;
  base: string;
  head: string;
  draft: boolean;
  reviewers: string[];
};
export type OpenPrResult = { number: number; url: string };

function parsePrOutput(stdout: string): OpenPrResult {
  const url = stdout.trim().split("\n").pop() ?? "";
  const m = url.match(/\/pull\/(\d+)$/);
  if (!m) throw new Error(`could not parse PR url from: ${stdout}`);
  return { number: Number(m[1]), url };
}

export async function openPr(input: OpenPrInput): Promise<OpenPrResult> {
  const token = await getInstallationToken();
  const args = [
    "pr", "create",
    "--title", input.title,
    "--body", input.body,
    "--base", input.base,
    "--head", input.head,
  ];
  if (input.draft) args.push("--draft");
  for (const r of input.reviewers) args.push("--reviewer", r);
  const result = await execa("gh", args, {
    cwd: input.cwd,
    env: { ...process.env, GH_TOKEN: token },
  });
  return parsePrOutput(result.stdout);
}

export async function persistPr(input: {
  alertId: string;
  runId: string;
  repo: string;
  number: number;
  url: string;
  isDraft: boolean;
  needsHuman: boolean;
}): Promise<string> {
  const r = await db().query(
    `INSERT INTO prs (alert_id, run_id, repo, number, url, is_draft, needs_human)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.alertId, input.runId, input.repo, input.number, input.url, input.isDraft, input.needsHuman],
  );
  return r.rows[0].id;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/github/pr.ts
git commit -m "feat(github): commit/push/openPr/persistPr"
```

---

## Task 39: Agent job orchestrator

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/worker/agent-job.ts`

- [ ] **Step 1: Write `src/worker/agent-job.ts`**

```ts
// src/worker/agent-job.ts
import { log } from "../log.js";
import { db } from "../db/client.js";
import { env } from "../env.js";
import { getRun, updateRun } from "../runs/persist.js";
import { repoForProject, severityAtLeast, type SeverityValue } from "../config/repos.js";
import { checkBudget, recordBudgetSpend } from "../budget/enforce.js";
import { createWorkspace as createWorkspaceFn, makeBranchName } from "../agent/workspace.js";
import { buildAgentPrompt } from "../agent/prompt.js";
import { spawnClaudeAgent } from "../agent/spawn.js";
import { parseAgentOutput } from "../agent/parse-output.js";
import { scanFilesForSecrets } from "../agent/secret-scan.js";
import { runTests as runTestsFn } from "../gate/run-tests.js";
import { commitAndPush, listChangedFiles, openPr, persistPr } from "../github/pr.js";
import { archiveRunLog } from "../archive/s3.js";
import { postTriageComment } from "../sentry/comment.js";

// Conservative MVP cost estimate (revisit when token reporting is plumbed):
// roughly $0.02 / second of wall time.
const COST_PER_SECOND_CENTS = 2;

export type AgentJobDeps = {
  createWorkspace?: typeof createWorkspaceFn;
  runTests?: typeof runTestsFn;
};

export async function handleAgentJob(
  payload: { runId: string },
  deps: AgentJobDeps = {},
): Promise<void> {
  const createWorkspace = deps.createWorkspace ?? createWorkspaceFn;
  const runTests = deps.runTests ?? runTestsFn;

  const run = await getRun(payload.runId);
  if (!run) throw new Error(`run not found: ${payload.runId}`);
  if (!run.severity) throw new Error(`run ${payload.runId} has no severity`);

  const alertRes = await db().query(
    `SELECT id, sentry_issue_id, sentry_project, title, level
       FROM alerts WHERE id = $1`,
    [run.alert_id],
  );
  const alert = alertRes.rows[0];
  if (!alert) throw new Error(`alert ${run.alert_id} missing`);

  const repoCfg = await repoForProject(alert.sentry_project);
  if (!repoCfg) {
    await updateRun(payload.runId, {
      status: "agent_failed",
      error: `no repos.yaml entry for project ${alert.sentry_project}`,
      endedAt: new Date(),
    });
    return;
  }

  if (!severityAtLeast(run.severity as SeverityValue, repoCfg.min_severity_to_fix)) {
    await updateRun(payload.runId, {
      status: "agent_done",
      agentSummary: "skipped: below min_severity_to_fix",
      endedAt: new Date(),
    });
    return;
  }

  const budget = await checkBudget({
    repo: repoCfg.github,
    capTokens: repoCfg.daily_token_cap,
    capCostCents: repoCfg.daily_cost_cap_cents,
  });
  if (!budget.allowed) {
    await updateRun(payload.runId, {
      status: "budget_blocked",
      error: budget.reason,
      endedAt: new Date(),
    });
    await postTriageComment({
      sentryIssueId: alert.sentry_issue_id,
      body: `🤖 sentry-fixer-bot: budget exhausted for ${repoCfg.github} (${budget.reason}). Skipping fix today.`,
    });
    return;
  }

  const branch = makeBranchName(alert.sentry_issue_id);
  await updateRun(payload.runId, {
    status: "agent_running",
    repo: repoCfg.github,
    branch,
  });

  const ws = await createWorkspace({
    runId: payload.runId,
    repo: repoCfg.github,
    defaultBranch: repoCfg.default_branch,
    branch,
  });

  let logText = "";
  try {
    const prompt = buildAgentPrompt({
      repo: repoCfg.github,
      alertTitle: alert.title,
      level: alert.level,
      sentryShortId: alert.sentry_issue_id,
      sentryUrl: `https://sentry.io/organizations/${env().SENTRY_ORG_SLUG}/issues/${alert.sentry_issue_id}/`,
      stackTrace: run.stack_trace ?? "(stack trace not captured in triage)",
      severity: run.severity as string,
      triageSummary: run.triage_summary ?? "",
      suspectedFiles: Array.isArray(run.suspected_files) ? run.suspected_files : [],
      testCommand: repoCfg.test_command,
    });

    const spawned = await spawnClaudeAgent({ cwd: ws.dir, prompt });
    logText = `=== STDOUT ===\n${spawned.stdout}\n=== STDERR ===\n${spawned.stderr}\n`;
    if (spawned.timedOut) throw new Error("agent timed out");
    if (spawned.exitCode !== 0) throw new Error(`agent exit ${spawned.exitCode}`);

    const parsed = parseAgentOutput(spawned.stdout);
    const costCents = Math.round((spawned.durationMs / 1000) * COST_PER_SECOND_CENTS);

    await updateRun(payload.runId, {
      agentSummary: parsed.summary,
      agentConfidence: parsed.confidence,
      agentRisk: parsed.risk,
      costCents,
    });
    await recordBudgetSpend({
      repo: repoCfg.github,
      tokens: 0,
      costCents,
      capTokens: repoCfg.daily_token_cap,
      capCostCents: repoCfg.daily_cost_cap_cents,
    });

    const test = await runTests({
      cwd: ws.dir,
      command: repoCfg.test_command,
      timeoutSeconds: 600,
    });
    logText += `\n=== TEST STDOUT ===\n${test.stdout}\n=== TEST STDERR ===\n${test.stderr}\n`;
    await updateRun(payload.runId, { testPassed: test.passed });

    const commitMsg = `fix: ${alert.title} (sentry ${alert.sentry_issue_id})`;
    const commit = await commitAndPush({ cwd: ws.dir, branch: ws.branch, commitMessage: commitMsg });

    if (!commit.pushed) {
      await updateRun(payload.runId, {
        status: "agent_done",
        agentSummary: parsed.summary ?? "agent made no changes",
        endedAt: new Date(),
      });
      await postTriageComment({
        sentryIssueId: alert.sentry_issue_id,
        body: `🤖 sentry-fixer-bot: agent ran but made no code changes.\n\n${parsed.summary ?? ""}`,
      });
      return;
    }

    const changed = await listChangedFiles(ws.dir);
    const flagged = scanFilesForSecrets(changed);
    if (flagged.length) throw new Error(`secret-scan rejected files: ${flagged.join(", ")}`);

    const prTitle = `[sentry-fix] ${alert.sentry_issue_id}: ${alert.title}`.slice(0, 160);
    const prBody = buildPrBody({
      sentryShortId: alert.sentry_issue_id,
      sentryUrl: `https://sentry.io/organizations/${env().SENTRY_ORG_SLUG}/issues/${alert.sentry_issue_id}/`,
      severity: run.severity as string,
      confidence: parsed.confidence ?? "unknown",
      summary: parsed.summary ?? "(agent did not provide a summary)",
      risk: parsed.risk ?? "(agent did not provide a risk note)",
      testCommand: repoCfg.test_command,
      testPassed: test.passed,
      runId: payload.runId,
      model: env().CLAUDE_MODEL,
      costCents,
    });

    const pr = await openPr({
      cwd: ws.dir,
      repo: repoCfg.github,
      title: prTitle,
      body: prBody,
      base: repoCfg.default_branch,
      head: ws.branch,
      draft: !test.passed,
      reviewers: repoCfg.pr_reviewers,
    });

    await persistPr({
      alertId: alert.id,
      runId: payload.runId,
      repo: repoCfg.github,
      number: pr.number,
      url: pr.url,
      isDraft: !test.passed,
      needsHuman: !test.passed,
    });
    await updateRun(payload.runId, { status: "pr_opened", endedAt: new Date() });
    await postTriageComment({
      sentryIssueId: alert.sentry_issue_id,
      body: `🤖 sentry-fixer-bot opened ${test.passed ? "PR" : "DRAFT PR"} (tests ${test.passed ? "passing" : "failed"}): ${pr.url}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err, runId: payload.runId }, "agent job failed");
    await updateRun(payload.runId, { status: "agent_failed", error: msg, endedAt: new Date() });
    throw err;
  } finally {
    try {
      const logUrl = await archiveRunLog({ runId: payload.runId, body: logText });
      await updateRun(payload.runId, { logS3: logUrl });
    } catch (err) {
      log.error({ err, runId: payload.runId }, "failed to archive run log");
    }
    await ws.cleanup();
  }
}

function buildPrBody(i: {
  sentryShortId: string;
  sentryUrl: string;
  severity: string;
  confidence: string;
  summary: string;
  risk: string;
  testCommand: string;
  testPassed: boolean;
  runId: string;
  model: string;
  costCents: number;
}): string {
  return [
    "## 🤖 sentry-fixer-bot",
    "",
    `**Sentry issue:** [${i.sentryShortId}](${i.sentryUrl})`,
    `**Severity:** ${i.severity}`,
    `**Confidence:** ${i.confidence}`,
    "",
    "### Summary",
    i.summary,
    "",
    "### Risk",
    i.risk,
    "",
    "### Test status",
    `- Command: \`${i.testCommand}\``,
    `- Result: ${i.testPassed ? "✅ passing" : "⚠️ FAILED — opened as DRAFT"}`,
    "",
    "### Audit",
    `- Run ID: \`${i.runId}\``,
    `- Model: \`${i.model}\``,
    `- Estimated cost: \`$${(i.costCents / 100).toFixed(2)}\``,
    "",
    "---",
    "This PR was generated by sentry-fixer-bot. **Always human-review before merging.** This bot will never merge its own PRs.",
  ].join("\n");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/worker/agent-job.ts
git commit -m "feat(worker): agent orchestrator (clone→fix→test→PR)"
```

---

## Task 40: Worker entry (register both jobs)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/worker/index.ts`

- [ ] **Step 1: Write `src/worker/index.ts`**

```ts
// src/worker/index.ts
import { onTriage, onAgent } from "../queue/jobs.js";
import { handleTriageJob } from "./triage-job.js";
import { handleAgentJob } from "./agent-job.js";
import { log } from "../log.js";

export async function startWorker(): Promise<void> {
  await onTriage(async (payload) => { await handleTriageJob(payload); });
  await onAgent(async (payload) => { await handleAgentJob(payload); });
  log.info("worker registered triage + agent handlers");
}
```

- [ ] **Step 2: Commit**

```bash
git add src/worker/index.ts
git commit -m "feat(worker): register handlers"
```

---

## Task 41: Triage job (enqueues agent)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/worker/triage-job.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/triage-job.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/triage-job.test.ts
import { describe, it, expect, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { upsertAlert } from "../../src/alerts/persist.js";
import { handleTriageJob } from "../../src/worker/triage-job.js";

beforeEach(async () => { await setupTestDb(); });
afterAll(async () => { await teardownTestDb(); });

describe("handleTriageJob", () => {
  it("runs full triage, posts comment, enqueues agent", async () => {
    const alert = await upsertAlert({
      sentryIssueId: "1234", sentryProject: "p", fingerprint: "f",
      codeVersion: null, dedupKey: "k", title: "boom", level: "error",
      firstSeenAt: new Date(), lastSeenAt: new Date(),
      rawPayloadS3: "s3://x",
    });
    const fetchEvent = mock(async () => ({ eventID: "e", entries: [], tags: [] }));
    const classifier = mock(async () => ({
      severity: "high" as const, summary: "null deref",
      suspectedFiles: ["src/a.ts"], confidence: 0.9,
      tokensIn: 500, tokensOut: 100,
    }));
    const postComment = mock(async () => {});
    const enqueueAgent = mock(async (_runId: string) => "job-id");

    await handleTriageJob(
      { alertId: alert.id },
      { fetchEvent, classifier, postComment, enqueueAgent },
    );

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(enqueueAgent).toHaveBeenCalledTimes(1);
    const r = await db().query("SELECT status, severity FROM runs WHERE alert_id=$1", [alert.id]);
    expect(r.rows[0].status).toBe("agent_pending");
    expect(r.rows[0].severity).toBe("high");
  });

  it("marks triage_failed and does not enqueue when classifier throws", async () => {
    const alert = await upsertAlert({
      sentryIssueId: "9", sentryProject: "p", fingerprint: "f",
      codeVersion: null, dedupKey: "k2", title: "x", level: "error",
      firstSeenAt: new Date(), lastSeenAt: new Date(), rawPayloadS3: "s3://x",
    });
    const fetchEvent = mock(async () => ({ eventID: "x", entries: [], tags: [] }));
    const classifier = mock(async () => { throw new Error("api down"); });
    const postComment = mock(async () => {});
    const enqueueAgent = mock(async () => "job");
    await expect(
      handleTriageJob({ alertId: alert.id }, { fetchEvent, classifier, postComment, enqueueAgent }),
    ).rejects.toThrow(/api down/);
    const r = await db().query("SELECT status, error FROM runs WHERE alert_id=$1", [alert.id]);
    expect(r.rows[0].status).toBe("triage_failed");
    expect(r.rows[0].error).toMatch(/api down/);
    expect(enqueueAgent).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

Run: `bun test tests/integration/triage-job.test.ts`

- [ ] **Step 3: Implement `src/worker/triage-job.ts`**

```ts
// src/worker/triage-job.ts
import { log } from "../log.js";
import { db } from "../db/client.js";
import { fetchLatestEvent, extractStackTrace } from "../sentry/client.js";
import { classify } from "../triage/classify.js";
import { postTriageComment } from "../sentry/comment.js";
import { createRun, updateRun } from "../runs/persist.js";
import { enqueueAgent as defaultEnqueueAgent } from "../queue/jobs.js";

const HAIKU_IN_CENTS_PER_1K = 0.1;
const HAIKU_OUT_CENTS_PER_1K = 0.5;

export type TriageJobDeps = {
  fetchEvent?: typeof fetchLatestEvent;
  classifier?: typeof classify;
  postComment?: typeof postTriageComment;
  enqueueAgent?: (runId: string) => Promise<string>;
};

export async function handleTriageJob(
  payload: { alertId: string },
  deps: TriageJobDeps = {},
): Promise<void> {
  const fetchEvent = deps.fetchEvent ?? fetchLatestEvent;
  const classifier = deps.classifier ?? classify;
  const postComment = deps.postComment ?? postTriageComment;
  const enqueueAgent = deps.enqueueAgent ?? defaultEnqueueAgent;

  const runId = await createRun({ alertId: payload.alertId, status: "triaging" });
  log.info({ runId, alertId: payload.alertId }, "triage start");

  const alertRes = await db().query(
    `SELECT sentry_issue_id, title, level FROM alerts WHERE id = $1`,
    [payload.alertId],
  );
  const alert = alertRes.rows[0];
  if (!alert) {
    await updateRun(runId, { status: "triage_failed", error: "alert not found", endedAt: new Date() });
    return;
  }

  let triage;
  let stack: string;
  try {
    const event = await fetchEvent(alert.sentry_issue_id);
    stack = extractStackTrace(event);
    triage = await classifier({
      alertTitle: alert.title,
      level: alert.level,
      stackTrace: stack,
      eventTags: Array.isArray(event.tags) ? event.tags : [],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateRun(runId, { status: "triage_failed", error: msg, endedAt: new Date() });
    throw err;
  }

  const costCents = Math.round(
    (triage.tokensIn / 1000) * HAIKU_IN_CENTS_PER_1K +
      (triage.tokensOut / 1000) * HAIKU_OUT_CENTS_PER_1K,
  );

  await updateRun(runId, {
    status: "agent_pending",
    severity: triage.severity,
    triageSummary: triage.summary,
    suspectedFiles: triage.suspectedFiles,
    stackTrace: stack,
    tokensInput: triage.tokensIn,
    tokensOutput: triage.tokensOut,
    costCents,
  });

  const commentBody = [
    "## 🤖 sentry-fixer-bot triage",
    "",
    `**Severity:** ${triage.severity}`,
    `**Confidence:** ${triage.confidence.toFixed(2)}`,
    `**Suspected files:**`,
    ...triage.suspectedFiles.map((f) => `- \`${f}\``),
    "",
    `**Summary:** ${triage.summary}`,
    "",
    `_Agent is investigating; a PR will follow if a fix is found._`,
  ].join("\n");

  await postComment({ sentryIssueId: alert.sentry_issue_id, body: commentBody });
  await enqueueAgent(runId);
  log.info({ runId, alertId: payload.alertId }, "triage done; agent enqueued");
}
```

- [ ] **Step 4: Run tests (PASS)**

Run: `bun test tests/integration/triage-job.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/worker/triage-job.ts tests/integration/triage-job.test.ts
git commit -m "feat(worker): triage → agent handoff"
```

---

## **Review checkpoint A — Triage path complete**

Verify before continuing:
- `bun test` all green
- DB has `alerts`, `runs`, `prs`, `budgets`, `pgboss` schema
- A webhook → DB alert → triage handler → comment → agent job enqueued

---

## Task 42: Process dispatcher

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/index.ts`

- [ ] **Step 1: Write `src/index.ts`**

```ts
// src/index.ts
import { createApp, startServer } from "./web/server.js";
import { mountHealth } from "./web/routes/health.js";
import { mountSentryWebhook } from "./web/routes/sentry-webhook.js";
import { startWorker } from "./worker/index.js";
import { stopBoss } from "./queue/boss.js";
import { closeDb } from "./db/client.js";
import { log } from "./log.js";

type Mode = "web" | "worker";

function parseMode(argv: string[]): Mode {
  const arg = argv[2];
  if (arg === "web" || arg === "worker") return arg;
  log.error({ argv }, "usage: bun src/index.ts <web|worker>");
  process.exit(2);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  if (mode === "web") {
    const app = createApp();
    mountHealth(app);
    mountSentryWebhook(app);
    const server = await startServer(app);
    process.on("SIGTERM", async () => {
      log.info("SIGTERM web");
      await server.close();
      await closeDb();
      process.exit(0);
    });
  } else {
    await startWorker();
    process.on("SIGTERM", async () => {
      log.info("SIGTERM worker");
      await stopBoss();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((err) => { log.error({ err }, "fatal"); process.exit(1); });
```

- [ ] **Step 2: Smoke-test both modes**

```bash
PORT=3000 DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb \
SENTRY_WEBHOOK_SECRET=test SENTRY_API_TOKEN=test SENTRY_ORG_SLUG=acme \
ANTHROPIC_API_KEY=test S3_BUCKET=sfb-archives-dev S3_REGION=us-east-1 \
GITHUB_APP_ID=1 GITHUB_APP_PRIVATE_KEY_PATH=./secrets/key.pem GITHUB_APP_INSTALLATION_ID=1 \
NODE_ENV=development bun run dev
```
In another terminal: `curl -sf http://localhost:3000/healthz` → `{"ok":true,"db":true}`.
Then: `bun run dev:worker` (same env) → log `worker registered triage + agent handlers`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: process dispatcher (web|worker)"
```

---

## Task 43: systemd units

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/systemd/sfb-web.service`
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/systemd/sfb-worker.service`

- [ ] **Step 1: Write `sfb-web.service`**

```ini
[Unit]
Description=sentry-fixer-bot web
After=network.target

[Service]
Type=simple
User=sfb-runner
WorkingDirectory=/opt/sfb/current
EnvironmentFile=/etc/sfb/env
ExecStart=/usr/local/bin/bun src/index.ts web
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sfb

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write `sfb-worker.service`**

```ini
[Unit]
Description=sentry-fixer-bot worker
After=network.target

[Service]
Type=simple
User=sfb-runner
WorkingDirectory=/opt/sfb/current
EnvironmentFile=/etc/sfb/env
ExecStart=/usr/local/bin/bun src/index.ts worker
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sfb /tmp

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Commit**

```bash
git add deploy/systemd/
git commit -m "deploy: systemd units"
```

---

## Task 44: nginx site config

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/nginx/sfb.conf`

- [ ] **Step 1: Write `sfb.conf`**

```nginx
limit_req_zone $binary_remote_addr zone=sfb_webhook:10m rate=100r/s;

server {
  listen 443 ssl http2;
  server_name sfb.example.com;

  ssl_certificate     /etc/letsencrypt/live/sfb.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sfb.example.com/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  client_max_body_size 1m;

  location /webhooks/sentry {
    limit_req zone=sfb_webhook burst=200 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
  }

  location /healthz {
    proxy_pass http://127.0.0.1:3000;
    access_log off;
  }

  location / { return 404; }
}

server {
  listen 80;
  server_name sfb.example.com;
  return 301 https://$host$request_uri;
}
```

- [ ] **Step 2: Commit**

```bash
git add deploy/nginx/sfb.conf
git commit -m "deploy: nginx TLS + rate limit"
```

---

## Task 44b: Postgres backup to S3 (daily systemd timer)

Because Postgres runs in docker-compose on the EC2 (no RDS snapshots), MVP needs an explicit backup story. One nightly `pg_dump` → S3, retain 30 days.

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/scripts/backup-db.sh`
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/systemd/sfb-backup.service`
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/systemd/sfb-backup.timer`

- [ ] **Step 1: Write `scripts/backup-db.sh`**

```bash
#!/usr/bin/env bash
# Daily Postgres backup → S3. Run via systemd timer on the EC2 host.
set -euo pipefail

: "${DATABASE_URL:?must be set}"
: "${S3_BUCKET:?must be set}"
: "${BACKUP_RETENTION_DAYS:=30}"

TS=$(date -u +%Y%m%dT%H%M%SZ)
TMP=$(mktemp -t sfb-backup-XXXXXX.sql.gz)
trap 'rm -f "$TMP"' EXIT

echo "dumping postgres → $TMP"
docker compose exec -T postgres pg_dump --no-owner --no-privileges \
  --dbname="$DATABASE_URL" \
  | gzip -9 > "$TMP"

KEY="db-backups/$(date -u +%Y/%m)/sfb-${TS}.sql.gz"
echo "uploading s3://$S3_BUCKET/$KEY"
aws s3 cp --no-progress "$TMP" "s3://$S3_BUCKET/$KEY" \
  --metadata "retention-days=$BACKUP_RETENTION_DAYS"

# Trim local list output; lifecycle policy on the bucket handles deletion
# (set: expiration $BACKUP_RETENTION_DAYS days on `db-backups/` prefix).
echo "backup complete: $KEY"
```

- [ ] **Step 2: Write `deploy/systemd/sfb-backup.service`**

```ini
[Unit]
Description=sentry-fixer-bot postgres backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/sfb/current
EnvironmentFile=/etc/sfb/env
ExecStart=/opt/sfb/current/scripts/backup-db.sh
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 3: Write `deploy/systemd/sfb-backup.timer`**

```ini
[Unit]
Description=Run sentry-fixer-bot postgres backup nightly

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
```

- [ ] **Step 4: Make executable**

```bash
chmod +x scripts/backup-db.sh
```

- [ ] **Step 5: Document the S3 lifecycle policy**

Apply this lifecycle policy to the `S3_BUCKET` (via Terraform/CDK/console — out of scope for code but called out for the deploy runbook):

```json
{
  "Rules": [
    {
      "ID": "expire-db-backups",
      "Status": "Enabled",
      "Filter": { "Prefix": "db-backups/" },
      "Expiration": { "Days": 30 }
    }
  ]
}
```

- [ ] **Step 6: Smoke-test backup script locally**

With docker-compose Postgres running:
```bash
export DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb
export S3_BUCKET=sfb-archives-dev
./scripts/backup-db.sh
```
Expected: log line `backup complete: db-backups/YYYY/MM/sfb-<ts>.sql.gz`. Verify in S3 console or via:
```bash
aws s3 ls s3://$S3_BUCKET/db-backups/ --recursive | tail -3
```

- [ ] **Step 7: Commit**

```bash
git add scripts/backup-db.sh deploy/systemd/sfb-backup.service deploy/systemd/sfb-backup.timer
git commit -m "deploy: nightly pg_dump backup to S3"
```

---

## Task 44c: EC2 AMI bootstrap (userdata.sh)

The EC2 instance running the bot needs the same binaries the local toolchain (Task 0) needs, plus Docker and the `sfb-runner` user. Capture this as an idempotent userdata script. Apply by either: (a) running it once via `ssh ubuntu@host bash < userdata.sh` on a fresh instance, or (b) baking an AMI with Packer that runs this at provision time. The bot itself never executes userdata; this is one-time host provisioning.

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/ec2/userdata.sh`
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/ec2/README.md`

- [ ] **Step 1: Write `deploy/ec2/userdata.sh`**

```bash
#!/usr/bin/env bash
# EC2 host bootstrap. Idempotent. Targets Ubuntu 24.04 LTS on x86_64 or arm64.
set -euo pipefail

# 1. Base packages
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release \
  git openssl jq unzip xxd \
  postgresql-client          # gives `pg_dump` for the local backup runner

# 2. Bun 1.x — replaces node + pnpm + tsx + vitest.
# Install system-wide at /usr/local so systemd units can ExecStart it via
# absolute path without needing per-user PATH.
if ! command -v bun >/dev/null 2>&1; then
  TMP=$(mktemp -d)
  curl -fsSL https://bun.sh/install -o "$TMP/install.sh"
  BUN_INSTALL=/usr/local bash "$TMP/install.sh"
  rm -rf "$TMP"
fi

# 3. Docker + compose v2 plugin (from Docker's apt repo)
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

# 4. GitHub CLI (from cli.github.com apt repo)
if ! command -v gh >/dev/null 2>&1; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) \
signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y
  apt-get install -y gh
fi

# 5. AWS CLI v2
if ! command -v aws >/dev/null 2>&1; then
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" ;;
    aarch64) AWS_URL="https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" ;;
    *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
  esac
  TMP=$(mktemp -d)
  curl -fsSL "$AWS_URL" -o "$TMP/awscli.zip"
  unzip -q "$TMP/awscli.zip" -d "$TMP"
  "$TMP/aws/install"
  rm -rf "$TMP"
fi

# 6. Claude Code CLI (vendored npm install)
if ! command -v claude >/dev/null 2>&1; then
  bun install -g @anthropic-ai/claude-code
fi

# 7. sfb-runner system user (low-priv, no shell login, no sudo)
if ! id sfb-runner >/dev/null 2>&1; then
  useradd --system --uid 4000 --shell /usr/sbin/nologin \
          --home-dir /var/lib/sfb --create-home sfb-runner
fi

# 8. Application directories
mkdir -p /opt/sfb /etc/sfb /var/lib/sfb/work /var/lib/sfb/logs
chown -R sfb-runner:sfb-runner /var/lib/sfb
chmod 0700 /etc/sfb

# 9. Verify
echo "--- versions ---"
docker --version
docker compose version
git --version
gh --version
claude --version
aws --version

# 10. Note for the operator
cat <<'EOM'
BOOTSTRAP COMPLETE.

Next steps (run as root or via your deploy pipeline):
  1. Sync /etc/sfb/env from AWS Secrets Manager (or scp it).
     Required keys: see .env.example in the repo.
  2. Drop /opt/sfb/current/ (the built dist + node_modules + scripts + repos.yaml).
  3. Place /etc/sfb/github-app.pem (GitHub App private key, mode 0400, owner sfb-runner).
  4. Place /opt/sfb/repos.yaml.
  5. Install systemd units:
       cp /opt/sfb/current/deploy/systemd/sfb-*.{service,timer} /etc/systemd/system/
       systemctl daemon-reload
       systemctl enable --now sfb-web.service sfb-worker.service sfb-backup.timer
  6. Install nginx site:
       cp /opt/sfb/current/deploy/nginx/sfb.conf /etc/nginx/sites-available/sfb.conf
       ln -sf /etc/nginx/sites-available/sfb.conf /etc/nginx/sites-enabled/sfb.conf
       certbot --nginx -d sfb.example.com
       systemctl reload nginx
  7. The bot does NOT run `gh auth login`. It uses GitHub App installation tokens
     minted in src/github/app-auth.ts and passed to `gh` via GH_TOKEN env per
     spawn. No personal gh credentials live on this box.
EOM
```

- [ ] **Step 2: Write `deploy/ec2/README.md`**

```markdown
# EC2 deploy

This bot runs on a single Ubuntu 24.04 EC2 (t3.medium baseline; resize as load demands).

## Provisioning

Option A — interactive:
```bash
ssh ubuntu@<host>
sudo bash < deploy/ec2/userdata.sh
```

Option B — userdata at launch:
1. Paste `userdata.sh` into the EC2 launch wizard's "User data" field, or
2. Bake an AMI with Packer using `userdata.sh` as the provisioner.

## What gets installed

- Bun 1.x (system-wide at /usr/local/bin/bun) — replaces node, pnpm, tsx, vitest
- Docker Engine + compose v2 plugin
- GitHub CLI (`gh`)
- AWS CLI v2
- Claude Code CLI (`claude`) via `bun install -g`
- `git`, `openssl`, `xxd`, `jq`, `postgresql-client`
- System user `sfb-runner` (uid 4000, nologin, no sudo)
- Directories: `/opt/sfb`, `/etc/sfb` (0700), `/var/lib/sfb/{work,logs}`

## What does NOT get installed

- Code (you push it to `/opt/sfb/current/` via your deploy script)
- `/etc/sfb/env` (synced from Secrets Manager or `scp`'d in by ops)
- GitHub App private key (placed at `/etc/sfb/github-app.pem`, mode 0400)
- `repos.yaml` (placed at `/opt/sfb/repos.yaml`, mode 0644)
- systemd unit files (copied at deploy time and `systemctl daemon-reload`'d)

## GitHub authentication

The bot does NOT use `gh auth login`. It mints **GitHub App installation tokens** via `@octokit/auth-app` (src/github/app-auth.ts) and passes them to `gh` via the `GH_TOKEN` environment variable per subprocess spawn (src/github/pr.ts). Consequences:

- No personal gh credentials live on the EC2.
- Rotating the GitHub App private key rotates **all** of the bot's GitHub access.
- The GitHub App must be installed on the target repos (org settings → Integrations → your App → Install).
- Scopes: `contents: write`, `pull_requests: write`, `metadata: read`. **Do not grant `admin`** — the bot's safety relies on being unable to merge.

## Network egress

Lock down `OUTPUT` chain so the EC2 can only reach:
- `api.anthropic.com`
- `api.github.com`, `github.com`
- `sentry.io`, `*.sentry.io`
- `registry.npmjs.org` (build only)
- `169.254.169.254` (EC2 metadata)
- `s3.amazonaws.com`

See `docs/architecture.md §1` for the full allowlist rationale.

## Postgres backup

`sfb-backup.timer` runs `scripts/backup-db.sh` nightly at 02:00 UTC.
The S3 bucket lifecycle policy expires backups after 30 days.

## Restoring from backup

```bash
LATEST=$(aws s3 ls s3://$S3_BUCKET/db-backups/ --recursive | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://$S3_BUCKET/$LATEST" - \
  | gunzip \
  | docker compose exec -T postgres psql -U sfb -d sfb
```
```

- [ ] **Step 3: Make executable**

```bash
chmod +x deploy/ec2/userdata.sh
```

- [ ] **Step 4: Smoke-test the script syntax**

```bash
bash -n deploy/ec2/userdata.sh
```
Expected: exit 0 (syntax-only check; does not run anything).

- [ ] **Step 5: Commit**

```bash
git add deploy/ec2/
git commit -m "deploy: EC2 userdata bootstrap (node, docker, gh, claude, aws cli, sfb-runner)"
```

---

## Task 45: Fake-alert seed script

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/scripts/seed-fake-alert.sh`

- [ ] **Step 1: Write `seed-fake-alert.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${SENTRY_WEBHOOK_SECRET:?must be set}"
: "${URL:=http://localhost:3000/webhooks/sentry}"
: "${SENTRY_ISSUE_ID:=777777}"
: "${SENTRY_PROJECT:=backend-api}"
: "${RELEASE:=v1.2.3}"

BODY=$(cat <<EOF
{
  "action": "issue.created",
  "data": {
    "issue": {
      "id": "${SENTRY_ISSUE_ID}",
      "shortId": "PROJ-7G",
      "project": { "slug": "${SENTRY_PROJECT}" },
      "title": "TypeError: cannot read property 'foo' of undefined",
      "level": "error",
      "firstSeen": "2026-05-15T10:00:00Z",
      "lastSeen": "2026-05-15T10:00:00Z",
      "metadata": { "fingerprint": "fake-fp-1" }
    },
    "release": { "version": "${RELEASE}" }
  },
  "installation": { "uuid": "00000000-0000-0000-0000-000000000000" }
}
EOF
)

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SENTRY_WEBHOOK_SECRET" -binary | xxd -p -c 256)

echo "POSTing to $URL with signature ${SIG:0:12}..."
curl -sS -X POST "$URL" \
  -H "content-type: application/json" \
  -H "sentry-hook-signature: $SIG" \
  --data "$BODY"
echo
```

- [ ] **Step 2: chmod + commit**

```bash
chmod +x scripts/seed-fake-alert.sh
git add scripts/seed-fake-alert.sh
git commit -m "scripts: fake sentry webhook seed"
```

---

## Task 46: End-to-end agent integration test

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/agent-job.test.ts`

This test exercises `handleAgentJob` end-to-end. It uses a temporary bare git repo on disk as the "remote", stub `claude` and `gh` binaries on `PATH`, and a mocked `createWorkspace` that clones from the local bare repo (no real GitHub App token needed).

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/agent-job.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, mock, spyOn } from "bun:test";
import { mkdtemp, writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { upsertAlert } from "../../src/alerts/persist.js";
import { createRun, updateRun } from "../../src/runs/persist.js";

mock.module("../../src/archive/s3.js", () => ({
  archiveSentryPayloadSafe: mock(async () => "s3://fake/payload"),
  archiveRunLog: mock(async () => "s3://fake/log"),
}));

mock.module("../../src/sentry/comment.js", () => ({
  postTriageComment: mock(async () => {}),
}));

mock.module("../../src/github/app-auth.js", () => ({
  getInstallationToken: mock(async () => "fake-installation-token"),
  __resetForTest: mock(),
}));

// Bun has no vi.importActual; load the real module before mocking, then spread it.
const _actualRepos = await import("../../src/config/repos.js");
mock.module("../../src/config/repos.js", () => ({
  ..._actualRepos,
  repoForProject: mock(),
}));

let bareRepo: string;
let workRoot: string;
let stubBin: string;
let configMod: typeof import("../../src/config/repos.js");

beforeAll(async () => {
  bareRepo = await mkdtemp(join(tmpdir(), "sfb-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "sfb-seed-"));
  await execa("git", ["init", "--bare", bareRepo]);
  await execa("git", ["init", seed]);
  await writeFile(join(seed, "README.md"), "# fixture\n");
  await writeFile(join(seed, "app.js"), "throw new Error('boom');\n");
  await writeFile(join(seed, "package.json"), JSON.stringify(
    { name: "fixture", scripts: { test: "echo ok" }, version: "0.0.0" }, null, 2,
  ));
  await execa("git", ["-C", seed, "add", "-A"]);
  await execa("git", ["-C", seed, "-c", "user.email=t@t", "-c", "user.name=t",
    "commit", "-m", "init"]);
  await execa("git", ["-C", seed, "branch", "-M", "main"]);
  await execa("git", ["-C", seed, "remote", "add", "origin", bareRepo]);
  await execa("git", ["-C", seed, "push", "-u", "origin", "main"]);
  await rm(seed, { recursive: true, force: true });

  workRoot = await mkdtemp(join(tmpdir(), "sfb-work-"));
  process.env.WORK_DIR = workRoot;

  const binDir = await mkdtemp(join(tmpdir(), "sfb-bin-"));
  stubBin = binDir;
  const claudeScript = `#!/usr/bin/env bash
echo "stub-agent acting in $PWD" >&2
echo "fixed: throw -> noop" > app.js
echo
echo "## Summary"
echo "Replaced thrown error with a noop in app.js."
echo "## Confidence"
echo "high"
echo "## Risk"
echo "Callers may have relied on the thrown error; check call sites."
`;
  const ghScript = `#!/usr/bin/env bash
echo "https://github.com/example/fixture/pull/42"
`;
  await writeFile(join(binDir, "claude"), claudeScript);
  await writeFile(join(binDir, "gh"), ghScript);
  await chmod(join(binDir, "claude"), 0o755);
  await chmod(join(binDir, "gh"), 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  process.env.CLAUDE_BIN = "claude";

  configMod = await import("../../src/config/repos.js");
});

beforeEach(async () => {
  await setupTestDb();
  (configMod.repoForProject).mockResolvedValue({
    sentry_project: "p",
    github: "example/fixture",
    default_branch: "main",
    test_command: "true",
    pr_reviewers: [],
    daily_token_cap: 1_000_000,
    daily_cost_cap_cents: 10_000,
    min_severity_to_fix: "low",
  });
});

afterAll(async () => {
  await teardownTestDb();
  for (const d of [bareRepo, workRoot, stubBin]) {
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe("handleAgentJob (e2e with local fixture)", () => {
  it("clones, runs stub agent, pushes, opens PR, writes prs row", async () => {
    const alert = await upsertAlert({
      sentryIssueId: "10001", sentryProject: "p", fingerprint: "fp",
      codeVersion: null, dedupKey: "k-e2e", title: "boom in app.js",
      level: "error", firstSeenAt: new Date(), lastSeenAt: new Date(),
      rawPayloadS3: "s3://x",
    });
    const runId = await createRun({ alertId: alert.id, status: "triaging" });
    await updateRun(runId, {
      status: "agent_pending",
      severity: "high",
      triageSummary: "stub triage",
      suspectedFiles: ["app.js"],
      stackTrace: "fake stack",
    });

    // Inject a workspace that clones from the local bare repo.
    const createWorkspace = async (input: {
      runId: string;
      repo: string;
      defaultBranch: string;
      branch: string;
    }) => {
      const dir = join(workRoot, input.runId);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      await execa("git", ["clone", "--depth", "50", `file://${bareRepo}`, dir]);
      await execa("git", ["-C", dir, "checkout", input.defaultBranch]);
      await execa("git", ["-C", dir, "checkout", "-b", input.branch]);
      await execa("git", ["-C", dir, "config", "user.email", "bot@local"]);
      await execa("git", ["-C", dir, "config", "user.name", "bot"]);
      return {
        dir,
        branch: input.branch,
        cleanup: async () => rm(dir, { recursive: true, force: true }),
      };
    };

    const { handleAgentJob } = await import("../../src/worker/agent-job.js");
    await handleAgentJob({ runId }, { createWorkspace });

    const run = await db().query(
      "SELECT status, branch, agent_summary FROM runs WHERE id=$1", [runId],
    );
    expect(run.rows[0].status).toBe("pr_opened");
    expect(run.rows[0].branch).toMatch(/^sentry-fix\//);
    expect(run.rows[0].agent_summary).toMatch(/Replaced thrown error/);

    const prs = await db().query(
      "SELECT number, url FROM prs WHERE run_id=$1", [runId],
    );
    expect(prs.rows[0].number).toBe(42);
    expect(prs.rows[0].url).toBe("https://github.com/example/fixture/pull/42");

    const branches = await execa("git", ["-C", bareRepo, "branch", "--list", "sentry-fix/*"]);
    expect(branches.stdout).toMatch(/sentry-fix\//);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/integration/agent-job.test.ts`

- [ ] **Step 3: Commit**

```bash
git add tests/integration/agent-job.test.ts
git commit -m "test: e2e agent job with fixture repo + stub binaries"
```

---

## **Review checkpoint B — Full MVP pipeline**

Verify:
- `bun test` fully green
- `bun run build` produces `dist/`
- Local end-to-end via Task 47 verification

---

## Task 47: End-to-end manual verification

Not a code task. The gate that says "MVP is done."

- [ ] **Step 1: Fresh stack**

```bash
docker compose down -v
./scripts/dev-up.sh
bun run db:migrate
```

- [ ] **Step 2: Configure secrets**

- `.env` populated (Anthropic key, Sentry token + webhook secret + org, S3 bucket, GitHub App fields)
- `secrets/github-app-private-key.pem` present (gitignored)
- `repos.yaml` lists one real test repo with `default_branch`, `test_command`, and `pr_reviewers`
- Sentry test project webhook URL points at the bot (use `ngrok` or a tunnel for local dev)

- [ ] **Step 3: Start the bot**

Terminal 1: `bun run dev`
Terminal 2: `bun run dev:worker`

- [ ] **Step 4: Trigger a real alert**

Either:
- Cause a real exception in the configured test repo (deploy code with a throw), or
- POST `./scripts/seed-fake-alert.sh` with `SENTRY_PROJECT` matching a `repos.yaml` entry

- [ ] **Step 5: Observe end-to-end**

Within ~8 minutes:
- Web log: 202 returned
- Worker log: `triage start` → `triage done; agent enqueued` → `cloning` → `spawning claude` → `running tests` → `pr_opened`
- DB: `alerts` 1 row, `runs` 1 row `status='pr_opened'`, `prs` 1 row with `url` populated
- GitHub: a real PR open on the test repo, branch named `sentry-fix/...`, body with summary/risk/confidence
- Sentry: a comment on the test issue linking to the PR
- S3: payload + log archived under `sentry-payloads/...` and `run-logs/...`

- [ ] **Step 6: Verify draft-on-test-failure**

Edit the test repo to make its test command exit non-zero. Re-trigger. Expect: PR opens as **draft**, `needs_human=true`, body says "tests FAILED".

- [ ] **Step 7: Verify dedup under load**

```bash
for i in $(seq 1 30); do
  SENTRY_ISSUE_ID=999999 \
  SENTRY_WEBHOOK_SECRET=$(grep SENTRY_WEBHOOK_SECRET .env | cut -d= -f2) \
    ./scripts/seed-fake-alert.sh &
done
wait
```
Expect: 1 row in `alerts` with `webhook_count = 30`. 1 run. ≤1 PR.

- [ ] **Step 8: Verify budget hard-stop**

Set `daily_token_cap: 1` for the test repo in `repos.yaml`. Trigger an alert. Expect: run status `budget_blocked`, no PR, Sentry comment "budget exhausted".

- [ ] **Step 9: Verify secret-scan rejection**

Modify the stub agent (or temporarily, the real agent's prompt) to write a `.env` file. Expect: agent job ends in `agent_failed` with error `secret-scan rejected files: .env`. No PR opened.

- [ ] **Step 10: Paste evidence into deploy PR**

Paste into the deploy PR body:
- Web log + worker log snippets
- DB query output for `alerts`, `runs`, `prs`
- GitHub PR URL or screenshot
- Sentry comment screenshot

---

## Task 48: Tag the MVP

- [ ] **Step 1: Full suite green**

```bash
bun test && bun run lint && bun run typecheck
```

- [ ] **Step 2: Tag**

```bash
git tag -a mvp-1.0.0 -m "MVP: Sentry webhook → triage → fix → PR"
```

- [ ] **Step 3: Update `docs/implementation-plan.md`**

Mark MVP phases DONE with the actual date; tick the `[ ]` boxes covered.

- [ ] **Step 4: Commit**

```bash
git add docs/implementation-plan.md
git commit -m "docs: mark MVP delivered"
```

---

## Spec coverage self-review

Mapping each MVP requirement to a task:

| Requirement | Task |
| --- | --- |
| Webhook receive | 23 |
| HMAC verify | 18 |
| Dedup | 20 + 21 |
| Sentry payload archive | 22 |
| Triage via Haiku | 27 + 41 |
| Sentry comment | 28 + 41 + 39 |
| Repo configuration | 14 |
| GitHub App auth | 31 |
| Workspace clone + branch | 32 |
| Agent prompt | 33 |
| Claude Code CLI spawn with `--dangerously-skip-permissions` | 34 |
| Output parsing | 35 |
| Pre-push secret scan | 36 |
| Test gate | 37 |
| Commit + push + open PR via `gh` | 38 |
| Budget enforcement (hard-stop) | 30 + 39 |
| Run log archive | 22 + 39 |
| End-to-end orchestrator | 39 |
| Two-process model | 42 |
| systemd | 43 |
| nginx + TLS + rate limit | 44 |
| Local dev seed | 45 |
| End-to-end integration test | 46 |
| Manual deploy verification | 47 |
| Release tag | 48 |

**Deferred to post-MVP**: Slack notifications, cron PR-state polling, stale-PR close, admin dashboard, prompt A/B harness, multi-LLM fallback, GitLab support, multi-tenant isolation.

## Placeholder scan

No `TBD`, no `TODO`, no "implement later", no "similar to Task N". Every code block is runnable. The agent job reads `run.stack_trace` populated in Task 41; if `stack_trace` is null because triage extraction failed, the prompt falls back to a clear message rather than crashing.

## Type consistency

- `enqueueTriage`, `enqueueAgent`: signatures defined in Task 25, consumed in Tasks 23, 41 — match.
- `TriageOutput`: defined in Task 27, consumed in Tasks 41, 39 — match.
- `RepoEntry`: defined in Task 14, consumed in Tasks 39, 46 — match.
- `RunUpdate` field map covers every field used by Tasks 39, 41.
- `WorkspaceHandle`: defined in Task 32, consumed in Task 39, stubbed in Task 46 — shape matches.
- `AgentJobDeps` (Task 39): allows test injection of `createWorkspace` + `runTests` while defaulting to real implementations.

No drift detected.

---

**Plan complete and saved to `/Users/shivang/dev/sentry-fixer-bot/docs/plans/2026-05-15-mvp-webhook-to-pr.md`.**
