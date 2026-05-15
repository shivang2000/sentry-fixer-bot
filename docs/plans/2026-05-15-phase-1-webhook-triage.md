# sentry-fixer-bot — Phase 1: Webhook + Triage-Only Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a deployable EC2 service that receives Sentry webhooks, verifies HMAC signatures, deduplicates alert storms, archives raw payloads to S3, classifies severity via Claude Haiku, and posts a triage comment back to the Sentry issue. No agent spawn and no GitHub PRs in this phase.

**Architecture:** Node 20 + TypeScript service running three processes (web, worker, cron) under systemd. Postgres for state and queue (pg-boss). Hono as the HTTP framework. Strict-mode TypeScript, zod-validated env, pino logging. TDD with vitest; integration tests run against a real Postgres provided by docker-compose.

**Tech Stack:** Node 20, TypeScript 5.7, Hono 4, pg 8, pg-boss 9, zod 3, pino 9, `@anthropic-ai/sdk` 0.30, `@aws-sdk/client-s3` 3, vitest 2, `execa` 9 (script runner), `nock` 13 (HTTP mocking).

---

## File map

Files this plan creates. Each has one responsibility.

```
sentry-fixer-bot/
├── package.json                       Task 1
├── tsconfig.json                      Task 2
├── .eslintrc.cjs                      Task 3
├── .prettierrc                        Task 3
├── vitest.config.ts                   Task 4
├── docker-compose.yml                 Task 5
├── .env.example                       Task 6
├── .gitignore                         Task 1
├── src/
│   ├── env.ts                         Task 7   (zod env schema)
│   ├── log.ts                         Task 8   (pino setup)
│   ├── db/
│   │   ├── client.ts                  Task 9   (pg Pool)
│   │   ├── schema.sql                 Task 10  (alerts/runs/budgets DDL)
│   │   └── migrate.ts                 Task 11  (idempotent runner)
│   ├── web/
│   │   ├── server.ts                  Task 13  (Hono app factory)
│   │   ├── routes/
│   │   │   ├── health.ts              Task 14
│   │   │   └── sentry-webhook.ts      Task 19
│   │   └── verify-hmac.ts             Task 15  (timing-safe compare)
│   ├── alerts/
│   │   ├── dedup-key.ts               Task 17  (pure function)
│   │   └── persist.ts                 Task 18  (upsert)
│   ├── archive/
│   │   └── s3.ts                      Task 20  (put raw payload)
│   ├── queue/
│   │   ├── boss.ts                    Task 21
│   │   └── jobs.ts                    Task 22  (job name + payload types)
│   ├── sentry/
│   │   ├── client.ts                  Task 24  (REST fetch event)
│   │   └── comment.ts                 Task 26  (post triage)
│   ├── triage/
│   │   └── classify.ts                Task 25  (Haiku JSON schema call)
│   ├── worker/
│   │   ├── triage-job.ts              Task 27  (handler)
│   │   └── index.ts                   Task 28  (register handlers)
│   ├── runs/
│   │   └── persist.ts                 Task 27  (run row insert/update)
│   └── index.ts                       Task 29  (process dispatcher)
├── deploy/
│   ├── systemd/
│   │   ├── sfb-web.service            Task 30
│   │   └── sfb-worker.service         Task 30
│   └── nginx/sfb.conf                 Task 31
├── scripts/
│   ├── dev-up.sh                      Task 5
│   └── seed-fake-alert.sh             Task 32
└── tests/
    ├── helpers/
    │   ├── db.ts                      Task 12  (test DB lifecycle)
    │   └── fixtures.ts                Task 16  (Sentry payload fixture)
    ├── unit/
    │   ├── verify-hmac.test.ts        Task 15
    │   ├── dedup-key.test.ts          Task 17
    │   └── classify.test.ts           Task 25
    └── integration/
        ├── webhook.test.ts            Task 23
        └── triage-job.test.ts         Task 28
```

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
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "tsx watch src/index.ts web",
    "dev:worker": "tsx watch src/index.ts worker",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src tests",
    "format": "prettier --write src tests",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.0",
    "@aws-sdk/client-s3": "^3.700.0",
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0",
    "pg": "^8.13.0",
    "pg-boss": "^9.0.3",
    "pino": "^9.5.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^20.17.0",
    "@types/pg": "^8.11.0",
    "@typescript-eslint/eslint-plugin": "^8.18.0",
    "@typescript-eslint/parser": "^8.18.0",
    "eslint": "^9.16.0",
    "execa": "^9.5.0",
    "nock": "^13.5.0",
    "prettier": "^3.4.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

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
```

- [ ] **Step 3: Install dependencies**

Run: `cd /Users/shivang/dev/sentry-fixer-bot && pnpm install`
Expected: `node_modules/` populated, no peer-dep errors.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore pnpm-lock.yaml
git commit -m "chore: scaffold package.json and gitignore"
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

- [ ] **Step 2: Verify it compiles an empty project**

Run: `pnpm tsc --noEmit`
Expected: No output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: add tsconfig with strict mode"
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

- [ ] **Step 3: Run lint to confirm no errors on empty src**

Run: `pnpm lint || true`
Expected: lint runs (may say "No files matching pattern" — fine).

- [ ] **Step 4: Commit**

```bash
git add .eslintrc.cjs .prettierrc
git commit -m "chore: add eslint and prettier config"
```

---

## Task 4: Vitest configuration

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/vitest.config.ts`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ["./tests/helpers/setup.ts"],
  },
});
```

- [ ] **Step 2: Create the setup stub so vitest does not fail on import**

File: `/Users/shivang/dev/sentry-fixer-bot/tests/helpers/setup.ts`

```ts
// Test setup runs once per test file. Keep this empty for Phase 1;
// per-suite setup belongs in helpers/db.ts and individual test files.
```

- [ ] **Step 3: Run vitest to confirm it discovers zero tests**

Run: `pnpm test`
Expected: Output includes `No test files found`, exit code 0 (or 1 with empty-suite — either acceptable, verify config loads without error).

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts tests/helpers/setup.ts
git commit -m "chore: add vitest config"
```

---

## Task 5: Docker Compose for local Postgres + dev script

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

- [ ] **Step 3: Make script executable**

Run: `chmod +x scripts/dev-up.sh`

- [ ] **Step 4: Start Postgres**

Run: `./scripts/dev-up.sh`
Expected: `Postgres ready on localhost:5433`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml scripts/dev-up.sh
git commit -m "chore: docker-compose postgres for dev"
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

