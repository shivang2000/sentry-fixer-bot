---
spec: trigger-config-schema
title: Trigger config schema + DB tables
status: accepted
date: 2026-05-21
authors: ops
adrs:
  - ADR-0005-three-presets-not-toggle-list
related_specs:
  - pluggable-pipeline-design
  - ui-surface
plan_phases:
  - 2026-05-21-phase-4-triggers-schema
---

# Trigger config schema

## Table: `triggers`

```sql
CREATE TABLE triggers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id         UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,                  -- 'sentry' | 'posthog' | 'pagerduty' | ...
  source_project  TEXT NOT NULL,
  name            TEXT NOT NULL,                  -- human label
  enabled         BOOLEAN NOT NULL DEFAULT true,
  preset          TEXT NOT NULL DEFAULT 'auto_fix',
                                                  -- 'triage_only' | 'auto_fix' | 'auto_fix_review' | 'custom'
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_project, repo_id)
);
CREATE INDEX triggers_repo_id_idx ON triggers(repo_id);
CREATE INDEX triggers_source_type_idx ON triggers(source_type);
```

## `config` JSONB shape (zod-validated)

```ts
// packages/alertforge-core/src/config.schema.ts
export const TriggerConfigSchema = z.object({
  toggles: z.object({
    autoReview: z.boolean().default(false),
    followUpLoop: z.boolean().default(false),
    secretScanStrict: z.enum(['block', 'warn']).default('block'),
  }).default({}),
  models: z.object({
    classify: z.string().default('claude-haiku-4-5-20251001'),
    fix: z.string().default('claude-opus-4-7'),
    review: z.string().default('claude-sonnet-4-6'),
    followUp: z.string().default('claude-sonnet-4-6'),
  }).default({}),
  budget: z.object({
    dailyTokens: z.number().int().positive().default(1_000_000),
    dailyCostCents: z.number().int().nonnegative().default(2500),
  }).default({}),
  sourceConfig: z.record(z.unknown()).default({}),   // adapter-specific config validated by adapter's configSchema
});
export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;
```

## Effective config (preset → resolved)

`packages/alertforge-core/src/preset.ts`:

```ts
export function resolvePreset(trigger: TriggerRow): ResolvedConfig {
  const base = TriggerConfigSchema.parse(trigger.config);
  switch (trigger.preset) {
    case 'triage_only':
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: false, followUpLoop: false },
        stopAfter: 'budget',                      // pipeline halts after budget+notify
      };
    case 'auto_fix':
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: false, followUpLoop: false },
      };
    case 'auto_fix_review':
      return {
        ...base,
        toggles: { ...base.toggles, autoReview: true, followUpLoop: false },
      };
    case 'custom':
    default:
      return base;
  }
}
```

## Table: `channel_configs`

```sql
CREATE TABLE channel_configs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id    UUID NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  channel_type  TEXT NOT NULL,                    -- 'slack' | 'email' | ...
  enabled       BOOLEAN NOT NULL DEFAULT true,
  notify_on     JSONB NOT NULL DEFAULT '["pr_opened","failed"]'::jsonb,
                                                  -- subset of pipeline notification statuses
  config        JSONB NOT NULL,                   -- channel-adapter-validated shape
  last_send_at  TIMESTAMPTZ,
  last_send_ok  BOOLEAN,
  last_send_err TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channel_configs_trigger_id_idx ON channel_configs(trigger_id);
```

## Additions to existing tables

```sql
-- runs additions
ALTER TABLE runs ADD COLUMN trigger_id UUID REFERENCES triggers(id) ON DELETE SET NULL;
ALTER TABLE runs ADD COLUMN steps_completed JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE runs ADD COLUMN ctx_dir TEXT;          -- absolute path during the run
ALTER TABLE runs ADD COLUMN ctx_archive_s3 TEXT;   -- s3 key after archive
ALTER TABLE runs ADD COLUMN was_truncated JSONB NOT NULL DEFAULT '{}'::jsonb;

-- prs additions (for self-improvement loop V1)
ALTER TABLE prs ADD COLUMN outcome TEXT;
ALTER TABLE prs ADD COLUMN outcome_recorded_at TIMESTAMPTZ;
ALTER TABLE prs ADD COLUMN review_comments_jsonb JSONB;
```

