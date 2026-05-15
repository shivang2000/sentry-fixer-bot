CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"repo" text,
	"status" text NOT NULL,
	"pid" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"repo" text,
	"catalog_id" text NOT NULL,
	"display_name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_installs_scope_repo_catalog_unique" UNIQUE("scope","repo","catalog_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_secrets" (
	"env_key" text PRIMARY KEY NOT NULL,
	"description" text,
	"scope_hint" text,
	"set_by" text,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sentry_project" text NOT NULL,
	"github" text NOT NULL,
	"default_branch" text NOT NULL,
	"test_command" text NOT NULL,
	"pr_reviewers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"daily_token_cap" integer NOT NULL,
	"daily_cost_cap_cents" integer NOT NULL,
	"min_severity_to_fix" text DEFAULT 'medium' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_config_sentry_project_unique" UNIQUE("sentry_project")
);
--> statement-breakpoint
CREATE TABLE "skill_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"repo" text,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"storage_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"installed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_installs_scope_repo_name_unique" UNIQUE("scope","repo","name")
);
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_installs" ADD CONSTRAINT "mcp_installs_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_secrets" ADD CONSTRAINT "mcp_secrets_set_by_user_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos_config" ADD CONSTRAINT "repos_config_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_installed_by_user_id_fk" FOREIGN KEY ("installed_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");