# Service
PORT=3000
LOG_LEVEL=info
NODE_ENV=development
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "chore: env example"
```

---

## Task 7: Env schema (zod-validated)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/env.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/env.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/env.test.ts
import { describe, it, expect } from "vitest";
import { parseEnv } from "../../src/env.js";

describe("parseEnv", () => {
  const validEnv = {
    DATABASE_URL: "postgres://u:p@localhost:5433/sfb",
    SENTRY_WEBHOOK_SECRET: "secret",
    SENTRY_API_TOKEN: "token",
    SENTRY_ORG_SLUG: "acme",
    ANTHROPIC_API_KEY: "sk-ant-x",
    S3_BUCKET: "bucket",
    S3_REGION: "us-east-1",
    PORT: "3000",
    LOG_LEVEL: "info",
    NODE_ENV: "test",
  };

  it("accepts a valid environment", () => {
    const env = parseEnv(validEnv);
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NODE_ENV).toBe("test");
  });

  it("rejects missing required fields", () => {
    const { DATABASE_URL: _, ...rest } = validEnv;
    expect(() => parseEnv(rest)).toThrow(/DATABASE_URL/);
  });

  it("coerces PORT to number", () => {
    const env = parseEnv(validEnv);
    expect(typeof env.PORT).toBe("number");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/env.test.ts`
Expected: FAIL — module `src/env.ts` not found.

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

- [ ] **Step 4: Run tests; they must pass**

Run: `pnpm test tests/unit/env.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/env.ts tests/unit/env.test.ts
git commit -m "feat(env): zod-validated environment schema"
```

---

## Task 8: Pino logger

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
    paths: ["req.headers.authorization", "*.password", "*.secret", "*.token"],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof log;
```

- [ ] **Step 2: Smoke-test by importing in a one-liner**

Run:
```bash
SENTRY_WEBHOOK_SECRET=x SENTRY_API_TOKEN=x SENTRY_ORG_SLUG=x \
ANTHROPIC_API_KEY=x S3_BUCKET=x S3_REGION=us-east-1 \
DATABASE_URL=postgres://u:p@localhost:5433/sfb \
NODE_ENV=test pnpm tsx -e "import('./src/log.js').then(m => m.log.info('hello'))"
```
Expected: JSON log line on stdout with `"msg":"hello"`.

- [ ] **Step 3: Commit**

```bash
git add src/log.ts
git commit -m "feat(log): pino logger with redaction"
```

---

## Task 9: Postgres pool client

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

- [ ] **Step 2: Smoke-test against the docker-compose DB**

Run:
```bash
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb SENTRY_WEBHOOK_SECRET=x \
SENTRY_API_TOKEN=x SENTRY_ORG_SLUG=x ANTHROPIC_API_KEY=x \
S3_BUCKET=x S3_REGION=us-east-1 NODE_ENV=test \
pnpm tsx -e "import('./src/db/client.js').then(async m => { const r = await m.db().query('SELECT 1 as one'); console.log(r.rows[0]); await m.closeDb(); })"
```
Expected: `{ one: 1 }`.

- [ ] **Step 3: Commit**

```bash
git add src/db/client.ts
git commit -m "feat(db): postgres pool client"
```

---

## Task 10: Database schema DDL

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/db/schema.sql`

- [ ] **Step 1: Write `src/db/schema.sql`**

```sql
-- src/db/schema.sql
-- Phase 1 schema. Idempotent; safe to re-run.

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
  status           TEXT NOT NULL,
  severity         TEXT,
  triage_summary   TEXT,
  suspected_files  JSONB,
  tokens_input     INT NOT NULL DEFAULT 0,
  tokens_output    INT NOT NULL DEFAULT 0,
  cost_cents       INT NOT NULL DEFAULT 0,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  error            TEXT
);

CREATE INDEX IF NOT EXISTS runs_alert_id_idx ON runs (alert_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs (status);

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
git commit -m "feat(db): phase 1 schema"
```

---

## Task 11: Migration runner

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

- [ ] **Step 2: Apply against dev DB**

Run:
```bash
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb SENTRY_WEBHOOK_SECRET=x \
SENTRY_API_TOKEN=x SENTRY_ORG_SLUG=x ANTHROPIC_API_KEY=x \
S3_BUCKET=x S3_REGION=us-east-1 NODE_ENV=test \
pnpm db:migrate
```
Expected: log line `migration applied`, exit code 0. Tables visible via:
```bash
docker compose exec postgres psql -U sfb -d sfb -c "\dt"
```
should list `alerts`, `runs`, `budgets`.

- [ ] **Step 3: Re-run migration to confirm idempotency**

Run the same command again. Expected: exits successfully, no errors (because each `CREATE` uses `IF NOT EXISTS`).

- [ ] **Step 4: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat(db): idempotent migration runner"
```

---

## Task 12: Test DB lifecycle helper

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/tests/helpers/db.ts`

- [ ] **Step 1: Write `tests/helpers/db.ts`**

```ts
// tests/helpers/db.ts
import { db, closeDb } from "../../src/db/client.js";
import { migrate } from "../../src/db/migrate.js";

export async function setupTestDb(): Promise<void> {
  await migrate();
  await db().query(`
    TRUNCATE TABLE alerts, runs, budgets RESTART IDENTITY CASCADE
  `);
}

export async function teardownTestDb(): Promise<void> {
  await closeDb();
}
```

- [ ] **Step 2: Commit (no test yet — used by later tests)**

```bash
git add tests/helpers/db.ts
git commit -m "test: db lifecycle helper"
```

---

## Task 13: Hono app factory + server bootstrap

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
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/server.ts
git commit -m "feat(web): hono app factory"
```

---

## Task 14: Health route

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/routes/health.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/health.test.ts`

- [ ] **Step 1: Write failing integration test**

```ts
// tests/integration/health.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../../src/web/server.js";
import { mountHealth } from "../../src/web/routes/health.js";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";

describe("GET /healthz", () => {
  beforeAll(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("returns 200 with db ok when database is reachable", async () => {
    const app = createApp();
    mountHealth(app);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, db: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/integration/health.test.ts`
Expected: FAIL — `mountHealth` not found.

- [ ] **Step 3: Implement `src/web/routes/health.ts`**

```ts
// src/web/routes/health.ts
import type { Hono } from "hono";
import { db } from "../../src/db/client.js";

export function mountHealth(app: Hono): void {
  app.get("/healthz", async (c) => {
    let dbOk = false;
    try {
      await db().query("SELECT 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    return c.json({ ok: dbOk, db: dbOk }, dbOk ? 200 : 503);
  });
}
```

> Note: the import path is intentionally relative to `src/web/routes/`. Adjust if your test runner reports a path resolution error: change to `../../db/client.js`.

- [ ] **Step 4: Correct the import path**

Replace `"../../src/db/client.js"` with `"../../db/client.js"` inside `src/web/routes/health.ts`. The earlier path was for the test file, not the source file.

