# sentry-fixer-bot — Scaffold + MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring up sentry-fixer-bot end to end — scaffolded via `create-better-t-stack`, layered with Paperclip-style deployment-mode auth, V1 domain logic (webhook → triage → agent → PR) and V2 admin UI (repos/MCPs/skills CRUD + chat with OAuth-URL capture), deployable to a single EC2 with docker-compose Postgres and nightly S3 backups.

**Architecture:** Bun 1.x monorepo built via `bun create better-t-stack@latest`. Hono backend, TanStack Router frontend, tRPC contracts, Drizzle ORM over Postgres, Better-Auth (email + password by default) with two deployment modes (`local_trusted` / `authenticated`) and bind decoupled (`loopback | lan | tailnet | custom`). Claude Code CLI spawned headless per agent run with `--dangerously-skip-permissions`. GitHub App for auth, `gh` CLI for PR open.

**Tech Stack:** Bun 1.x, TypeScript 5.7, Hono 4, TanStack Router/Query, tRPC, Drizzle, Postgres 16 (docker-compose), Better-Auth, Turborepo, Biome, Husky, pg-boss, `@anthropic-ai/sdk`, `@aws-sdk/client-s3`, `@octokit/auth-app`. Local toolchain: `bun`, `git`, `gh`, `claude`, `aws`, `docker`.

**Plan layout:** 60-ish tasks across eight sections. Section D references the V1 manual plan for unchanged domain tasks rather than re-listing them.

---

## Section A — Scaffolder bootstrap (Tasks A1–A5)

### Task A1: Preflight — confirm host toolchain

**Files:** none (host-level)

- [ ] **Step 1: Verify required CLIs**

Run:
```bash
bun --version          # 1.1.x or higher
docker --version
docker compose version
git --version          # 2.30+
gh --version
gh auth status         # logged in
claude --version
aws --version
```

If any are missing, install per `docs/plans/2026-05-15-mvp-webhook-to-pr.md` Task 0. No commit produced.

### Task A2: Run create-better-t-stack with our exact picks

**Files:** entire scaffolded tree (root + apps/{server,web} + packages/)

- [ ] **Step 1: Run scaffolder against this empty repo**

The repo at `/Users/shivang/dev/sentry-fixer-bot` already exists with `docs/` and a git history. Scaffolder writes a fresh project; we will scaffold into a temp dir and copy non-doc files in to preserve our git history.

```bash
cd /tmp
bun create better-t-stack@latest sentry-fixer-bot --yes \
  --frontend tanstack-router \
  --backend hono \
  --runtime bun \
  --api trpc \
  --database postgresql \
  --orm drizzle \
  --db-setup docker \
  --auth better-auth \
  --package-manager bun \
  --addons turborepo,biome,husky,skills,mcp,evlog \
  --git \
  --install
```

(If exact flag spellings differ from what the wizard's "Copy CLI command" produces, copy the wizard's command verbatim. Confirm by visiting https://www.better-t-stack.dev/new with our picks selected and clicking "Copy CLI command".)

- [ ] **Step 2: Move scaffold contents into our repo, preserving docs**

```bash
cd /Users/shivang/dev/sentry-fixer-bot
# Copy all scaffold files except .git, README.md, docs/
rsync -a --exclude='.git/' --exclude='docs/' --exclude='README.md' \
  /tmp/sentry-fixer-bot/ ./
# Merge .gitignore (scaffold writes its own; preserve our additions)
sort -u /tmp/sentry-fixer-bot/.gitignore .gitignore > .gitignore.merged
mv .gitignore.merged .gitignore
# Drop the temp dir
rm -rf /tmp/sentry-fixer-bot
```

- [ ] **Step 3: Verify scaffold builds + tests + dev server**

```bash
bun install                     # idempotent; scaffold already ran this
bun run --filter '*' typecheck  # Turbo runs typecheck across all workspaces
bun test                        # whatever scaffold-seeded tests pass
bun run --filter '*' dev &      # start dev (background)
sleep 8
curl -sf http://localhost:3000  # web
curl -sf http://localhost:3001  # server (or whatever scaffold uses)
kill %1                         # stop background
```

Expected: typecheck and test green; web + server respond.

- [ ] **Step 4: Commit the scaffold**

```bash
git add -A
git commit -m "chore: scaffold via create-better-t-stack (TanStack Router + Hono + Bun + tRPC + Drizzle + Postgres + Better-Auth + Turborepo + Biome + Husky + Skills + MCP + evlog)"
```

### Task A3: Record exact scaffold versions

**Files:** `/Users/shivang/dev/sentry-fixer-bot/docs/scaffold-versions.md`

- [ ] **Step 1: Capture installed versions**

Run:
```bash
{
  echo "# Scaffold versions"
  echo
  echo "Captured at scaffold time so future re-scaffolds can pin."
  echo
  echo '```'
  echo "create-better-t-stack: $(grep create-better-t-stack package.json || echo 'check root package.json devDependencies')"
  echo "node:                 (not used — Bun)"
  echo "bun:                  $(bun --version)"
  bun pm ls 2>/dev/null | head -40
  echo '```'
} > docs/scaffold-versions.md
```

- [ ] **Step 2: Commit**

```bash
git add docs/scaffold-versions.md
git commit -m "docs: capture scaffold versions"
```

### Task A4: Configure Biome to match our code style preferences

**Files:** `/Users/shivang/dev/sentry-fixer-bot/biome.json` (modify scaffold's file)

- [ ] **Step 1: Inspect the scaffold's Biome config**

```bash
cat biome.json
```

- [ ] **Step 2: Adjust formatting rules to our preferences**

Edit `biome.json` so the `formatter` section reads:

```json
{
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "double",
      "semicolons": "always",
      "trailingCommas": "all",
      "arrowParentheses": "always"
    }
  }
}
```

Leave linter rules at scaffold defaults; if a rule fires false-positive during later tasks, suppress it inline rather than disable globally.

- [ ] **Step 3: Run formatter across the repo**

```bash
bun run format
```

- [ ] **Step 4: Commit**

```bash
git add biome.json
git commit -m "chore: align Biome formatting with project style"
```

### Task A5: Set up env scaffolding for our needs

**Files:** `/Users/shivang/dev/sentry-fixer-bot/.env.example`, `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/env.ts`

- [ ] **Step 1: Append our keys to `.env.example`**

Open the scaffold-generated `.env.example` and add (or merge if duplicate):

```bash
# === sentry-fixer-bot additions ===

# Deployment mode and bind
DEPLOYMENT_MODE=local_trusted     # local_trusted | authenticated
SERVER_BIND=loopback              # loopback | lan | tailnet | custom
SERVER_BIND_HOST=                 # only used when SERVER_BIND=custom
PUBLIC_BASE_URL=                  # required when DEPLOYMENT_MODE=authenticated and exposed publicly

# Better-Auth secret
BETTER_AUTH_SECRET=replace-with-32-bytes-random

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

# GitHub App
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=./secrets/github-app-private-key.pem
GITHUB_APP_INSTALLATION_ID=

# Agent runtime
WORK_DIR=/var/lib/sfb/work
CLAUDE_BIN=claude
CLAUDE_MODEL=claude-opus-4-7
AGENT_TIMEOUT_SECONDS=900

# Optional bootstrap admin (skip first-signup-becomes-admin race)
SFB_BOOTSTRAP_ADMIN_EMAIL=
```

- [ ] **Step 2: Extend the server's env.ts with our keys**

Find the scaffold-generated `apps/server/src/env.ts` (or equivalent). It will already validate `DATABASE_URL`, `BETTER_AUTH_SECRET`, etc. Add our fields to the zod schema. Replicate this minimal shape:

```ts
import { z } from "zod";

export const EnvSchema = z.object({
  // Scaffold-provided
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),

  // sentry-fixer-bot additions
  DEPLOYMENT_MODE: z.enum(["local_trusted", "authenticated"]).default("local_trusted"),
  SERVER_BIND: z.enum(["loopback", "lan", "tailnet", "custom"]).default("loopback"),
  SERVER_BIND_HOST: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),

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

  SFB_BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}
