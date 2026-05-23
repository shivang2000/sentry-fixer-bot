-- Pre-flight: refuse to drop repos_config unless every row has a corresponding
-- trigger. The P4 backfill should have populated triggers from every
-- repos_config row; this aborts the migration if anyone is missing so the
-- operator can investigate before losing data.
DO $$
DECLARE
  rc_count INT;
  t_count INT;
BEGIN
  SELECT count(*) INTO rc_count FROM repos_config;
  SELECT count(*) INTO t_count
    FROM triggers WHERE source_type = 'sentry';
  IF t_count < rc_count THEN
    RAISE EXCEPTION 'Cannot drop repos_config: triggers count (%) < repos_config count (%). Backfill incomplete; investigate before re-running.',
      t_count, rc_count;
  END IF;
END $$;--> statement-breakpoint

-- Rename `repos_config` → `repos`. The table is the repo-identity
-- entity for the system; only the SQL name changes here. Data, the
-- triggers.repo_id FK, and the created_by FK survive intact via
-- PostgreSQL's automatic constraint rewiring on ALTER TABLE RENAME.
ALTER TABLE "repos_config" RENAME TO "repos";--> statement-breakpoint

-- Rename associated constraints to match the new table name so future
-- snapshots reconcile cleanly.
ALTER TABLE "repos" RENAME CONSTRAINT "repos_config_created_by_user_id_fk" TO "repos_created_by_user_id_fk";--> statement-breakpoint
ALTER TABLE "repos" RENAME CONSTRAINT "repos_config_sentry_project_unique" TO "repos_sentry_project_unique";--> statement-breakpoint

-- triggers.repo_id FK was named after the old target table; rename it
-- so drizzle's schema diff sees the canonical `_repos_id_fk` shape.
ALTER TABLE "triggers" RENAME CONSTRAINT "triggers_repo_id_repos_config_id_fk" TO "triggers_repo_id_repos_id_fk";
