CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sentry_issue_id" text NOT NULL,
	"sentry_project" text NOT NULL,
	"fingerprint" text NOT NULL,
	"code_version" text,
	"dedup_key" text NOT NULL,
	"title" text NOT NULL,
	"level" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"webhook_count" integer DEFAULT 1 NOT NULL,
	"raw_payload_s3" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alerts_dedup_key_unique" UNIQUE("dedup_key")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"repo" text NOT NULL,
	"date" date NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"cap_tokens" integer NOT NULL,
	"cap_cost_cents" integer NOT NULL,
	CONSTRAINT "budgets_repo_date_pk" PRIMARY KEY("repo","date")
);
--> statement-breakpoint
CREATE TABLE "prs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"is_draft" boolean NOT NULL,
	"needs_human" boolean DEFAULT false NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prs_repo_number_unique" UNIQUE("repo","number")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"repo" text,
	"branch" text,
	"status" text NOT NULL,
	"severity" text,
	"triage_summary" text,
	"suspected_files" jsonb,
	"stack_trace" text,
	"agent_summary" text,
	"agent_confidence" text,
	"agent_risk" text,
	"test_passed" boolean,
	"tokens_input" integer DEFAULT 0 NOT NULL,
	"tokens_output" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"log_s3" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "prs" ADD CONSTRAINT "prs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prs" ADD CONSTRAINT "prs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_sentry_issue_id_idx" ON "alerts" USING btree ("sentry_issue_id");--> statement-breakpoint
CREATE INDEX "alerts_created_at_idx" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "runs_alert_id_idx" ON "runs" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");