ALTER TABLE "prs" ADD COLUMN "human_review_state" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "prs" ADD COLUMN "last_reviewed_comment_at" timestamp with time zone;