- [ ] **Step 5: Run test — must pass**

Run: `pnpm test tests/integration/health.test.ts`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add src/web/routes/health.ts tests/integration/health.test.ts
git commit -m "feat(web): healthz endpoint with db check"
```

---

## Task 15: HMAC verifier (timing-safe)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/verify-hmac.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/verify-hmac.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/verify-hmac.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySentrySignature } from "../../src/web/verify-hmac.js";

const SECRET = "my-shared-secret";

function sign(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("verifySentrySignature", () => {
  it("accepts a matching signature", () => {
    const body = '{"event":"issue.created"}';
    const sig = sign(body);
    expect(verifySentrySignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = '{"event":"issue.created"}';
    const sig = sign(body);
    expect(verifySentrySignature(body + "x", sig, SECRET)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const body = '{"event":"issue.created"}';
    const sig = sign(body);
    const tampered = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(verifySentrySignature(body, tampered, SECRET)).toBe(false);
  });

  it("rejects missing signature", () => {
    expect(verifySentrySignature("body", "", SECRET)).toBe(false);
  });

  it("rejects signature of wrong length without throwing", () => {
    expect(verifySentrySignature("body", "abc", SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/verify-hmac.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/web/verify-hmac.ts`**

```ts
// src/web/verify-hmac.ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySentrySignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
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

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/unit/verify-hmac.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/web/verify-hmac.ts tests/unit/verify-hmac.test.ts
git commit -m "feat(web): timing-safe HMAC verification"
```

---

## Task 16: Sentry payload fixture

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
      culprit?: string;
      firstSeen: string;
      lastSeen: string;
      metadata?: { fingerprint?: string };
    };
  };
  installation: { uuid: string };
};

export function makeSentryPayload(overrides: Partial<{
  issueId: string;
  shortId: string;
  project: string;
  title: string;
  level: string;
  fingerprint: string;
  firstSeen: string;
  lastSeen: string;
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
git commit -m "test: sentry payload fixture builder"
```

---

## Task 17: Dedup key (pure function)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/alerts/dedup-key.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/dedup-key.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/dedup-key.test.ts
import { describe, it, expect } from "vitest";
import { computeDedupKey } from "../../src/alerts/dedup-key.js";

describe("computeDedupKey", () => {
  it("returns a stable hex hash", () => {
    const k1 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" });
    const k2 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" });
    expect(k1).toEqual(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when project changes", () => {
    const k1 = computeDedupKey({ project: "p1", fingerprint: "f", codeVersion: "v" });
    const k2 = computeDedupKey({ project: "p2", fingerprint: "f", codeVersion: "v" });
    expect(k1).not.toEqual(k2);
  });

  it("differs when fingerprint changes", () => {
    const k1 = computeDedupKey({ project: "p", fingerprint: "f1", codeVersion: "v" });
    const k2 = computeDedupKey({ project: "p", fingerprint: "f2", codeVersion: "v" });
    expect(k1).not.toEqual(k2);
  });

  it("differs when codeVersion changes", () => {
    const k1 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v1" });
    const k2 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "v2" });
    expect(k1).not.toEqual(k2);
  });

  it("treats null codeVersion as empty string", () => {
    const k1 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: null });
    const k2 = computeDedupKey({ project: "p", fingerprint: "f", codeVersion: "" });
    expect(k1).toEqual(k2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/dedup-key.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/alerts/dedup-key.ts`**

```ts
// src/alerts/dedup-key.ts
import { createHash } from "node:crypto";

export type DedupInput = {
  project: string;
  fingerprint: string;
  codeVersion: string | null;
};

export function computeDedupKey(input: DedupInput): string {
  const v = input.codeVersion ?? "";
  return createHash("sha256").update(`${input.project}|${input.fingerprint}|${v}`).digest("hex");
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/unit/dedup-key.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/alerts/dedup-key.ts tests/unit/dedup-key.test.ts
git commit -m "feat(alerts): dedup key hash"
```

---

## Task 18: Alert persist (upsert with conflict bump)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/alerts/persist.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/alert-persist.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/integration/alert-persist.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { upsertAlert } from "../../src/alerts/persist.js";

describe("upsertAlert", () => {
  beforeEach(async () => {
    await setupTestDb();
  });
  afterAll(async () => {
    await teardownTestDb();
  });

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

  it("creates a new row and reports is_new=true", async () => {
    const out = await upsertAlert(fixed);
    expect(out.isNew).toBe(true);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.webhookCount).toBe(1);
  });

  it("bumps webhook_count on conflict and reports is_new=false", async () => {
    await upsertAlert(fixed);
    const out2 = await upsertAlert({ ...fixed, lastSeenAt: new Date("2026-05-15T01:00:00Z") });
    expect(out2.isNew).toBe(false);
    expect(out2.webhookCount).toBe(2);
    const r = await db().query("SELECT webhook_count FROM alerts WHERE dedup_key=$1", ["deadbeef"]);
    expect(r.rows[0].webhook_count).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/integration/alert-persist.test.ts`
Expected: FAIL — module not found.

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

export type AlertUpsertResult = {
  id: string;
  isNew: boolean;
  webhookCount: number;
};

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
    input.sentryIssueId,
    input.sentryProject,
    input.fingerprint,
    input.codeVersion,
    input.dedupKey,
    input.title,
    input.level,
    input.firstSeenAt,
    input.lastSeenAt,
    input.rawPayloadS3,
  ]);
  const row = res.rows[0];
  return { id: row.id, isNew: row.is_new === true, webhookCount: row.webhook_count };
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/integration/alert-persist.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/alerts/persist.ts tests/integration/alert-persist.test.ts
git commit -m "feat(alerts): upsert with conflict bump"
```

---

## Task 19: S3 archive helper

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/archive/s3.ts`

- [ ] **Step 1: Write `src/archive/s3.ts`**

```ts
// src/archive/s3.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.js";

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) client = new S3Client({ region: env().S3_REGION });
  return client;
}

export type ArchiveInput = {
  alertId: string;
  body: string; // raw JSON body
};

export async function archiveSentryPayload(input: ArchiveInput): Promise<string> {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `sentry-payloads/${yyyy}/${mm}/${input.alertId}.json`;
  await s3().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: input.body,
      ContentType: "application/json",
    }),
  );
  return `s3://${env().S3_BUCKET}/${key}`;
}

export async function archiveSentryPayloadSafe(
  input: ArchiveInput,
): Promise<string> {
  try {
    return await archiveSentryPayload(input);
  } catch {
    return `s3://unavailable/${input.alertId}`;
  }
}
```

> The `safe` variant is intentional: webhook ingestion must not 5xx because S3 had a transient issue. We log via the caller and degrade the audit trail rather than dropping alerts.

- [ ] **Step 2: Commit**

```bash
git add src/archive/s3.ts
git commit -m "feat(archive): s3 sentry-payload writer"
```

---

## Task 20: Webhook route — verify, dedup, archive, enqueue

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/web/routes/sentry-webhook.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/webhook.test.ts`

