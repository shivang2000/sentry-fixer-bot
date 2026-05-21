CREATE TABLE "channel_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger_id" uuid NOT NULL,
	"channel_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notify_on" jsonb DEFAULT '["pr_opened","failed"]'::jsonb NOT NULL,
	"config" jsonb NOT NULL,
	"last_send_at" timestamp with time zone,
	"last_send_ok" boolean,
	"last_send_err" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_project" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"preset" text DEFAULT 'auto_fix' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triggers_source_repo_unique" UNIQUE("source_type","source_project","repo_id")
);
--> statement-breakpoint
ALTER TABLE "prs" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "prs" ADD COLUMN "outcome_recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "prs" ADD COLUMN "review_comments_jsonb" jsonb;--> statement-breakpoint
ALTER TABLE "prs" ADD COLUMN "human_commits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "steps_completed" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ctx_dir" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "ctx_archive_s3" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "was_truncated" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_configs" ADD CONSTRAINT "channel_configs_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_repo_id_repos_config_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos_config"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_configs_trigger_id_idx" ON "channel_configs" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "triggers_repo_id_idx" ON "triggers" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "triggers_source_type_idx" ON "triggers" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "runs_trigger_id_idx" ON "runs" USING btree ("trigger_id");--> statement-breakpoint

-- Data backfill: one `triggers` row per existing `repos_config` row.
-- Sentry is the only source today, preset=auto_fix matches today's
-- behavior, model picks + budget come from defaults / existing caps.
-- ON CONFLICT keeps the migration re-runnable.
INSERT INTO "triggers" ("id", "repo_id", "source_type", "source_project", "name", "preset", "config")
SELECT
  gen_random_uuid(),
  rc.id,
  'sentry',
  rc.sentry_project,
  CONCAT('Sentry → ', rc.sentry_project),
  'auto_fix',
  jsonb_build_object(
    'toggles', jsonb_build_object(
      'autoReview', false,
      'followUpLoop', false,
      'secretScanStrict', 'block'
    ),
    'models', jsonb_build_object(
      'classify', 'claude-haiku-4-5-20251001',
      'fix', 'claude-opus-4-7',
      'review', 'claude-sonnet-4-6',
      'followUp', 'claude-sonnet-4-6'
    ),
    'budget', jsonb_build_object(
      'dailyTokens', COALESCE(rc.daily_token_cap, 1000000),
      'dailyCostCents', COALESCE(rc.daily_cost_cap_cents, 2500)
    ),
    'sourceConfig', '{}'::jsonb
  )
FROM "repos_config" rc
ON CONFLICT ("source_type", "source_project", "repo_id") DO NOTHING;--> statement-breakpoint

-- Backfill runs.trigger_id by joining: runs.repo (TEXT, "owner/name") +
-- alerts.sentry_project → repos_config (github, sentry_project) →
-- triggers. Leaves trigger_id NULL where no matching repos_config row
-- exists (orphan runs from old deployments).
UPDATE "runs" r
SET "trigger_id" = t.id
FROM "alerts" a, "repos_config" rc, "triggers" t
WHERE r."trigger_id" IS NULL
  AND r."alert_id" = a.id
  AND a.sentry_project = rc.sentry_project
  AND t.source_type = 'sentry'
  AND t.source_project = rc.sentry_project
  AND t.repo_id = rc.id;--> statement-breakpoint

-- Mark repos_config as deprecated. Data stays intact during 2.0.x;
-- P9 (alertforge-2.1.0) drops the table after backfill verification.
COMMENT ON TABLE "repos_config" IS 'DEPRECATED — migrate to triggers; will drop in alertforge-2.1 (P9)';