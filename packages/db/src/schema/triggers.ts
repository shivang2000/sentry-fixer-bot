import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { reposConfig } from "./admin";

/**
 * Trigger = the addressable unit one pipeline-config row attaches to.
 * Granularity: per (source_type, source_project, repo) tuple. Example
 * rows:
 *
 *   (sentry, backend-api, acme-corp/api)
 *   (sentry, web-frontend, acme-corp/web)
 *   (posthog, signup-flow, acme-corp/web)   ← future
 *
 * Backfilled from repos_config at migration time with preset='auto_fix'
 * and default model picks. repos_config stays read-only during 2.0.x
 * and is dropped in 2.1 (P9).
 *
 * `config` is a JSONB blob validated against TriggerConfigSchema from
 * @alertforge/core. Stores per-step model picks, advanced toggles,
 * budget caps, and adapter-specific sourceConfig.
 */
export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // repo_id references repos_config.id today — that table is
    // effectively the "repos" entity. P9 drops repos_config; the
    // FK target swaps to a new repos table at that point.
    repoId: uuid("repo_id")
      .notNull()
      .references(() => reposConfig.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(),
    sourceProject: text("source_project").notNull(),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    preset: text("preset").notNull().default("auto_fix"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("triggers_source_repo_unique").on(t.sourceType, t.sourceProject, t.repoId),
    index("triggers_repo_id_idx").on(t.repoId),
    index("triggers_source_type_idx").on(t.sourceType),
  ],
);

/**
 * One row per (trigger, channel) opt-in. notify_on filters which
 * pipeline statuses fire the channel. config is the channel adapter's
 * per-trigger config (e.g. Slack webhookUrl + channel), validated by
 * the channel adapter's configSchema at insert time.
 */
export const channelConfigs = pgTable(
  "channel_configs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => triggers.id, { onDelete: "cascade" }),
    channelType: text("channel_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    notifyOn: jsonb("notify_on")
      .$type<string[]>()
      .notNull()
      .default(sql`'["pr_opened","failed"]'::jsonb`),
    config: jsonb("config").notNull(),
    lastSendAt: timestamp("last_send_at", { withTimezone: true }),
    lastSendOk: boolean("last_send_ok"),
    lastSendErr: text("last_send_err"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channel_configs_trigger_id_idx").on(t.triggerId)],
);