This task pulls together verify-hmac (Task 15), dedup-key (Task 17), upsertAlert (Task 18), and S3 archive (Task 19). The queue enqueue uses pg-boss which Task 21 wires in; we stub it for this task and rewire after Task 22.

- [ ] **Step 1: Write failing integration test**

```ts
// tests/integration/webhook.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { createApp } from "../../src/web/server.js";
import { mountSentryWebhook } from "../../src/web/routes/sentry-webhook.js";
import { makeSentryPayload, signPayload } from "../helpers/fixtures.js";

const SECRET = "test-secret";

// Mock archive so we don't hit S3.
vi.mock("../../src/archive/s3.js", () => ({
  archiveSentryPayloadSafe: vi.fn(async ({ alertId }: { alertId: string }) =>
    `s3://test/${alertId}.json`,
  ),
}));

const enqueueTriage = vi.fn(async (_alertId: string) => "job-id");

beforeAll(async () => {
  process.env.SENTRY_WEBHOOK_SECRET = SECRET;
});

beforeEach(async () => {
  await setupTestDb();
  enqueueTriage.mockClear();
});

afterAll(async () => {
  await teardownTestDb();
});

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
  it("rejects requests with no signature with 401", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const raw = JSON.stringify(makeSentryPayload());
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(401);
    expect(enqueueTriage).not.toHaveBeenCalled();
  });

  it("rejects tampered bodies with 401", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const payload = makeSentryPayload();
    const raw = JSON.stringify(payload);
    const sig = signPayload(raw, SECRET);
    const res = await app.request("/webhooks/sentry", {
      method: "POST",
      headers: { "content-type": "application/json", "sentry-hook-signature": sig },
      body: raw + " ",
    });
    expect(res.status).toBe(401);
  });

  it("inserts a new alert on first valid hit and enqueues triage", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const res = await app.request(buildRequest(makeSentryPayload()));
    expect(res.status).toBe(202);
    const r = await db().query("SELECT count(*)::int as c FROM alerts");
    expect(r.rows[0].c).toBe(1);
    expect(enqueueTriage).toHaveBeenCalledTimes(1);
  });

  it("dedups identical payloads and does not enqueue twice", async () => {
    const app = createApp();
    mountSentryWebhook(app, { enqueueTriage });
    const payload = makeSentryPayload();
    await app.request(buildRequest(payload));
    await app.request(buildRequest(payload));
    const r = await db().query("SELECT count(*)::int as c, max(webhook_count)::int as wc FROM alerts");
    expect(r.rows[0].c).toBe(1);
    expect(r.rows[0].wc).toBe(2);
    expect(enqueueTriage).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/integration/webhook.test.ts`
Expected: FAIL — module not found.

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

type Deps = { enqueueTriage: (alertId: string) => Promise<string> };

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

type SentryWebhookBody = {
  data?: { issue?: SentryIssue; release?: { version?: string } };
};

export function mountSentryWebhook(app: Hono, deps: Deps): void {
  app.post("/webhooks/sentry", async (c) => {
    const raw = await c.req.text();
    const signature = c.req.header(SIGNATURE_HEADER) ?? "";
    if (!verifySentrySignature(raw, signature, env().SENTRY_WEBHOOK_SECRET)) {
      log.warn({ signature_present: signature.length > 0 }, "sentry webhook rejected: bad signature");
      return c.json({ error: "unauthorized" }, 401);
    }

    let body: SentryWebhookBody;
    try {
      body = JSON.parse(raw) as SentryWebhookBody;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const issue = body.data?.issue;
    if (!issue) {
      log.warn("sentry webhook missing data.issue");
      return c.json({ error: "no_issue" }, 400);
    }

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
      // Backfill the s3 path now that we have it. Best-effort; not transactional.
      try {
        // dynamic import keeps the route module thin.
        const { db } = await import("../../db/client.js");
        await db().query("UPDATE alerts SET raw_payload_s3=$1 WHERE id=$2", [s3Url, upsert.id]);
      } catch (err) {
        log.error({ err }, "failed to backfill s3 path; alert still ingested");
      }

      try {
        await deps.enqueueTriage(upsert.id);
      } catch (err) {
        log.error({ err, alertId: upsert.id }, "failed to enqueue triage; will retry via recovery cron");
      }
    } else {
      log.info({ alertId: upsert.id, count: upsert.webhookCount }, "sentry webhook deduped");
    }

    return c.json({ alertId: upsert.id, isNew: upsert.isNew }, 202);
  });
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/integration/webhook.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/sentry-webhook.ts tests/integration/webhook.test.ts
git commit -m "feat(web): sentry webhook with verify, dedup, archive"
```

---

## Task 21: pg-boss queue init

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
  if (boss) {
    await boss.stop({ graceful: true });
    boss = null;
  }
}
```

- [ ] **Step 2: Smoke-test queue start/stop**

Run:
```bash
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb SENTRY_WEBHOOK_SECRET=x \
SENTRY_API_TOKEN=x SENTRY_ORG_SLUG=x ANTHROPIC_API_KEY=x \
S3_BUCKET=x S3_REGION=us-east-1 NODE_ENV=test \
pnpm tsx -e "import('./src/queue/boss.js').then(async m => { const b = await m.getBoss(); console.log('boss ready'); await m.stopBoss(); console.log('boss stopped'); })"
```
Expected: `boss ready` then `boss stopped`. Postgres will have a `pgboss` schema created.

- [ ] **Step 3: Commit**

```bash
git add src/queue/boss.ts
git commit -m "feat(queue): pg-boss init"
```

---

## Task 22: Job names and payload types

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/queue/jobs.ts`

- [ ] **Step 1: Write `src/queue/jobs.ts`**

```ts
// src/queue/jobs.ts
import type PgBoss from "pg-boss";
import { getBoss } from "./boss.js";

export const Q = {
  triage: "triage",
} as const;

export type TriagePayload = { alertId: string };

export async function enqueueTriage(alertId: string): Promise<string> {
  const boss = await getBoss();
  const jobId = await boss.send<TriagePayload>(Q.triage, { alertId }, {
    retryLimit: 2,
    retryDelay: 30,
    retryBackoff: true,
    expireInHours: 1,
  });
  if (!jobId) throw new Error("pg-boss returned null job id");
  return jobId;
}

export async function onTriage(
  handler: (payload: TriagePayload, job: PgBoss.Job<TriagePayload>) => Promise<void>,
): Promise<void> {
  const boss = await getBoss();
  await boss.work<TriagePayload>(Q.triage, { teamSize: 3, teamConcurrency: 1 }, async (job) => {
    await handler(job.data, job);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/queue/jobs.ts
git commit -m "feat(queue): triage job name and helpers"
```

---

## Task 23: Re-wire webhook to use real `enqueueTriage`

**Files:**
- Modify: `/Users/shivang/dev/sentry-fixer-bot/src/web/routes/sentry-webhook.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/webhook.test.ts` (no change; already injects)

The route already accepts `enqueueTriage` via dependency injection. We need to wire the real implementation in the bootstrap layer. We add a default for production callers.

- [ ] **Step 1: Modify `mountSentryWebhook` to accept optional deps**

Replace the `mountSentryWebhook(app, deps)` signature in `src/web/routes/sentry-webhook.ts` with a defaulting version. Replace this section:

```ts
type Deps = { enqueueTriage: (alertId: string) => Promise<string> };

export function mountSentryWebhook(app: Hono, deps: Deps): void {
```

with:

```ts
import { enqueueTriage as defaultEnqueueTriage } from "../../queue/jobs.js";

type Deps = { enqueueTriage?: (alertId: string) => Promise<string> };

export function mountSentryWebhook(app: Hono, deps: Deps = {}): void {
  const enqueueTriage = deps.enqueueTriage ?? defaultEnqueueTriage;
```

Then change every later reference from `deps.enqueueTriage(...)` to `enqueueTriage(...)`.

- [ ] **Step 2: Re-run webhook tests — still must pass with mock injection**

Run: `pnpm test tests/integration/webhook.test.ts`
Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/sentry-webhook.ts
git commit -m "feat(web): wire real triage enqueue with override hook"
```

---

## Task 24: Sentry REST client (fetch latest event)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/sentry/client.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/sentry-client.test.ts`

- [ ] **Step 1: Write failing test with `nock`**

```ts
// tests/unit/sentry-client.test.ts
import { describe, it, expect, afterEach } from "vitest";
import nock from "nock";
import { fetchLatestEvent } from "../../src/sentry/client.js";

afterEach(() => nock.cleanAll());

describe("fetchLatestEvent", () => {
  it("returns the parsed event payload", async () => {
    process.env.SENTRY_API_TOKEN = "test-token";
    process.env.SENTRY_ORG_SLUG = "acme";
    nock("https://sentry.io")
      .get("/api/0/issues/1234/events/latest/")
      .reply(200, {
        eventID: "abc",
        message: "boom",
        entries: [
          { type: "exception", data: { values: [{ stacktrace: { frames: [] } }] } },
        ],
      });
    const out = await fetchLatestEvent("1234");
    expect(out.eventID).toBe("abc");
  });

  it("throws on 4xx", async () => {
    process.env.SENTRY_API_TOKEN = "test-token";
    process.env.SENTRY_ORG_SLUG = "acme";
    nock("https://sentry.io").get("/api/0/issues/2222/events/latest/").reply(404, { detail: "nope" });
    await expect(fetchLatestEvent("2222")).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sentry-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/sentry/client.ts`**

```ts
// src/sentry/client.ts
import { env } from "../env.js";

export type SentryEvent = {
  eventID: string;
  message?: string;
  entries?: unknown[];
  tags?: Array<{ key: string; value: string }>;
  user?: unknown;
};

export async function fetchLatestEvent(sentryIssueId: string): Promise<SentryEvent> {
  const url = `https://sentry.io/api/0/issues/${encodeURIComponent(sentryIssueId)}/events/latest/`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${env().SENTRY_API_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`sentry api ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as SentryEvent;
}
```

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/unit/sentry-client.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sentry/client.ts tests/unit/sentry-client.test.ts
git commit -m "feat(sentry): rest client for latest event"
```

