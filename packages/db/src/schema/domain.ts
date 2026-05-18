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
    // Review-gate state machine.
    //   none         — no review run yet (legacy rows) or review approved.
    //   waiting_human — reviewer found a blocker, PR flipped to draft,
    //                   waiting for a /sfb-prefixed comment from an
    //                   allow-listed reviewer.
    //   in_progress  — follow-up worker is actively applying changes.
    humanReviewState: text("human_review_state").notNull().default("none"),
    // Highest comment timestamp the follow-up loop has already acted on.
    // Used by both webhook and cron paths to skip already-processed
    // comments — webhook can deliver out of order, and the cron is a
    // belt-and-braces backstop, so idempotency lives here, not in the
    // delivery layer.
    lastReviewedCommentAt: timestamp("last_reviewed_comment_at", { withTimezone: true }),
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

// Per-run log lines streamed from the triage + agent workers. Used by
// /runs/<id> to show a live tail of what claude is doing. Keep it
// append-only — no updates, just inserts indexed by (run_id, seq) so
// the UI can poll with `WHERE seq > <lastSeen>` for cheap deltas.
export const runLogs = pgTable(
  "run_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    level: text("level").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("run_logs_run_seq_idx").on(t.runId, t.seq),
    unique("run_logs_run_seq_unique").on(t.runId, t.seq),
  ],
);
