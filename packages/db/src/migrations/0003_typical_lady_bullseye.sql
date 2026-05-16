CREATE TABLE "health_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"ready" boolean NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