---

## Task 25: Triage classifier (Claude Haiku structured output)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/triage/classify.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/classify.test.ts`

- [ ] **Step 1: Write failing test (mock the Anthropic SDK)**

```ts
// tests/unit/classify.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class {
      messages = {
        create: vi.fn(async () => ({
          id: "msg_1",
          content: [
            {
              type: "tool_use",
              name: "report_triage",
              input: {
                severity: "high",
                summary: "Null deref in handler",
                suspected_files: ["src/auth/middleware.ts"],
                confidence: 0.82,
              },
            },
          ],
          usage: { input_tokens: 1000, output_tokens: 200 },
        })),
      };
    },
  };
});

import { classify } from "../../src/triage/classify.js";

describe("classify", () => {
  it("returns the structured triage with token counts", async () => {
    const out = await classify({
      alertTitle: "TypeError",
      level: "error",
      stackTrace: "Error\n  at foo",
      eventTags: [],
    });
    expect(out.severity).toBe("high");
    expect(out.suspectedFiles).toEqual(["src/auth/middleware.ts"]);
    expect(out.tokensIn).toBe(1000);
    expect(out.tokensOut).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/classify.test.ts`
Expected: FAIL — module not found.

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
      summary: { type: "string", description: "One-sentence cause hypothesis." },
      suspected_files: {
        type: "array",
        items: { type: "string" },
        description: "Repo-relative paths suspected to contain the bug.",
      },
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
    `Classify severity (impact and urgency), summarise the likely cause in one`,
    `sentence, and list up to 5 repo-relative file paths you suspect contain`,
    `the bug. Call report_triage with your decision. If the trace is unclear,`,
    `return low confidence rather than guessing.`,
  ].join("\n");

  const res = await anthropic().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    tool_choice: { type: "tool", name: TOOL.name },
    tools: [TOOL],
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolUse = res.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("claude did not call report_triage");
  }
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

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/unit/classify.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/triage/classify.ts tests/unit/classify.test.ts
git commit -m "feat(triage): haiku classifier with tool-use schema"
```

---

## Task 26: Sentry comment poster

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/sentry/comment.ts`
- Test: `/Users/shivang/dev/sentry-fixer-bot/tests/unit/sentry-comment.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/unit/sentry-comment.test.ts
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import nock from "nock";
import { postTriageComment } from "../../src/sentry/comment.js";

beforeEach(() => {
  process.env.SENTRY_API_TOKEN = "tok";
});
afterEach(() => nock.cleanAll());

describe("postTriageComment", () => {
  it("POSTs the comment to the issue", async () => {
    const scope = nock("https://sentry.io")
      .post("/api/0/issues/9999/comments/", (body: { text: string }) =>
        typeof body.text === "string" && body.text.includes("severity"),
      )
      .reply(201, { id: "c1" });
    await postTriageComment({ sentryIssueId: "9999", body: "severity=high\nsummary=x" });
    expect(scope.isDone()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test tests/unit/sentry-comment.test.ts`