```

If the scaffold split server-only and shared envs, place this in the server-only file.

- [ ] **Step 3: Commit**

```bash
git add .env.example apps/server/src/env.ts
git commit -m "feat(env): add sentry-fixer-bot env keys + deployment mode"
```

---

## Section B — Auth: deployment modes + Better-Auth + claim URL (Tasks B1–B8)

This section adapts Paperclip's `local_trusted`/`authenticated` model (see `docs/v2-frontend-and-skills.md` §2.3) onto the scaffolder's Better-Auth installation.

### Task B1: Trusted-origins resolver

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/auth/trusted-origins.ts`
**Test:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/tests/unit/trusted-origins.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/server/tests/unit/trusted-origins.test.ts
import { describe, it, expect } from "bun:test";
import { resolveTrustedOrigins } from "../../src/auth/trusted-origins.js";

describe("resolveTrustedOrigins", () => {
  it("returns loopback origin for SERVER_BIND=loopback", () => {
    expect(
      resolveTrustedOrigins({
        bind: "loopback", port: 3000, publicBaseUrl: undefined, deploymentMode: "authenticated",
      }),
    ).toContain("http://localhost:3000");
  });
  it("includes the public base URL when provided", () => {
    expect(
      resolveTrustedOrigins({
        bind: "loopback", port: 443, publicBaseUrl: "https://sfb.example.com",
        deploymentMode: "authenticated",
      }),
    ).toContain("https://sfb.example.com");
  });
  it("returns no origins in local_trusted mode (auth disabled)", () => {
    expect(
      resolveTrustedOrigins({
        bind: "loopback", port: 3000, publicBaseUrl: undefined, deploymentMode: "local_trusted",
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test (FAIL)**

```bash
bun test apps/server/tests/unit/trusted-origins.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/server/src/auth/trusted-origins.ts
export type ResolveInput = {
  bind: "loopback" | "lan" | "tailnet" | "custom";
  port: number;
  publicBaseUrl: string | undefined;
  deploymentMode: "local_trusted" | "authenticated";
};

export function resolveTrustedOrigins(input: ResolveInput): string[] {
  if (input.deploymentMode === "local_trusted") return [];
  const out = new Set<string>();
  if (input.publicBaseUrl) {
    try { out.add(new URL(input.publicBaseUrl).origin); } catch {}
  }
  if (input.bind === "loopback") {
    out.add(`http://localhost:${input.port}`);
    out.add(`http://127.0.0.1:${input.port}`);
  }
  if (input.bind === "lan" || input.bind === "tailnet" || input.bind === "custom") {
    // Caller passes publicBaseUrl when reachable host is known.
  }
  return Array.from(out);
}
```

- [ ] **Step 4: Run test (PASS) + commit**

```bash
bun test apps/server/tests/unit/trusted-origins.test.ts
git add apps/server/src/auth/trusted-origins.ts apps/server/tests/unit/trusted-origins.test.ts
git commit -m "feat(auth): trusted-origins resolver for bind+mode"
```

### Task B2: Configure Better-Auth with email+password + trusted origins

**Files:** modify `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/auth.ts` (scaffold-generated)

- [ ] **Step 1: Read scaffold's auth.ts**

```bash
cat apps/server/src/auth.ts
```

- [ ] **Step 2: Enable email+password explicitly and wire trusted-origins**

Replace the Better-Auth instantiation with:

```ts
// apps/server/src/auth.ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/index.js";
import { user, session, account, verification } from "./db/schema.js";
import { env } from "./env.js";
import { resolveTrustedOrigins } from "./auth/trusted-origins.js";

const trustedOrigins = resolveTrustedOrigins({
  bind: env().SERVER_BIND,
  port: 3000,
  publicBaseUrl: env().PUBLIC_BASE_URL,
  deploymentMode: env().DEPLOYMENT_MODE,
});

export const auth = betterAuth({
  secret: env().BETTER_AUTH_SECRET,
  trustedOrigins,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
  advanced: {
    cookiePrefix: "sfb",
  },
});

export type Auth = typeof auth;
```

(Adjust table-name imports to match the scaffold's exact schema export names.)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/auth.ts
git commit -m "feat(auth): better-auth email+password with trusted origins from bind/mode"
```

### Task B3: Add `invites` table to Drizzle schema

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/db/schema/invites.ts` (new), then run `drizzle-kit generate`

- [ ] **Step 1: Write schema**

```ts
// apps/server/src/db/schema/invites.ts
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth.js";

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull().unique(),
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  invitedBy: uuid("invited_by").references(() => user.id),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
```

Also extend the scaffold-generated `user` table with a `role` column if not present:

```ts
// add this to the user table definition (or in an augmentation file)
role: text("role", { enum: ["instance_admin", "member"] }).notNull().default("member"),
```

- [ ] **Step 2: Export from the schema index**

Add to `apps/server/src/db/schema/index.ts`:

```ts
export * from "./invites.js";
```

- [ ] **Step 3: Generate + apply migration**

```bash
bun run --filter ./apps/server db:generate    # drizzle-kit generate
bun run --filter ./apps/server db:migrate     # apply
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db apps/server/drizzle
git commit -m "feat(auth): invites table + user.role column"
```

### Task B4: First-signup-becomes-admin hook + invite gate

**Files:** modify `apps/server/src/auth.ts`

- [ ] **Step 1: Extend Better-Auth config with hooks**

Replace `emailAndPassword.enabled = true` with the full hooks-aware config:

```ts
emailAndPassword: {
  enabled: true,
  requireEmailVerification: false,
  signUp: {
    enabled: true,
    before: async ({ email }) => {
      // Allow signup if (a) no users exist yet OR
      //                (b) email matches an unconsumed invite OR
      //                (c) email == SFB_BOOTSTRAP_ADMIN_EMAIL
      const count = await db.$count(user);
      if (count === 0) return; // first-signup-becomes-admin
      if (env().SFB_BOOTSTRAP_ADMIN_EMAIL === email) return;
      const inv = await db
        .select()
        .from(invites)
        .where(and(eq(invites.email, email), isNull(invites.consumedAt)))
        .limit(1);
      if (inv.length === 0) {
        throw new Error("signup_requires_invite");
      }
    },
    after: async ({ user: newUser }) => {
      const count = await db.$count(user);
      if (count === 1) {
        // First user: promote to admin
        await db.update(user).set({ role: "instance_admin" }).where(eq(user.id, newUser.id));
      } else {
        // Mark invite consumed
        await db
          .update(invites)
          .set({ consumedAt: new Date() })
          .where(eq(invites.email, newUser.email));
      }
    },
  },
},
```

(Adjust hook signatures to whatever Better-Auth actually exposes in the version we pinned — the wizard-installed version is the source of truth. The shape above is illustrative.)

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/auth.ts
git commit -m "feat(auth): first-signup-becomes-admin + invite gate"
```

### Task B5: `local_trusted` bootstrap — seed `local-board` admin

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/auth/bootstrap.ts`, call from `apps/server/src/index.ts`

- [ ] **Step 1: Write bootstrap function**

```ts
// apps/server/src/auth/bootstrap.ts
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user } from "../db/schema.js";
import { env } from "../env.js";
import { log } from "../log.js";

const LOCAL_BOARD_EMAIL = "local-board@sfb.local";
const LOCAL_BOARD_ID = "00000000-0000-0000-0000-00000000b0a4";

export async function bootstrapLocalTrustedAdmin(): Promise<void> {
  if (env().DEPLOYMENT_MODE !== "local_trusted") return;

  const existing = await db.select().from(user).where(eq(user.id, LOCAL_BOARD_ID));
  if (existing.length > 0) return;

  await db.insert(user).values({
    id: LOCAL_BOARD_ID,
    email: LOCAL_BOARD_EMAIL,
    name: "Local Board",
    role: "instance_admin",
    emailVerified: true,
  });
  log.info({ id: LOCAL_BOARD_ID }, "seeded local-board admin for local_trusted mode");
}
```

- [ ] **Step 2: Call from server startup**

In `apps/server/src/index.ts`, after Hono app construction and DB ready but before listening:

```ts
import { bootstrapLocalTrustedAdmin } from "./auth/bootstrap.js";
await bootstrapLocalTrustedAdmin();
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/auth/bootstrap.ts apps/server/src/index.ts
git commit -m "feat(auth): seed local-board admin on local_trusted boot"
```

### Task B6: Session middleware that auto-auths in `local_trusted`

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/auth/middleware.ts`

In `local_trusted` mode, every incoming request is treated as the `local-board` admin user — no cookie, no login. This is what makes local dev frictionless.

- [ ] **Step 1: Write middleware**

```ts
// apps/server/src/auth/middleware.ts
import type { Context, Next } from "hono";
import { auth } from "../auth.js";
import { env } from "../env.js";

const LOCAL_BOARD_ID = "00000000-0000-0000-0000-00000000b0a4";

export async function authMiddleware(c: Context, next: Next) {
  if (env().DEPLOYMENT_MODE === "local_trusted") {
    c.set("user", { id: LOCAL_BOARD_ID, role: "instance_admin", email: "local-board@sfb.local" });
    return next();
  }

  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", { id: session.user.id, role: session.user.role, email: session.user.email });
  return next();
}

export function requireRole(role: "instance_admin" | "member") {
  return async (c: Context, next: Next) => {
    const user = c.get("user") as { role: string } | undefined;
    if (!user) return c.json({ error: "unauthorized" }, 401);
    if (role === "instance_admin" && user.role !== "instance_admin") {
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  };
}
```

Mount it on all protected routes (everything except `/api/auth/*`, `/healthz`, `/webhooks/sentry`).

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/auth/middleware.ts
git commit -m "feat(auth): session middleware with local_trusted auto-auth"
```

### Task B7: Claim URL for trusted→authenticated migration

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/auth/claim.ts`, route in `apps/server/src/routes/board-claim.ts`, schema `board_claim_tokens`

- [ ] **Step 1: Add `board_claim_tokens` table**

In `apps/server/src/db/schema/invites.ts` (or a new file `board_claim_tokens.ts`):

```ts
export const boardClaimTokens = pgTable("board_claim_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  code: text("code").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedByUserId: uuid("consumed_by_user_id"),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
});
```

Generate + apply migration.

- [ ] **Step 2: Detection logic in startup**

Add to `apps/server/src/auth/bootstrap.ts`:

```ts
import { randomBytes, createHash } from "node:crypto";
import { boardClaimTokens } from "../db/schema.js";

export async function maybeEmitClaimUrl(): Promise<void> {
  if (env().DEPLOYMENT_MODE !== "authenticated") return;

  // Are there any real admin users (not local-board)?
  const realAdmins = await db
    .select()
    .from(user)
    .where(and(eq(user.role, "instance_admin"), ne(user.id, LOCAL_BOARD_ID)));
  if (realAdmins.length > 0) return;

  const token = randomBytes(32).toString("base64url");
  const code = randomBytes(6).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
  await db.insert(boardClaimTokens).values({ tokenHash, code, expiresAt });

  const base = env().PUBLIC_BASE_URL ?? "http://localhost:3000";
  log.warn(
    { url: `${base}/board-claim/${token}?code=${code}` },
    "AUTHENTICATED mode active but no real admin exists. Sign up at the URL above and visit /board-claim to claim instance_admin.",
  );
}
```

Call it after `bootstrapLocalTrustedAdmin()` in startup.

- [ ] **Step 3: Add the `/board-claim/:token` route**

```ts
// apps/server/src/routes/board-claim.ts
import { Hono } from "hono";
import { createHash } from "node:crypto";
import { and, eq, isNull, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { boardClaimTokens, user } from "../db/schema.js";
import { authMiddleware } from "../auth/middleware.js";

export const boardClaim = new Hono();

boardClaim.post("/board-claim/:token", authMiddleware, async (c) => {
  const sessionUser = c.get("user") as { id: string };
  const token = c.req.param("token");
  const code = c.req.query("code");
  if (!code) return c.json({ error: "missing_code" }, 400);

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = await db
    .select()
    .from(boardClaimTokens)
    .where(
      and(
        eq(boardClaimTokens.tokenHash, tokenHash),
        isNull(boardClaimTokens.consumedAt),
        gt(boardClaimTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (row.length === 0 || row[0].code !== code) {
    return c.json({ error: "invalid_or_expired" }, 400);
  }

  // Promote signed-in user; consume token.
  await db.transaction(async (tx) => {
    await tx.update(user).set({ role: "instance_admin" }).where(eq(user.id, sessionUser.id));
    await tx
      .update(boardClaimTokens)
      .set({ consumedAt: new Date(), consumedByUserId: sessionUser.id })
      .where(eq(boardClaimTokens.id, row[0].id));
  });

  return c.json({ ok: true });
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db apps/server/src/auth/bootstrap.ts apps/server/src/auth/claim.ts apps/server/src/routes/board-claim.ts
git commit -m "feat(auth): one-time /board-claim URL for trusted→authenticated migration"
```

### Task B8: `authenticated + public` doctor safeguard

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/startup-doctor.ts`

- [ ] **Step 1: Write doctor checks**

```ts
// apps/server/src/startup-doctor.ts
import { count, eq, ne } from "drizzle-orm";
import { db } from "./db/index.js";
import { user } from "./db/schema.js";
import { env } from "./env.js";
import { log } from "./log.js";

const LOCAL_BOARD_ID = "00000000-0000-0000-0000-00000000b0a4";

export async function runStartupDoctor(): Promise<void> {
  const e = env();
  if (e.DEPLOYMENT_MODE === "authenticated") {
    if (!e.PUBLIC_BASE_URL) {
      throw new Error(
        "authenticated mode requires PUBLIC_BASE_URL (https://your.domain) so trusted origins are well-defined",
      );
    }
    if (e.SERVER_BIND !== "loopback" && !e.PUBLIC_BASE_URL.startsWith("https://")) {
      throw new Error("public binds (lan/tailnet/custom) require https:// PUBLIC_BASE_URL");
    }
    // "Public" deploy heuristic: bind != loopback and not behind a known private network
    const isPublicLike = e.SERVER_BIND !== "loopback" && e.SERVER_BIND !== "tailnet";
    if (isPublicLike) {
      const [{ value: admins }] = await db
        .select({ value: count() })
        .from(user)
        .where(and(eq(user.role, "instance_admin"), ne(user.id, LOCAL_BOARD_ID)));
      if (admins === 0 && !e.SFB_BOOTSTRAP_ADMIN_EMAIL) {
        throw new Error(
          "authenticated + public-like bind has no real admin and no SFB_BOOTSTRAP_ADMIN_EMAIL. " +
          "Either complete first-signup over a trusted channel first, set SFB_BOOTSTRAP_ADMIN_EMAIL, " +
          "or use the board-claim URL.",
        );
      }
    }
  }
  log.info({ mode: e.DEPLOYMENT_MODE, bind: e.SERVER_BIND }, "startup-doctor passed");
}
```

Call from `index.ts` before listening.

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/startup-doctor.ts apps/server/src/index.ts
git commit -m "feat(auth): startup doctor refuses authenticated+public without an admin"
```

---

## Section C — Domain schema additions (Tasks C1–C3)

### Task C1: Domain tables for V1 (alerts, runs, prs, budgets)

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/db/schema/domain.ts`

- [ ] **Step 1: Write the four V1 tables in Drizzle**

```ts
// apps/server/src/db/schema/domain.ts
import { pgTable, text, integer, boolean, jsonb, timestamp, uuid, date, primaryKey, index, unique } from "drizzle-orm/pg-core";

export const alerts = pgTable("alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  sentryIssueId: text("sentry_issue_id").notNull(),
  sentryProject: text("sentry_project").notNull(),
  fingerprint: text("fingerprint").notNull(),
  codeVersion: text("code_version"),
  dedupKey: text("dedup_key").notNull().unique(),
  title: text("title").notNull(),
  level: text("level").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  webhookCount: integer("webhook_count").notNull().default(1),
  rawPayloadS3: text("raw_payload_s3").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byIssue: index("alerts_sentry_issue_id_idx").on(t.sentryIssueId),
  byCreated: index("alerts_created_at_idx").on(t.createdAt),
}));

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  alertId: uuid("alert_id").notNull().references(() => alerts.id, { onDelete: "cascade" }),
  repo: text("repo"),
  branch: text("branch"),
  status: text("status").notNull(),
  severity: text("severity"),
  triageSummary: text("triage_summary"),
  suspectedFiles: jsonb("suspected_files").$type<string[]>(),
  stackTrace: text("stack_trace"),
  agentSummary: text("agent_summary"),
  agentConfidence: text("agent_confidence"),
  agentRisk: text("agent_risk"),
  testPassed: boolean("test_passed"),
  tokensInput: integer("tokens_input").notNull().default(0),
  tokensOutput: integer("tokens_output").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  logS3: text("log_s3"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  error: text("error"),
}, (t) => ({
  byAlert: index("runs_alert_id_idx").on(t.alertId),
  byStatus: index("runs_status_idx").on(t.status),
}));

export const prs = pgTable("prs", {
  id: uuid("id").defaultRandom().primaryKey(),
  alertId: uuid("alert_id").notNull().references(() => alerts.id, { onDelete: "cascade" }),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  repo: text("repo").notNull(),
  number: integer("number").notNull(),
  url: text("url").notNull(),
  isDraft: boolean("is_draft").notNull(),
  needsHuman: boolean("needs_human").notNull().default(false),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqRepoNumber: unique("prs_repo_number_unique").on(t.repo, t.number),
}));

