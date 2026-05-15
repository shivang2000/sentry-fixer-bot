import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const alerts = pgTable(
  "alerts",
  {
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
  },
  (t) => [
    index("alerts_sentry_issue_id_idx").on(t.sentryIssueId),
    index("alerts_created_at_idx").on(t.createdAt),
  ],
);

export const runs = pgTable(
  "runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
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
  },
  (t) => [index("runs_alert_id_idx").on(t.alertId), index("runs_status_idx").on(t.status)],
);

export const prs = pgTable(
  "prs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    repo: text("repo").notNull(),
    number: integer("number").notNull(),
    url: text("url").notNull(),
    isDraft: boolean("is_draft").notNull(),
    needsHuman: boolean("needs_human").notNull().default(false),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("prs_repo_number_unique").on(t.repo, t.number)],
);

export const budgets = pgTable(
  "budgets",
  {
    repo: text("repo").notNull(),
    date: date("date").notNull(),
    tokensUsed: integer("tokens_used").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    capTokens: integer("cap_tokens").notNull(),
    capCostCents: integer("cap_cost_cents").notNull(),
  },
  (t) => [primaryKey({ columns: [t.repo, t.date] })],
);