Expected: FAIL — module not found.

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

- [ ] **Step 4: Run tests — must pass**

Run: `pnpm test tests/unit/sentry-comment.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sentry/comment.ts tests/unit/sentry-comment.test.ts
git commit -m "feat(sentry): comment poster"
```

---

## Task 27: Triage job handler

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/runs/persist.ts`
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/worker/triage-job.ts`

- [ ] **Step 1: Write `src/runs/persist.ts`**

```ts
// src/runs/persist.ts
import { db } from "../db/client.js";

export type CreateRunInput = {
  alertId: string;
  status: "triaging" | "triage_failed" | "triage_done";
};

export async function createRun(input: CreateRunInput): Promise<string> {
  const r = await db().query(
    "INSERT INTO runs (alert_id, status) VALUES ($1,$2) RETURNING id",
    [input.alertId, input.status],
  );
  return r.rows[0].id;
}

export type UpdateRunInput = {
  id: string;
  status: "triage_done" | "triage_failed";
  severity?: string;
  triageSummary?: string;
  suspectedFiles?: string[];
  tokensInput?: number;
  tokensOutput?: number;
  costCents?: number;
  error?: string;
};

export async function updateRun(input: UpdateRunInput): Promise<void> {
  await db().query(
    `UPDATE runs
        SET status = $2,
            severity = COALESCE($3, severity),
            triage_summary = COALESCE($4, triage_summary),
            suspected_files = COALESCE($5, suspected_files),
            tokens_input = COALESCE($6, tokens_input),
            tokens_output = COALESCE($7, tokens_output),
            cost_cents = COALESCE($8, cost_cents),
            error = COALESCE($9, error),
            ended_at = now()
      WHERE id = $1`,
    [
      input.id,
      input.status,
      input.severity ?? null,
      input.triageSummary ?? null,
      input.suspectedFiles ? JSON.stringify(input.suspectedFiles) : null,
      input.tokensInput ?? null,
      input.tokensOutput ?? null,
      input.costCents ?? null,
      input.error ?? null,
    ],
  );
}
```

- [ ] **Step 2: Write `src/worker/triage-job.ts`**

```ts
// src/worker/triage-job.ts
import { log } from "../log.js";
import { db } from "../db/client.js";
import { fetchLatestEvent } from "../sentry/client.js";
import { classify } from "../triage/classify.js";
import { postTriageComment } from "../sentry/comment.js";
import { createRun, updateRun } from "../runs/persist.js";

// Haiku 4.5 USD pricing (cents per 1k tokens). Update when prices change.
const HAIKU_IN_CENTS_PER_1K = 0.1;
const HAIKU_OUT_CENTS_PER_1K = 0.5;

export type TriageJobDeps = {
  fetchEvent?: typeof fetchLatestEvent;
  classifier?: typeof classify;
  postComment?: typeof postTriageComment;
};

export async function handleTriageJob(
  payload: { alertId: string },
  deps: TriageJobDeps = {},
): Promise<void> {
  const fetchEvent = deps.fetchEvent ?? fetchLatestEvent;
  const classifier = deps.classifier ?? classify;
  const postComment = deps.postComment ?? postTriageComment;

  const runId = await createRun({ alertId: payload.alertId, status: "triaging" });
  log.info({ runId, alertId: payload.alertId }, "triage start");

  const alertRes = await db().query(
    `SELECT sentry_issue_id, title, level FROM alerts WHERE id = $1`,
    [payload.alertId],
  );
  const alert = alertRes.rows[0];
  if (!alert) {
    await updateRun({ id: runId, status: "triage_failed", error: "alert not found" });
    return;
  }

  let triage;
  try {
    const event = await fetchEvent(alert.sentry_issue_id);
    const stack = stackFromEvent(event);
    triage = await classifier({
      alertTitle: alert.title,
      level: alert.level,
      stackTrace: stack,
      eventTags: Array.isArray(event.tags) ? event.tags : [],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateRun({ id: runId, status: "triage_failed", error: msg });
    log.error({ err, runId }, "triage failed");
    throw err; // let pg-boss apply retry policy
  }

  const costCents = Math.round(
    (triage.tokensIn / 1000) * HAIKU_IN_CENTS_PER_1K +
      (triage.tokensOut / 1000) * HAIKU_OUT_CENTS_PER_1K,
  );

  await updateRun({
    id: runId,
    status: "triage_done",
    severity: triage.severity,
    triageSummary: triage.summary,
    suspectedFiles: triage.suspectedFiles,
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
    `_Phase 1: triage only. No PR will be opened yet._`,
  ].join("\n");

  await postComment({ sentryIssueId: alert.sentry_issue_id, body: commentBody });
  log.info({ runId, alertId: payload.alertId }, "triage done");
}

function stackFromEvent(event: { entries?: unknown[] }): string {
  if (!event.entries || !Array.isArray(event.entries)) return "(no stack trace)";
  for (const entry of event.entries) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "type" in entry &&
      (entry as { type: string }).type === "exception"
    ) {
      const data = (entry as { data?: { values?: Array<{ stacktrace?: { frames?: unknown[] } }> } })
        .data;
      const frames = data?.values?.[0]?.stacktrace?.frames ?? [];
      return JSON.stringify(frames, null, 2);
    }
  }
  return "(no exception entry)";
}
```

- [ ] **Step 3: Commit (test follows in Task 28)**

```bash
git add src/runs/persist.ts src/worker/triage-job.ts
git commit -m "feat(worker): triage job handler"
```

---

## Task 28: Worker entry + end-to-end integration test

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/src/worker/index.ts`
- Create: `/Users/shivang/dev/sentry-fixer-bot/tests/integration/triage-job.test.ts`

- [ ] **Step 1: Write `src/worker/index.ts`**

```ts
// src/worker/index.ts
import { onTriage } from "../queue/jobs.js";
import { handleTriageJob } from "./triage-job.js";
import { log } from "../log.js";

export async function startWorker(): Promise<void> {
  await onTriage(async (payload) => {
    await handleTriageJob(payload);
  });
  log.info("worker registered triage handler");
}
```

- [ ] **Step 2: Write end-to-end integration test**

```ts
// tests/integration/triage-job.test.ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { setupTestDb, teardownTestDb } from "../helpers/db.js";
import { db } from "../../src/db/client.js";
import { upsertAlert } from "../../src/alerts/persist.js";
import { handleTriageJob } from "../../src/worker/triage-job.js";

beforeEach(async () => {
  await setupTestDb();
});
afterAll(async () => {
  await teardownTestDb();
});