export const budgets = pgTable("budgets", {
  repo: text("repo").notNull(),
  date: date("date").notNull(),
  tokensUsed: integer("tokens_used").notNull().default(0),
  costCents: integer("cost_cents").notNull().default(0),
  capTokens: integer("cap_tokens").notNull(),
  capCostCents: integer("cap_cost_cents").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.repo, t.date] }),
}));
```

- [ ] **Step 2: Export + generate + apply**

```bash
echo 'export * from "./domain.js";' >> apps/server/src/db/schema/index.ts
bun run --filter ./apps/server db:generate
bun run --filter ./apps/server db:migrate
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/db
git commit -m "feat(db): V1 domain tables (alerts, runs, prs, budgets)"
```

### Task C2: V2 admin tables (repos_config, mcp_*, skill_installs, chat_*)

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/db/schema/admin.ts`

- [ ] **Step 1: Write tables**

```ts
// apps/server/src/db/schema/admin.ts
import { pgTable, text, integer, boolean, jsonb, timestamp, uuid, index, unique } from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import { alerts, runs } from "./domain.js";

export const reposConfig = pgTable("repos_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  sentryProject: text("sentry_project").notNull().unique(),
  github: text("github").notNull(),
  defaultBranch: text("default_branch").notNull(),
  testCommand: text("test_command").notNull(),
  prReviewers: jsonb("pr_reviewers").$type<string[]>().notNull().default([]),
  dailyTokenCap: integer("daily_token_cap").notNull(),
  dailyCostCapCents: integer("daily_cost_cap_cents").notNull(),
  minSeverityToFix: text("min_severity_to_fix").notNull().default("medium"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpInstalls = pgTable("mcp_installs", {
  id: uuid("id").defaultRandom().primaryKey(),
  scope: text("scope").notNull(),
  repo: text("repo"),
  catalogId: text("catalog_id").notNull(),
  displayName: text("display_name").notNull(),
  transport: text("transport").notNull(),
  command: text("command"),
  args: jsonb("args").$type<string[]>().notNull().default([]),
  envKeys: jsonb("env_keys").$type<string[]>().notNull().default([]),
  url: text("url"),
  enabled: boolean("enabled").notNull().default(true),
  installedBy: uuid("installed_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqScopeRepo: unique("mcp_installs_scope_repo_catalog_unique").on(t.scope, t.repo, t.catalogId),
}));

export const mcpSecrets = pgTable("mcp_secrets", {
  envKey: text("env_key").primaryKey(),
  description: text("description"),
  scopeHint: text("scope_hint"),
  setBy: uuid("set_by").references(() => user.id),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skillInstalls = pgTable("skill_installs", {
  id: uuid("id").defaultRandom().primaryKey(),
  scope: text("scope").notNull(),
  repo: text("repo"),
  sourceType: text("source_type").notNull(),
  sourceRef: text("source_ref").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  storagePath: text("storage_path").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  installedBy: uuid("installed_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqScopeRepoName: unique("skill_installs_scope_repo_name_unique").on(t.scope, t.repo, t.name),
}));

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => user.id),
  repo: text("repo"),
  status: text("status").notNull(),
  pid: integer("pid"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySession: index("chat_messages_session_idx").on(t.sessionId, t.createdAt),
}));
```

