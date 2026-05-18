import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const reposConfig = pgTable("repos_config", {
  id: uuid("id").defaultRandom().primaryKey(),
  sentryProject: text("sentry_project").notNull().unique(),
  github: text("github").notNull(),
  defaultBranch: text("default_branch").notNull(),
  // Optional. When null/empty, the agent worker auto-detects the test
  // command from `package.json` (prefers `test:coverage`, falls back to
  // `test`, skips the gate entirely if neither exists). Set this only
  // to override the auto-detection — e.g. when the test command needs
  // a prefix like `npm ci && npm run test:coverage`.
  testCommand: text("test_command"),
  prReviewers: jsonb("pr_reviewers").$type<string[]>().notNull().default([]),
  dailyTokenCap: integer("daily_token_cap").notNull(),
  dailyCostCapCents: integer("daily_cost_cap_cents").notNull(),
  minSeverityToFix: text("min_severity_to_fix").notNull().default("medium"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mcpInstalls = pgTable(
  "mcp_installs",
  {
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
    installedBy: text("installed_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("mcp_installs_scope_repo_catalog_unique").on(t.scope, t.repo, t.catalogId)],
);

export const mcpSecrets = pgTable("mcp_secrets", {
  envKey: text("env_key").primaryKey(),
  description: text("description"),
  scopeHint: text("scope_hint"),
  setBy: text("set_by").references(() => user.id),
  setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
});

export const skillInstalls = pgTable(
  "skill_installs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    repo: text("repo"),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    storagePath: text("storage_path").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    installedBy: text("installed_by").references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("skill_installs_scope_repo_name_unique").on(t.scope, t.repo, t.name)],
);

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  repo: text("repo"),
  status: text("status").notNull(),
  pid: integer("pid"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_session_idx").on(t.sessionId, t.createdAt)],
);

// Singleton-ish snapshot table for the health-check cron. We never need
// history here — dashboard + doctor want the *current* state, and the
// recurring job rewrites this row on every tick. id is the literal string
// "current" so the upsert is unconditional.
export const healthSnapshots = pgTable("health_snapshots", {
  id: text("id").primaryKey(),
  payload: jsonb("payload").notNull(),
  ready: boolean("ready").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});