## Migration 0003 — data backfill from `repos_config`

```sql
-- one trigger per existing repos_config row
INSERT INTO triggers (id, repo_id, source_type, source_project, name, preset, config)
SELECT
  gen_random_uuid(),
  rc.repo_id,
  'sentry',
  rc.sentry_project,
  CONCAT('Sentry → ', rc.sentry_project),
  'auto_fix',
  jsonb_build_object(
    'toggles', jsonb_build_object('autoReview', false, 'followUpLoop', false, 'secretScanStrict', 'block'),
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
FROM repos_config rc
ON CONFLICT (source_type, source_project, repo_id) DO NOTHING;

-- channel_configs for any repos_config.slack_channel
INSERT INTO channel_configs (id, trigger_id, channel_type, config)
SELECT
  gen_random_uuid(),
  t.id,
  'slack',
  jsonb_build_object('webhookUrl', 'TBD_SET_VIA_UI', 'channel', rc.slack_channel)
FROM triggers t
JOIN repos_config rc
  ON t.source_type = 'sentry'
 AND t.source_project = rc.sentry_project
 AND t.repo_id = rc.repo_id
WHERE rc.slack_channel IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM channel_configs cc
    WHERE cc.trigger_id = t.id AND cc.channel_type = 'slack'
  );

-- backfill runs.trigger_id where possible
UPDATE runs r
SET trigger_id = t.id
FROM triggers t, repos_config rc
WHERE r.trigger_id IS NULL
  AND r.repo = rc.github_repo
  AND t.source_type = 'sentry'
  AND t.source_project = rc.sentry_project;

-- mark repos_config deprecated (don't drop yet)
COMMENT ON TABLE repos_config IS 'DEPRECATED — migrate to triggers; will drop in alertforge-2.1';
```

Migration is **forward-only**. Re-runnable via the `ON CONFLICT DO NOTHING` clauses. Rollback procedure: leave `repos_config` data intact until 2.1.x; downgrade reverts code only.

## Verification queries

After migration:

```sql
-- 1. one trigger per repos_config row
SELECT
  (SELECT count(*) FROM repos_config) AS rc_count,
  (SELECT count(*) FROM triggers WHERE source_type = 'sentry') AS trigger_count;
-- expect rc_count == trigger_count

-- 2. all open runs have a trigger_id
SELECT count(*) FROM runs WHERE trigger_id IS NULL AND status IN ('queued','triaging','agenting','testing');
-- expect 0

-- 3. slack channel rows match
SELECT
  (SELECT count(*) FROM repos_config WHERE slack_channel IS NOT NULL) AS rc_slack,
  (SELECT count(*) FROM channel_configs WHERE channel_type = 'slack') AS cc_slack;
-- expect equal
```

## Drizzle schema (`packages/db/src/schema/triggers.ts`)

```ts
export const triggers = pgTable('triggers', {
  id: uuid('id').primaryKey().defaultRandom(),
  repoId: uuid('repo_id').notNull().references(() => repos.id, { onDelete: 'cascade' }),
  sourceType: text('source_type').notNull(),
  sourceProject: text('source_project').notNull(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  preset: text('preset').notNull().default('auto_fix'),
  config: jsonb('config').$type<TriggerConfig>().notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniq: unique().on(t.sourceType, t.sourceProject, t.repoId),
  repoIdx: index('triggers_repo_id_idx').on(t.repoId),
  sourceTypeIdx: index('triggers_source_type_idx').on(t.sourceType),
}));

export const channelConfigs = pgTable('channel_configs', { /* ... */ });
```