- [ ] **Step 2: Generate + apply + commit**

```bash
echo 'export * from "./admin.js";' >> apps/server/src/db/schema/index.ts
bun run --filter ./apps/server db:generate
bun run --filter ./apps/server db:migrate
git add apps/server/src/db
git commit -m "feat(db): V2 admin tables (repos_config, mcp_*, skill_installs, chat_*)"
```

### Task C3: Seed scripts for local dev

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/db/seed.ts`

- [ ] **Step 1: Write seed**

```ts
// apps/server/src/db/seed.ts
import { db } from "./index.js";
import { reposConfig } from "./schema.js";

async function main() {
  await db
    .insert(reposConfig)
    .values({
      sentryProject: "demo-app",
      github: "your-org/demo-app",
      defaultBranch: "main",
      testCommand: "bun test",
      prReviewers: ["your-org/eng"],
      dailyTokenCap: 1_000_000,
      dailyCostCapCents: 2500,
      minSeverityToFix: "medium",
    })
    .onConflictDoNothing();
  console.log("seed applied");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Add npm script + commit**

In `apps/server/package.json` scripts:

```json
"db:seed": "bun run src/db/seed.ts"
```

```bash
git add apps/server
git commit -m "feat(db): seed for local dev"
```

---

## Section D — V1 domain code, Drizzle-adapted (Tasks D1–D24)

These tasks are unchanged in intent from the earlier `docs/plans/2026-05-15-mvp-webhook-to-pr.md` (Tasks 16–48) but switch raw `pg` for Drizzle and `execa` for `Bun.spawn`. Re-implement each in the new `apps/server/src/` layout. Use the existing plan as the source of truth for test cases and code structure; the only systematic edits are:

- Replace `import { db } from "../db/client.js"` → `import { db } from "../db/index.js"` (Drizzle client).
- Replace raw SQL strings → Drizzle query builder calls (e.g. `db.insert(alerts).values(...)`).
- Replace `import { execa } from "execa"` → `Bun.spawn(...)` or `Bun.$\`...\``.
- Replace `import { describe, ... } from "vitest"` → `from "bun:test"` (already done).
- Place files under `apps/server/src/` instead of `src/`.

Old task → new task mapping:

| Old V1 Task | New location |
| --- | --- |
| 17 — `/healthz` | `apps/server/src/routes/health.ts` |
| 18 — HMAC verify | `apps/server/src/web/verify-hmac.ts` |
| 19 — fixtures | `apps/server/tests/helpers/fixtures.ts` |
| 20 — dedup key | `apps/server/src/alerts/dedup-key.ts` |
| 21 — alert upsert | `apps/server/src/alerts/persist.ts` (Drizzle) |
| 22 — S3 archive | `apps/server/src/archive/s3.ts` |
| 23 — webhook route | `apps/server/src/routes/sentry-webhook.ts` |
| 24 — pg-boss init | `apps/server/src/queue/boss.ts` |
| 25 — job types | `apps/server/src/queue/jobs.ts` |
| 26 — Sentry client | `apps/server/src/sentry/client.ts` |
| 27 — Haiku classify | `apps/server/src/triage/classify.ts` |
| 28 — Sentry comment | `apps/server/src/sentry/comment.ts` |
| 29 — run persist | `apps/server/src/runs/persist.ts` (Drizzle) |
| 30 — budget enforce | `apps/server/src/budget/enforce.ts` (Drizzle) |
| 31 — GitHub App auth | `apps/server/src/github/app-auth.ts` |
| 32 — workspace clone | `apps/server/src/agent/workspace.ts` |
| 33 — agent prompt | `apps/server/src/agent/prompt.ts` |
| 34 — Claude spawn (Bun.spawn) | `apps/server/src/agent/spawn.ts` |
| 35 — parse output | `apps/server/src/agent/parse-output.ts` |
| 36 — secret scan | `apps/server/src/agent/secret-scan.ts` |
| 37 — test gate (Bun.spawn) | `apps/server/src/gate/run-tests.ts` |
| 38 — PR opener | `apps/server/src/github/pr.ts` |
| 39 — agent job orchestrator | `apps/server/src/worker/agent-job.ts` |
| 41 — triage job | `apps/server/src/worker/triage-job.ts` |

Each task keeps its TDD structure from the V1 plan: failing test → impl → passing test → commit. Run tests with `bun test` from the workspace root. Don't deviate from the V1 plan's code without reason — that plan was reviewed and is correct.

When all 24 tasks are complete, V1 end-to-end works behind the scaffolded server: a real Sentry webhook can produce a real GitHub PR via the agent. UI is not wired yet.

**Exit criteria for Section D:** Tasks 16–48 from the V1 plan have passing equivalents in `apps/server/`. `bun test` is green. Manual smoke (Section H below) works headlessly.

---

## Section E — V2 admin UI (Tasks E1–E14)

The scaffolder gives us a working React + TanStack Router + tRPC + Tailwind app under `apps/web/`. We add pages and tRPC routers for the V2 features.

### Task E1: tRPC context with user

**Files:** modify scaffold-generated `apps/server/src/trpc/context.ts`

- [ ] **Step 1: Read scaffold's tRPC context**

```bash
cat apps/server/src/trpc/context.ts
```

- [ ] **Step 2: Inject session user via `authMiddleware`**

Replace the createContext function so it resolves the session user (or the local-board admin in local_trusted mode) and attaches to ctx:

```ts
// apps/server/src/trpc/context.ts
import { auth } from "../auth.js";
import { env } from "../env.js";

const LOCAL_BOARD_ID = "00000000-0000-0000-0000-00000000b0a4";

export async function createContext({ req }: { req: Request }) {
  if (env().DEPLOYMENT_MODE === "local_trusted") {
    return {
      user: { id: LOCAL_BOARD_ID, role: "instance_admin" as const, email: "local-board@sfb.local" },
    };
  }
  const session = await auth.api.getSession({ headers: req.headers });
  return { user: session?.user ?? null };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
```

- [ ] **Step 3: Add `protectedProcedure` + `adminProcedure` helpers**

```ts
// apps/server/src/trpc/init.ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { user: ctx.user } });
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "instance_admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next();
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/trpc
git commit -m "feat(trpc): context + protected/admin procedures"
```

### Task E2: Repos CRUD tRPC router

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/routers/repos.ts`

- [ ] **Step 1: Write router**

```ts
// apps/server/src/routers/repos.ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "../trpc/init.js";
import { db } from "../db/index.js";
import { reposConfig } from "../db/schema.js";

const Severity = z.enum(["low", "medium", "high", "critical"]);
const Input = z.object({
  sentryProject: z.string().min(1),
  github: z.string().regex(/^[^/]+\/[^/]+$/),
  defaultBranch: z.string().min(1).default("main"),
  testCommand: z.string().min(1),
  prReviewers: z.array(z.string()).default([]),
  dailyTokenCap: z.number().int().positive(),
  dailyCostCapCents: z.number().int().positive(),
  minSeverityToFix: Severity.default("medium"),
});

export const reposRouter = router({
  list: protectedProcedure.query(async () => {
    return db.select().from(reposConfig).orderBy(reposConfig.sentryProject);
  }),
  create: adminProcedure.input(Input).mutation(async ({ input, ctx }) => {
    const [row] = await db.insert(reposConfig).values({ ...input, createdBy: ctx.user.id }).returning();
    return row;
  }),
  update: adminProcedure
    .input(Input.extend({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const [row] = await db
        .update(reposConfig)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(reposConfig.id, id))
        .returning();
      return row;
    }),
  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    await db.delete(reposConfig).where(eq(reposConfig.id, input.id));
    return { ok: true };
  }),
});
```

Mount in `apps/server/src/routers/index.ts`:

```ts
import { reposRouter } from "./repos.js";