describe("handleTriageJob", () => {
  it("runs the full triage path and writes a run row", async () => {
    const alert = await upsertAlert({
      sentryIssueId: "1234",
      sentryProject: "p",
      fingerprint: "f",
      codeVersion: null,
      dedupKey: "k",
      title: "boom",
      level: "error",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawPayloadS3: "s3://x",
    });

    const fetchEvent = vi.fn(async () => ({
      eventID: "evt1",
      entries: [],
      tags: [{ key: "env", value: "prod" }],
    }));
    const classifier = vi.fn(async () => ({
      severity: "high" as const,
      summary: "null deref",
      suspectedFiles: ["src/a.ts"],
      confidence: 0.9,
      tokensIn: 500,
      tokensOut: 100,
    }));
    const postComment = vi.fn(async () => {});

    await handleTriageJob({ alertId: alert.id }, { fetchEvent, classifier, postComment });

    expect(fetchEvent).toHaveBeenCalledWith("1234");
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledTimes(1);
    const r = await db().query("SELECT status, severity FROM runs WHERE alert_id=$1", [alert.id]);
    expect(r.rows[0].status).toBe("triage_done");
    expect(r.rows[0].severity).toBe("high");
  });

  it("marks run as triage_failed when classifier throws", async () => {
    const alert = await upsertAlert({
      sentryIssueId: "9",
      sentryProject: "p",
      fingerprint: "f",
      codeVersion: null,
      dedupKey: "k2",
      title: "boom",
      level: "error",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      rawPayloadS3: "s3://x",
    });
    const fetchEvent = vi.fn(async () => ({ eventID: "x", entries: [], tags: [] }));
    const classifier = vi.fn(async () => {
      throw new Error("api down");
    });
    const postComment = vi.fn(async () => {});
    await expect(
      handleTriageJob({ alertId: alert.id }, { fetchEvent, classifier, postComment }),
    ).rejects.toThrow(/api down/);

    const r = await db().query("SELECT status, error FROM runs WHERE alert_id=$1", [alert.id]);
    expect(r.rows[0].status).toBe("triage_failed");
    expect(r.rows[0].error).toMatch(/api down/);
  });
});
```

- [ ] **Step 3: Run integration tests — must pass**

Run: `pnpm test tests/integration/triage-job.test.ts`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add src/worker/index.ts tests/integration/triage-job.test.ts
git commit -m "feat(worker): wiring and e2e triage test"
```

---

## **Review checkpoint A**

Before continuing, the engineer should pause and confirm:

- All unit tests pass: `pnpm test`
- The Postgres DB has `alerts`, `runs`, `budgets` and a `pgboss` schema
- Manual smoke test: send a fake webhook through `curl` (Task 32 wires this) — webhook returns 202, alert appears in `alerts` table, a `triage_done` row appears in `runs`, a comment appears on a real Sentry issue (or the mocked one)

If anything is broken, fix it here before proceeding. Phases 2 onward will assume this is solid ground.

---