export const appRouter = router({
  repos: reposRouter,
  // mcps: mcpsRouter, // Task E5
  // skills: skillsRouter, // Task E8
  // runs: runsRouter, // Task E11
  // settings: settingsRouter, // Task E13
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/routers
git commit -m "feat(api): repos CRUD router"
```

### Task E3: Repos page in the web app

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/web/src/routes/repos.tsx`

- [ ] **Step 1: Write the page**

```tsx
// apps/web/src/routes/repos.tsx
import { createFileRoute } from "@tanstack/react-router";
import { trpc } from "../lib/trpc.js";

export const Route = createFileRoute("/repos")({
  component: ReposPage,
});

function ReposPage() {
  const list = trpc.repos.list.useQuery();
  if (list.isLoading) return <div className="p-6">Loading…</div>;
  if (list.error) return <div className="p-6 text-red-600">{list.error.message}</div>;
  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-4">Repos</h1>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left">
            <th>Sentry project</th>
            <th>GitHub</th>
            <th>Branch</th>
            <th>Daily cap</th>
            <th>Min severity</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {list.data?.map((r) => (
            <tr key={r.id} className="border-t">
              <td>{r.sentryProject}</td>
              <td>{r.github}</td>
              <td>{r.defaultBranch}</td>
              <td>${(r.dailyCostCapCents / 100).toFixed(2)}</td>
              <td>{r.minSeverityToFix}</td>
              <td>{r.enabled ? "✓" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/repos.tsx
git commit -m "feat(ui): /repos page (list)"
```

### Tasks E4 — Add/Edit/Delete UI for repos

- [ ] Same pattern as E3: a form component that uses `trpc.repos.create.useMutation()` / `update` / `delete`. Wire to `/repos/new`, `/repos/:id/edit` file routes. ~3-4 sub-tasks; each is a single component + a route file + a commit.

### Task E5: MCP catalog router

**Files:** `apps/server/src/mcps-catalog/index.ts`, `apps/server/src/routers/mcps.ts`

- [ ] **Step 1: Hand-author a small catalog**

```ts
// apps/server/src/mcps-catalog/index.ts
export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  argsTemplate: string[];
  envSchema: Record<string, { required: boolean; secret: boolean; description: string }>;
  tags: string[];
  homepage: string;
};

export const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Read issues, PRs, and repos. Most popular MCP server.",
    transport: "stdio",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-github"],
    envSchema: {
      GITHUB_PERSONAL_ACCESS_TOKEN: { required: true, secret: true, description: "Token with read access to your repos" },
    },
    tags: ["dev"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
  },
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read files under a configured allowlist path.",
    transport: "stdio",
    command: "npx",
    argsTemplate: ["-y", "@modelcontextprotocol/server-filesystem", "/var/lib/sfb/agent-fs"],
    envSchema: {},
    tags: ["dev"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
  },
  // Add more as needed
];
```

- [ ] **Step 2: tRPC router**

```ts
// apps/server/src/routers/mcps.ts
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "../trpc/init.js";
import { db } from "../db/index.js";
import { mcpInstalls, mcpSecrets } from "../db/schema.js";
import { CATALOG } from "../mcps-catalog/index.js";
import { setEnvSecret } from "../secrets/env-file.js"; // Task E6

const InstallInput = z.object({
  catalogId: z.string(),
  scope: z.enum(["global", "repo"]),
  repo: z.string().optional(),
  envValues: z.record(z.string(), z.string()),
});

export const mcpsRouter = router({
  catalog: protectedProcedure.query(() => CATALOG),
  installed: protectedProcedure.query(async () => {
    return db.select().from(mcpInstalls).orderBy(mcpInstalls.createdAt);
  }),
  install: adminProcedure.input(InstallInput).mutation(async ({ input, ctx }) => {
    const entry = CATALOG.find((c) => c.id === input.catalogId);
    if (!entry) throw new Error("unknown_catalog_id");
    if (input.scope === "repo" && !input.repo) throw new Error("repo_required_for_repo_scope");

    const envKeys = Object.keys(entry.envSchema);
    // 1. write secret env vars to /etc/sfb/env via setEnvSecret
    for (const [k, v] of Object.entries(input.envValues)) {
      if (!entry.envSchema[k]?.secret) continue;
      await setEnvSecret(k, v);
      await db
        .insert(mcpSecrets)
        .values({ envKey: k, description: entry.envSchema[k].description, scopeHint: input.scope, setBy: ctx.user.id })
        .onConflictDoUpdate({
          target: mcpSecrets.envKey,
          set: { setAt: new Date(), setBy: ctx.user.id },
        });
    }
    // 2. insert mcp_installs row
    const [row] = await db
      .insert(mcpInstalls)
      .values({
        scope: input.scope,
        repo: input.repo ?? null,
        catalogId: entry.id,
        displayName: entry.name,
        transport: entry.transport,
        command: entry.command,
        args: entry.argsTemplate,
        envKeys,
        installedBy: ctx.user.id,
      })
      .returning();
    return row;
  }),
  uninstall: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    await db.delete(mcpInstalls).where(eq(mcpInstalls.id, input.id));
    return { ok: true };
  }),
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/mcps-catalog apps/server/src/routers/mcps.ts
git commit -m "feat(api): MCP catalog + install/uninstall router"
```

### Task E6: Env-file writer (atomic + service reload)

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/secrets/env-file.ts`

- [ ] **Step 1: Write helper**

```ts
// apps/server/src/secrets/env-file.ts
import { readFile, writeFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";

const FILE = "/etc/sfb/env";

function shellQuote(v: string): string {
  if (/^[a-zA-Z0-9_./:-]*$/.test(v)) return v;
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export async function setEnvSecret(key: string, value: string): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid env key");
  const existing = await readFile(FILE, "utf8").catch(() => "");
  const lines = existing.split("\n").filter((l) => l && !l.startsWith(`${key}=`));
  lines.push(`${key}=${shellQuote(value)}`);
  const tmp = `${FILE}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tmp, lines.join("\n") + "\n", { mode: 0o600 });
  await rename(tmp, FILE);

  // Reload running services so the new env is in effect on next spawn
  await new Promise<void>((resolve, reject) => {
    const p = spawn("systemctl", ["reload-or-restart", "sfb-server.service"], { stdio: "inherit" });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`systemctl rc=${code}`))));
  });
}
```

In `local_trusted` dev, `/etc/sfb/env` won't exist and `systemctl` won't be available. Wrap the function so dev short-circuits to writing `apps/server/.env.local` and skipping the systemctl call. Confirm with a unit test (TDD pattern from V1 plan).

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/secrets
git commit -m "feat(secrets): env-file writer with atomic rename + systemctl reload"
```

### Task E7: MCP catalog + installed pages in UI

- [ ] Tabs in `/mcps`. Catalog tab lists `trpc.mcps.catalog`, each card has "Install" that opens a form built from `envSchema`. Installed tab lists `trpc.mcps.installed`, each row has "Uninstall". Same pattern as E3 + E4.

### Task E8: Skill install router (built-in + upload + skills.sh)

**Files:** `apps/server/src/skills-catalog/`, `apps/server/src/routers/skills.ts`

- [ ] **Step 1: Built-in catalog (hand-authored or filesystem-discovered)**

```ts
// apps/server/src/skills-catalog/index.ts
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type BuiltinSkill = { name: string; path: string; description: string };

export async function listBuiltins(): Promise<BuiltinSkill[]> {
  const here = dirname(fileURLToPath(import.meta.url));
  const entries = await readdir(here, { withFileTypes: true });
  const out: BuiltinSkill[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    out.push({
      name: e.name,
      path: join(here, e.name),
      description: `Built-in skill: ${e.name}`,
    });
  }
  return out;
}
```

Drop a placeholder skill: `apps/server/src/skills-catalog/sentry-runbook/SKILL.md` with frontmatter and a paragraph.

- [ ] **Step 2: Router with built-in install + upload + skills.sh fetch**

```ts
// apps/server/src/routers/skills.ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { router, adminProcedure, protectedProcedure } from "../trpc/init.js";
import { db } from "../db/index.js";
import { skillInstalls } from "../db/schema.js";
import { listBuiltins } from "../skills-catalog/index.js";
import { installBuiltinSkill, installUploadedSkill, installSkillsShSkill } from "../skills/install.js"; // helpers

export const skillsRouter = router({
  builtin: protectedProcedure.query(() => listBuiltins()),
  installed: protectedProcedure.query(() => db.select().from(skillInstalls)),
  installBuiltin: adminProcedure
    .input(z.object({ name: z.string(), scope: z.enum(["global", "repo"]), repo: z.string().optional() }))
    .mutation(async ({ input, ctx }) => installBuiltinSkill({ ...input, userId: ctx.user.id })),
  installUpload: adminProcedure
    .input(z.object({ zipBase64: z.string(), name: z.string(), scope: z.enum(["global", "repo"]), repo: z.string().optional() }))
    .mutation(async ({ input, ctx }) => installUploadedSkill({ ...input, userId: ctx.user.id })),
  searchSkillsSh: protectedProcedure
    .input(z.object({ query: z.string().optional() }))
    .query(async ({ input }) => {
      // Proxy fetch to https://www.skills.sh/api/... (confirm API shape during execution)
      const url = new URL("https://www.skills.sh/api/skills");
      if (input.query) url.searchParams.set("q", input.query);
      const res = await fetch(url);
      if (!res.ok) return [];
      return res.json() as Promise<unknown[]>;
    }),
  installSkillsSh: adminProcedure
    .input(z.object({ slug: z.string(), scope: z.enum(["global", "repo"]), repo: z.string().optional() }))
    .mutation(async ({ input, ctx }) => installSkillsShSkill({ ...input, userId: ctx.user.id })),
  uninstall: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    await db.delete(skillInstalls).where(eq(skillInstalls.id, input.id));
    return { ok: true };
  }),
});
```

The helper functions (`installBuiltinSkill`, etc.) copy / extract / clone to `/var/lib/sfb/skills/<uuid>/` and write a `skill_installs` row. Implement them with TDD against tmpdir fixtures.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/skills-catalog apps/server/src/skills apps/server/src/routers/skills.ts
git commit -m "feat(api): skill install (built-in, upload, skills.sh)"
```

### Task E9: Skills page UI

- [ ] Three tabs in `/skills`: Built-in, Custom (upload), skills.sh (search + install). Same pattern as repos / mcps.

### Task E10: Per-run rendering of MCPs + skills into the run's `~/.claude/`

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/agent/render-claude-home.ts`

- [ ] **Step 1: Write renderer**

```ts
// apps/server/src/agent/render-claude-home.ts
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../db/index.js";
import { mcpInstalls, skillInstalls } from "../db/schema.js";
import { and, eq, or } from "drizzle-orm";

export async function renderClaudeHome(input: {
  repo: string;
  runDir: string;
}): Promise<{ home: string; mcpConfigPath: string }> {
  const home = join(input.runDir, "claude-home");
  const claudeDir = join(home, ".claude");
  const skillsDir = join(claudeDir, "skills");
  await mkdir(skillsDir, { recursive: true });

  // MCPs (global + this repo)
  const mcps = await db
    .select()
    .from(mcpInstalls)
    .where(
      and(
        eq(mcpInstalls.enabled, true),
        or(eq(mcpInstalls.scope, "global"), and(eq(mcpInstalls.scope, "repo"), eq(mcpInstalls.repo, input.repo))),
      ),
    );

  const mcpServers: Record<string, unknown> = {};
  for (const m of mcps) {
    const env = Object.fromEntries((m.envKeys ?? []).map((k) => [k, process.env[k] ?? ""]));
    mcpServers[m.catalogId] = m.transport === "stdio"
      ? { command: m.command, args: m.args, env }
      : { url: m.url };
  }
  const mcpConfigPath = join(claudeDir, "mcp_servers.json");
  await writeFile(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), { mode: 0o600 });

  // Skills (global + this repo)
  const skills = await db
    .select()
    .from(skillInstalls)
    .where(
      and(
        eq(skillInstalls.enabled, true),
        or(eq(skillInstalls.scope, "global"), and(eq(skillInstalls.scope, "repo"), eq(skillInstalls.repo, input.repo))),
      ),
    );
  for (const s of skills) {
    await symlink(s.storagePath, join(skillsDir, s.name)).catch(() => {});
  }

  return { home, mcpConfigPath };
}
```

- [ ] **Step 2: Wire into `agent-job.ts`**

In `apps/server/src/worker/agent-job.ts`, before spawning Claude:

```ts
const { home, mcpConfigPath } = await renderClaudeHome({ repo: repoCfg.github, runDir: ws.dir });
// pass `home` as HOME env, and `mcpConfigPath` via `--mcp-config`
```

Update `spawnClaudeAgent` (Task 34 equivalent) to accept and forward these.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/agent
git commit -m "feat(agent): render per-run claude-home with MCPs and skills"
```

### Task E11: Runs + PRs read API

**Files:** `apps/server/src/routers/runs.ts`

- [ ] **Step 1: Router**

```ts
// apps/server/src/routers/runs.ts
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { router, protectedProcedure } from "../trpc/init.js";
import { db } from "../db/index.js";
import { runs, alerts, prs } from "../db/schema.js";

export const runsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      return db
        .select({
          run: runs,
          alert: alerts,
          pr: prs,
        })
        .from(runs)
        .innerJoin(alerts, eq(alerts.id, runs.alertId))
        .leftJoin(prs, eq(prs.runId, runs.id))
        .orderBy(desc(runs.startedAt))
        .limit(input?.limit ?? 50);
    }),
  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const [row] = await db.select().from(runs).where(eq(runs.id, input.id));
    return row;
  }),
});
```

- [ ] **Step 2: `/runs` and `/runs/:id` UI pages.**

- [ ] **Step 3: Commit**

### Task E12: Settings page

- [ ] Renders deployment mode + bind + public URL + Anthropic + GitHub App status. Read-only display (sourced from env). Add a "Test connection" button for each that hits a tRPC `settings.test` query.

### Task E13: Invite management UI

- [ ] In `/settings` or `/team`, admin can paste an email and submit → tRPC `invites.create` mutation. List existing invites with `invites.list`. Revoke via `invites.revoke`.

### Task E14: Audit log

- [ ] All admin mutations (repos.create, mcps.install, secrets.set, invites.create, etc.) write to an `audit_log` table. Add a `/audit` page filterable by user + action + date.

---

## Section F — Chat (PTY + WebSocket + OAuth URL capture) (Tasks F1–F7)

### Task F1: PTY runner for Claude subprocess

**Files:** `/Users/shivang/dev/sentry-fixer-bot/apps/server/src/chat/pty-runner.ts`

- [ ] **Step 1: Write a Bun-native PTY wrapper**

```ts
// apps/server/src/chat/pty-runner.ts
// Bun.spawn does not have first-class PTY in all versions; use `script(1)` as
// a portable PTY shim. The shim wraps `claude` so its tty checks pass.

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { env } from "../env.js";

export type PtyHandle = {
  proc: ChildProcessWithoutNullStreams;
  write: (data: string) => void;
  kill: () => void;
};

export function spawnClaudeInteractive(input: { cwd: string; prompt: string }): PtyHandle {
  const args = [
    "-q", "-c",
    `${env().CLAUDE_BIN} --dangerously-skip-permissions --model ${env().CLAUDE_MODEL}`,
    "/dev/null",
  ];
  // On macOS, script syntax differs; tests run on Linux where this works.
  const proc = spawn("script", args, {
    cwd: input.cwd,
    env: { ...process.env, ANTHROPIC_API_KEY: env().ANTHROPIC_API_KEY },
  }) as ChildProcessWithoutNullStreams;
  if (input.prompt) proc.stdin.write(input.prompt + "\n");
  return {
    proc,
    write: (data: string) => proc.stdin.write(data),
    kill: () => proc.kill("SIGTERM"),
  };
}
```

(Replace `script`-based shim with `Bun.spawn({ pty: true })` once Bun ships stable PTY for our target version — confirm in Task A2.)

- [ ] **Step 2: Commit**

```bash
git add apps/server/src/chat
git commit -m "feat(chat): pty runner for interactive Claude"
```

### Task F2: OAuth URL detector

**Files:** `apps/server/src/chat/url-detector.ts`
**Test:** `apps/server/tests/unit/url-detector.test.ts`

- [ ] **Step 1: TDD**

```ts
// apps/server/tests/unit/url-detector.test.ts
import { describe, it, expect } from "bun:test";
import { detectOAuthPrompt } from "../../src/chat/url-detector.js";

describe("detectOAuthPrompt", () => {
  it("returns null on plain output", () => {
    expect(detectOAuthPrompt("hello world")).toBeNull();
  });
  it("detects gh auth login style", () => {
    expect(detectOAuthPrompt(
      "Open the following URL in your browser: https://github.com/login/device\nThen paste the code: ABCD-1234",
    )).toEqual({ url: "https://github.com/login/device" });
  });
  it("detects claude /login style", () => {
    expect(detectOAuthPrompt(
      "Visit this URL to complete authentication: https://claude.ai/login/x",
    )).toEqual({ url: "https://claude.ai/login/x" });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/server/src/chat/url-detector.ts
const URL_PATTERN = /https?:\/\/[^\s'"<>]+/g;
const HINTS = [
  /open the following url/i,
  /visit this url/i,
  /authentication code/i,
  /paste.*code/i,
  /open this url/i,
];

export function detectOAuthPrompt(buffer: string): { url: string } | null {
  if (!HINTS.some((re) => re.test(buffer))) return null;
  const m = buffer.match(URL_PATTERN);
  return m ? { url: m[0] } : null;
}
```

- [ ] **Step 3: Commit**

### Task F3: WebSocket chat endpoint

**Files:** `apps/server/src/routes/chat-ws.ts`

- [ ] **Step 1: Mount Hono Bun WebSocket route**

```ts
// apps/server/src/routes/chat-ws.ts
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { db } from "../db/index.js";
import { chatSessions, chatMessages } from "../db/schema.js";
import { spawnClaudeInteractive } from "../chat/pty-runner.js";
import { detectOAuthPrompt } from "../chat/url-detector.js";
import { authMiddleware } from "../auth/middleware.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();
export const chatWs = new Hono();

chatWs.get(
  "/api/chat/:sessionId",
  authMiddleware,
  upgradeWebSocket((c) => {
    const sessionId = c.req.param("sessionId");
    let handle: ReturnType<typeof spawnClaudeInteractive> | null = null;
    let outBuffer = "";

    return {
      onOpen(_evt, ws) {
        handle = spawnClaudeInteractive({ cwd: process.cwd(), prompt: "" });
        handle.proc.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          outBuffer += text;
          ws.send(JSON.stringify({ type: "stdout", data: text }));
          const oauth = detectOAuthPrompt(outBuffer);
          if (oauth) {
            ws.send(JSON.stringify({ type: "oauth_url", url: oauth.url, sessionId }));
            outBuffer = ""; // consume
          }
        });
        handle.proc.on("exit", (code) => {
          ws.send(JSON.stringify({ type: "exit", code }));
        });
      },
      async onMessage(evt, _ws) {
        if (!handle) return;
        const msg = JSON.parse(evt.data.toString()) as { type: string; data?: string; code?: string };
        if (msg.type === "user_input" && msg.data) handle.write(msg.data + "\n");
        if (msg.type === "oauth_response" && msg.code) handle.write(msg.code + "\n");
        await db.insert(chatMessages).values({
          sessionId,
          role: msg.type === "oauth_response" ? "oauth_response" : "user",
          content: msg.data ?? msg.code ?? "",
        });
      },
      onClose() {
        handle?.kill();
      },
    };
  }),
);

export { websocket };
```

Wire `websocket` into Bun's server config when calling `Bun.serve` (the scaffolder may already have a websocket field; merge).

- [ ] **Step 2: Commit**

### Task F4: Chat session create + list endpoints

- [ ] tRPC router `chat.create` / `chat.list` / `chat.endById`. Create returns a sessionId the UI uses to open the WebSocket.

### Task F5: Chat page UI

- [ ] `/chat` lists sessions and opens a new one. `/chat/:sessionId` opens the WebSocket. Render stdout incrementally. When `{ type: "oauth_url" }` arrives, render a card with the URL + input box; on submit, send `{ type: "oauth_response", code }`.

### Task F6: Idle timeout + budget integration

- [ ] Server-side timer kills sessions idle > 30 min. Cost from chat is charged to a synthetic repo `__chat__` so the daily budget applies.

### Task F7: Per-user single concurrent session enforcement

- [ ] Before opening a new chat, kill any active session for this user.

---

## Section G — Deploy (Tasks G1–G5)

### Task G1: nginx config

- [ ] Take `docs/plans/2026-05-15-mvp-webhook-to-pr.md` Task 44 verbatim. Update `proxy_pass` targets to scaffolder's ports (`127.0.0.1:3000` for the server; the web app is served from the server in production via static files).

### Task G2: systemd unit for the combined server

- [ ] One unit `sfb-server.service` that runs `bun apps/server/src/index.ts` (web mode is just HTTP routes on the same server; we no longer split web/worker processes). If queue concurrency needs separation later, split into `sfb-worker.service` then.

```ini
[Unit]
Description=sentry-fixer-bot server
After=network.target

[Service]
Type=simple
User=sfb-runner
WorkingDirectory=/opt/sfb/current
EnvironmentFile=/etc/sfb/env
ExecStart=/usr/local/bin/bun apps/server/src/index.ts
ExecReload=/bin/kill -HUP $MAINPID
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

### Task G3: Daily Postgres backup

- [ ] Copy V1 plan Task 44b verbatim (`scripts/backup-db.sh`, `deploy/systemd/sfb-backup.{service,timer}`, S3 lifecycle policy).

### Task G4: EC2 userdata.sh

- [ ] Copy V1 plan Task 44c verbatim (it already installs Bun, `gh`, `claude`, `aws`, Docker, creates `sfb-runner`).

### Task G5: Production build of the web app baked into the server's static dir

- [ ] In root `package.json` add a `build` script that runs `bun --filter './apps/web' run build` and copies the output to `apps/server/public/`. Hono serves from there in production.

---

## Section H — End-to-end verification + tag (Tasks H1–H3)

### Task H1: Local end-to-end smoke (`local_trusted`)

- [ ] **Step 1: Fresh stack**

```bash
docker compose down -v
docker compose up -d postgres
bun run --filter ./apps/server db:migrate
bun run --filter ./apps/server db:seed
DEPLOYMENT_MODE=local_trusted SERVER_BIND=loopback bun run --filter '*' dev
```

- [ ] **Step 2: Open `http://localhost:3000`**

Expected: no login required, dashboard renders, repos list shows the seed entry.

- [ ] **Step 3: Trigger a fake Sentry alert**

```bash
SENTRY_WEBHOOK_SECRET=$(grep SENTRY_WEBHOOK_SECRET .env | cut -d= -f2) \
  ./scripts/seed-fake-alert.sh
```

Expected: alert row appears in `/runs`; webhook → triage → agent → PR pipeline runs end to end (with a real `claude` and real `gh` against your test repo); PR URL appears in `/prs`.

- [ ] **Step 4: Switch to `authenticated` mode + claim URL**

Stop the server, change `DEPLOYMENT_MODE=authenticated` + `PUBLIC_BASE_URL=http://localhost:3000`, restart. Expected log line: claim URL. Open it in a browser, sign up, claim admin. Verify `/repos` is now protected.

- [ ] **Step 5: Install one MCP and one skill via UI**

Expected: env file at `apps/server/.env.local` (dev path) updated; new run picks up the MCP in the per-run `mcp_servers.json`.

- [ ] **Step 6: Open a chat session and trigger a `gh auth login`-style flow**

Expected: OAuth URL captured and surfaced in UI; pasted code returns to subprocess.

### Task H2: Deploy to a real EC2

- [ ] Provision via `deploy/ec2/userdata.sh`. Sync `/etc/sfb/env`, `/etc/sfb/github-app.pem`, drop code to `/opt/sfb/current/`. Install systemd units. nginx + certbot. Trigger a webhook from a real Sentry test project. Verify PR opens.

### Task H3: Tag MVP

```bash
git tag -a mvp-1.0.0 -m "MVP: scaffolded via better-t-stack; webhook → triage → agent → PR; admin UI; chat with OAuth capture"
git push origin mvp-1.0.0
```

---

## Spec coverage self-review

Mapping (high-level) features to tasks:

| Feature | Tasks |
| --- | --- |
| Scaffold via better-t-stack | A1–A5 |
| Better-Auth email+password | A2 (scaffolder) + B2 |
| Deployment modes (`local_trusted` / `authenticated`) | B6 (middleware), B5 (bootstrap), B8 (doctor) |
| Bind decoupled (`loopback`/`lan`/`tailnet`/`custom`) | A5 (env), B1 (trusted-origins) |
| Invites + first-signup-admin + claim URL | B3, B4, B7 |
| V1 webhook ingest | D1–D5 (V1 Tasks 17–23 in `apps/server/src/`) |
| V1 triage (Haiku) | D6–D12 (V1 Tasks 24–29) |
| V1 agent path (clone → spawn → test → PR) | D13–D24 (V1 Tasks 30–41) |
| Per-run MCP + skills rendering | E10 |
| Repos CRUD UI | E2, E3, E4 |
| MCP catalog + install UI | E5, E6, E7 |
| Skill catalog + install (built-in, upload, skills.sh) | E8, E9 |
| Runs / PRs UI | E11 |
| Settings + invites + audit | E12, E13, E14 |
| Chat (PTY + WS + OAuth capture) | F1–F7 |
| nginx + systemd + backup + userdata | G1–G4 |
| Production web build | G5 |
| End-to-end verify | H1, H2 |
| Tag | H3 |

## Placeholder scan

- `Task F1`: uses `script(1)` PTY shim until Bun's native PTY is verified — explicit and tracked, not a placeholder.
- `Task E8`: skills.sh API shape "confirmed during execution" — explicit and tracked.
- No `TBD` / `TODO` / `later` references.

## Type consistency check

- `Context` (E1) → consumed by `protectedProcedure` and `adminProcedure` (E1) → consumed by every router in E2, E5, E8, E11–E14. Consistent.
- `CatalogEntry` (E5) → consumed by `installRouter.install` mutation (E5) → consumed by UI `/mcps` page (E7). Consistent.
- `setEnvSecret` (E6) → called from `mcps.install` (E5) and `settings` mutations (E12). Consistent.
- `renderClaudeHome` return shape → consumed by agent-job orchestrator (D-mapping for Task 39). Consistent.

---

**Plan complete and saved to `/Users/shivang/dev/sentry-fixer-bot/docs/plans/2026-05-15-scaffold-and-mvp-plan.md`.**