## Task 29: Process dispatcher

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
  log.error({ argv }, "usage: node dist/index.js <web|worker>");
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
      log.info("SIGTERM received, draining web");
      await server.close();
      await closeDb();
      process.exit(0);
    });
  } else {
    await startWorker();
    process.on("SIGTERM", async () => {
      log.info("SIGTERM received, draining worker");
      await stopBoss();
      await closeDb();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  log.error({ err }, "fatal");
  process.exit(1);
});
```

- [ ] **Step 2: Smoke-test web mode**

Run (in a separate terminal, with Postgres up and migration applied):
```bash
PORT=3000 DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb \
SENTRY_WEBHOOK_SECRET=test SENTRY_API_TOKEN=test SENTRY_ORG_SLUG=acme \
ANTHROPIC_API_KEY=test S3_BUCKET=sfb-archives-dev S3_REGION=us-east-1 \
NODE_ENV=development pnpm dev
```
In another terminal:
```bash
curl -sf http://localhost:3000/healthz
```
Expected: `{"ok":true,"db":true}`.

Kill with Ctrl-C. Expected log line: `SIGTERM received, draining web`.

- [ ] **Step 3: Smoke-test worker mode**

```bash
DATABASE_URL=postgres://sfb:sfb@localhost:5433/sfb \
SENTRY_WEBHOOK_SECRET=test SENTRY_API_TOKEN=test SENTRY_ORG_SLUG=acme \
ANTHROPIC_API_KEY=test S3_BUCKET=sfb-archives-dev S3_REGION=us-east-1 \
NODE_ENV=development pnpm dev:worker
```
Expected log line: `worker registered triage handler`.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: process dispatcher for web|worker mode"
```

---

## Task 30: systemd units

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
ExecStart=/usr/bin/node dist/index.js web
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
ExecStart=/usr/bin/node dist/index.js worker
Restart=on-failure
RestartSec=10s
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/sfb

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 3: Commit**

```bash
git add deploy/systemd/
git commit -m "deploy: systemd units for web and worker"
```

---

## Task 31: nginx site config

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/deploy/nginx/sfb.conf`

- [ ] **Step 1: Write `sfb.conf`**

```nginx
# /etc/nginx/sites-available/sfb.conf
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
git commit -m "deploy: nginx config with TLS and rate limit"
```

---

## Task 32: Fake-alert seed script (local smoke test)

**Files:**
- Create: `/Users/shivang/dev/sentry-fixer-bot/scripts/seed-fake-alert.sh`

- [ ] **Step 1: Write `seed-fake-alert.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
# Sends a signed fake Sentry webhook to a local instance.
# Requires SENTRY_WEBHOOK_SECRET to match the running service's env.

: "${SENTRY_WEBHOOK_SECRET:?must be set}"
: "${URL:=http://localhost:3000/webhooks/sentry}"

BODY=$(cat <<'EOF'
{
  "action": "issue.created",
  "data": {
    "issue": {
      "id": "777777",
      "shortId": "PROJ-7G",
      "project": { "slug": "backend-api" },
      "title": "TypeError: cannot read property 'foo' of undefined",
      "level": "error",
      "firstSeen": "2026-05-15T10:00:00Z",
      "lastSeen": "2026-05-15T10:00:00Z",
      "metadata": { "fingerprint": "fake-fingerprint-1" }
    },
    "release": { "version": "v1.2.3" }
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

- [ ] **Step 2: Make executable**

Run: `chmod +x scripts/seed-fake-alert.sh`

- [ ] **Step 3: Manual smoke test**

In one terminal, run `pnpm dev`. In another:
```bash
SENTRY_WEBHOOK_SECRET=test ./scripts/seed-fake-alert.sh
```
Expected: `{"alertId":"...","isNew":true}` response, `alerts` row count = 1.

Re-run script twice more. Expected: `isNew=false` for the second/third, `webhook_count` = 3 in DB.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-fake-alert.sh
git commit -m "scripts: fake Sentry webhook seeder"
```

---

## Task 33: README dev guide

**Files:**
- Modify: `/Users/shivang/dev/sentry-fixer-bot/README.md`

- [ ] **Step 1: Append dev guide section to README**

Add at the bottom of `/Users/shivang/dev/sentry-fixer-bot/README.md`:

```markdown
## Local development (Phase 1)

```bash
# One-time
pnpm install
cp .env.example .env             # edit secrets
./scripts/dev-up.sh              # start Postgres in docker
pnpm db:migrate                  # apply schema

# Run web + worker in two terminals
pnpm dev                         # terminal A
pnpm dev:worker                  # terminal B

# Fire a fake webhook
SENTRY_WEBHOOK_SECRET=$(grep SENTRY_WEBHOOK_SECRET .env | cut -d= -f2) \
  ./scripts/seed-fake-alert.sh

# Inspect DB
docker compose exec postgres psql -U sfb -d sfb -c "SELECT * FROM alerts;"
docker compose exec postgres psql -U sfb -d sfb -c "SELECT * FROM runs;"
```

### Test suites

```bash
pnpm test                        # full suite (vitest)
pnpm test tests/unit             # unit only
pnpm test tests/integration      # needs docker postgres up
```

### Killing the dev stack

```bash
pnpm db:down                     # stops + keeps volume
docker compose down -v           # stops + wipes volume (full reset)
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: phase 1 local dev guide"
```

---

## Task 34: End-to-end manual verification

This is not a code task. It is the gate that says "Phase 1 is done." The engineer must execute this and record the result in the PR description.

- [ ] **Step 1: Bring up a fresh stack**

```bash
docker compose down -v
./scripts/dev-up.sh
pnpm db:migrate
```

- [ ] **Step 2: Start web and worker**

Web terminal:
```bash
pnpm dev
```
Worker terminal:
```bash
pnpm dev:worker
```

- [ ] **Step 3: Fire a webhook**

```bash
SENTRY_WEBHOOK_SECRET=$(grep SENTRY_WEBHOOK_SECRET .env | cut -d= -f2) \
  ./scripts/seed-fake-alert.sh
```

- [ ] **Step 4: Verify**

Expected within 60 seconds:
- Web log: 202 returned in <100ms, `sentry webhook deduped` (on retries)
- Worker log: `triage start` → `triage done`
- DB: `alerts` table has 1 row with `webhook_count` matching number of webhooks sent
- DB: `runs` table has 1 row with `status='triage_done'`, `severity` set, `cost_cents` > 0
- Sentry: a comment appears on the issue (use a sandbox/staging Sentry project)

- [ ] **Step 5: Verify dedup under load**

```bash
for i in $(seq 1 50); do
  SENTRY_WEBHOOK_SECRET=$(grep SENTRY_WEBHOOK_SECRET .env | cut -d= -f2) \
    ./scripts/seed-fake-alert.sh &
done
wait
```
Expected: 1 row in `alerts` with `webhook_count = 51` (original + 50 storm), exactly 1 row in `runs`. Worker did not run 51 times.

- [ ] **Step 6: Verify HMAC rejection**

```bash
curl -sS -i -X POST http://localhost:3000/webhooks/sentry \
  -H "content-type: application/json" \
  -d '{"action":"issue.created"}'
```
Expected: `HTTP/1.1 401`.

- [ ] **Step 7: Record evidence in PR**

In the PR description for the Phase 1 merge, paste:
- Log snippet from web showing 202 and triage_done
- DB query output showing single alert with elevated webhook_count
- Screenshot or copy of the Sentry comment

---

## Task 35: Tag the Phase 1 release

- [ ] **Step 1: Run the full test suite one last time**

Run: `pnpm test && pnpm lint && pnpm build`
Expected: all green.

- [ ] **Step 2: Tag**

```bash
git tag -a phase-1-complete -m "Phase 1: webhook + dedup + triage-only"
```

- [ ] **Step 3: Update implementation-plan.md**

Edit `docs/implementation-plan.md` Phase 1 section: change the section heading to `## Phase 1 — Webhook + triage-only (DONE 2026-XX-XX)` with the actual date. Update any `[ ]` boxes to `[x]` in the task list.

- [ ] **Step 4: Commit and continue to Phase 2 planning**

```bash
git add docs/implementation-plan.md
git commit -m "docs: mark phase 1 complete"
```

---

## Spec coverage self-review

Mapping each spec requirement (from `docs/design.md` and `docs/architecture.md`) to a task in this plan:

| Spec requirement | Task |
| --- | --- |
| G1: 60s webhook → triage latency | Verified in Task 34 |
| HMAC verification | Task 15 |
| Dedup by `(project, fingerprint, code_version)` | Task 17 + Task 18 |
| Sentry payload archived to S3 | Task 19 + Task 20 |
| pg-boss queue init | Task 21 |
| Triage job handler | Task 27 + Task 28 |
| Haiku classifier with structured output | Task 25 |
| Sentry comment posting | Task 26 |
| Process model: web + worker | Task 29 |
| Health endpoint | Task 14 |
| systemd units | Task 30 |
| nginx config with rate limiting | Task 31 |
| `.env.example` documented | Task 6 |
| Local dev story | Task 5 + Task 33 |
| End-to-end verification | Task 34 |

Phase 1 covers only ingestion + triage. The following spec items are explicitly **deferred to later phases**: agent spawn (Phase 2), PR creation (Phase 2), test gate (Phase 2), budget enforcement at run-time (Phase 2 minimum, full coverage Phase 3), cron jobs for PR lifecycle (Phase 3), Slack notifications (Phase 3), prompt-A/B telemetry (Phase 4). All four planning documents already record those deferrals.

## Placeholder scan

Search verified clean: no `TBD`, no `TODO`, no `implement later`, no "similar to Task N", no untyped fields. All code blocks contain runnable code. All exact file paths use absolute paths under `/Users/shivang/dev/sentry-fixer-bot/`.

## Type consistency check

- `EnqueueTriage` signature: `(alertId: string) => Promise<string>` — consistent across Task 22 (definition), Task 23 (route default), and Task 20 (test mock).
- `TriageOutput` shape: defined once in Task 25 and consumed unchanged in Task 27 + Task 28.
- `AlertUpsertResult` returned from `upsertAlert`: defined in Task 18 and consumed in Task 20.
- `CreateRunInput` / `UpdateRunInput`: defined in Task 27 and consumed only there + the Task 28 test that reads DB rows directly.

No drift detected.

---

**Plan complete and saved to `/Users/shivang/dev/sentry-fixer-bot/docs/plans/2026-05-15-phase-1-webhook-triage.md`.**
