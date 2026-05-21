---
plan: phase-4-triggers-schema
phase: 4
status: draft
date: 2026-05-21
implements_specs:
  - trigger-config-schema
risk: medium
size: medium
---

# P4 — Triggers + channel_configs schema (migration 0003)

Ship the DB schema for triggers and channel configs. Backfill from `repos_config`. tRPC routers added; UI uses them in P6.

## Scope

- Drizzle schema: `packages/db/src/schema/triggers.ts` defining `triggers`, `channelConfigs`, ALTERs on `runs` and `prs`.
- Migration `packages/db/migrations/0003_alertforge_pipelines.sql` (raw SQL because Drizzle's migration generator handles schema but not the backfill DML cleanly).
- tRPC routers: `packages/api/src/routers/triggers.ts`, `packages/api/src/routers/channels.ts`.
- Update `packages/api/src/routers/index.ts` to mount them.

## File-level changes

### Add

```
packages/db/src/schema/triggers.ts             triggers, channelConfigs tables
packages/db/src/schema/index.ts                add exports for above
packages/db/migrations/0003_alertforge_pipelines.sql
packages/api/src/routers/triggers.ts           list / get / create / update / delete /
                                               detectUrl / runFromUrl / testWithMockAlert
packages/api/src/routers/channels.ts           list adapters / list configs / create /
                                               update / testSend / delete
```

### Modify

```
packages/db/src/schema/domain.ts               ALTER runs (add trigger_id, steps_completed,
                                               ctx_dir, ctx_archive_s3, was_truncated)
packages/db/src/schema/domain.ts               ALTER prs (add outcome, outcome_recorded_at,
                                               review_comments_jsonb)
packages/api/src/routers/index.ts              mount triggers + channels routers
packages/api/src/routers/runs.ts               extend list query to include triggerId
                                               filter; expose stepsCompleted in detail view
apps/server/src/worker/index.ts                resolveTriggerForAlert helper:
                                               look up trigger row by (sourceType,
                                               sourceProject, repo_id)
```

## Migration SQL — see [trigger-config-schema](../specs/2026-05-21-trigger-config-schema.md) §Migration 0003

Pre-flight: snapshot DB via existing `pg_dump → S3` cron.

Run: `bun --filter=@alertforge/db db:migrate` (or whatever the existing migration command is — check `packages/db/package.json` scripts).

## tRPC router shape

`packages/api/src/routers/triggers.ts`:

```ts
import { adminProcedure, router } from '../trpc';
import { z } from 'zod';
import { db } from '@alertforge/db';
import { triggers, channelConfigs, repos } from '@alertforge/db/schema';
import { registry, TriggerConfigSchema } from '@alertforge/core';

export const triggersRouter = router({
  list: adminProcedure.query(async () => {
    return await db.query.triggers.findMany({
      with: { repo: true, channelConfigs: true },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });
  }),

  get: adminProcedure.input(z.string().uuid()).query(async ({ input }) => {
    return await db.query.triggers.findFirst({
      where: eq(triggers.id, input),
      with: { repo: true, channelConfigs: true },
    });
  }),

  create: adminProcedure
    .input(z.object({
      repoId: z.string().uuid(),
      sourceType: z.string(),
      sourceProject: z.string(),
      name: z.string(),
      preset: z.enum(['triage_only', 'auto_fix', 'auto_fix_review', 'custom']).default('auto_fix'),
      config: TriggerConfigSchema.optional(),
    }))
    .mutation(async ({ input }) => {
      // validate sourceType is in registry
      if (!registry.sources.has(input.sourceType)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown source type' });
      }
      return await db.insert(triggers).values(input).returning();
    }),

  update: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      enabled: z.boolean().optional(),
      preset: z.enum(['triage_only', 'auto_fix', 'auto_fix_review', 'custom']).optional(),
      config: TriggerConfigSchema.partial().optional(),
      name: z.string().optional(),
    }))
    .mutation(async ({ input }) => { /* update by id */ }),

  delete: adminProcedure.input(z.string().uuid()).mutation(async ({ input }) => {
    return await db.delete(triggers).where(eq(triggers.id, input));
  }),

  detectUrl: adminProcedure.input(z.object({ url: z.string().url() })).query(async ({ input }) => {
    // see source-adapter-contract spec §Manual URL trigger flow
  }),

  runFromUrl: adminProcedure
    .input(z.object({ url: z.string().url(), mode: z.enum(['preset', 'triage_only']).default('preset') }))
    .mutation(async ({ input }) => { /* see ui-surface spec */ }),

  testWithMockAlert: adminProcedure
    .input(z.object({ triggerId: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // load fixture from the source adapter; run pipeline with noop channels;
      // return runId for UI to poll
    }),
});
```

`packages/api/src/routers/channels.ts`:

```ts
export const channelsRouter = router({
  listAdapters: adminProcedure.query(() => {
    return [...registry.channels.values()].map(c => ({
      type: c.type,
      displayName: c.displayName,
      configSchemaJson: c.configSchema.toJSON(),    // for dynamic form rendering
      catalogEntry: c.catalogEntry,
    }));
  }),

  list: adminProcedure
    .input(z.object({ triggerId: z.string().uuid() }))
    .query(async ({ input }) => {
      return await db.query.channelConfigs.findMany({
        where: eq(channelConfigs.triggerId, input.triggerId),
      });
    }),

  create: adminProcedure
    .input(z.object({
      triggerId: z.string().uuid(),
      channelType: z.string(),
      config: z.unknown(),                          // adapter validates
      notifyOn: z.array(z.string()).default(['pr_opened', 'failed']),
    }))
    .mutation(async ({ input }) => {
      const adapter = registry.channels.get(input.channelType);
      if (!adapter) throw new TRPCError({ code: 'BAD_REQUEST' });
      const validated = adapter.configSchema.parse(input.config);
      return await db.insert(channelConfigs).values({
        triggerId: input.triggerId,
        channelType: input.channelType,
        config: validated,
        notifyOn: input.notifyOn,
      }).returning();
    }),

  testSend: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      // pull config, call adapter.send with a fixture PipelineNotification
      // return success/failure; update last_send_* columns
    }),

  delete: adminProcedure.input(z.string().uuid()).mutation(async ({ input }) => { /* ... */ }),
});
```

## Tests

- Migration test: fresh seeded DB → run 0003 → counts match expected.
- Migration test: re-run 0003 → idempotent (no errors, no duplicate rows).
- `triggers.create` rejects unknown sourceType.
- `triggers.detectUrl` returns the right adapter for each fixture URL.
- `channels.create` rejects invalid config per adapter's `configSchema`.

## Verification

```bash
# Fresh DB:
docker compose down -v && docker compose up -d postgres
bun --filter=@alertforge/db db:migrate
bun --filter=@alertforge/db db:seed
psql -c "SELECT count(*) FROM triggers"        # equals repos_config count (seeded)
psql -c "SELECT count(*) FROM channel_configs" # equals seeded repos_config.slack_channel non-null count

# Existing-data migration (against snapshot of staging):
psql -f packages/db/migrations/0003_alertforge_pipelines.sql
# run verification queries from trigger-config-schema spec

bun --filter=@alertforge/api test
bun --filter=@alertforge/server test
```

## Commit

```
feat(db,api): triggers + channel_configs tables + tRPC routers

Introduce per-trigger pipeline configuration via the new triggers and
channel_configs tables (migration 0003). Backfills existing repos_config
rows into triggers with preset=auto_fix and default model picks.

Adds tRPC routers triggers and channels with list/get/create/update/
delete plus detectUrl, runFromUrl (manual URL trigger parity), and
testSend for channel verification. repos_config is marked deprecated;
to be dropped in alertforge-2.1.

Spec: docs/alertforge/specs/2026-05-21-trigger-config-schema.md
Plan: docs/alertforge/plans/2026-05-21-phase-4-triggers-schema.md

Constraint: migration must be forward-only and idempotent
Constraint: preserve all existing repos_config data until 2.1 (D3 rollback)
Rejected: drop repos_config in same migration | rollback safety
Rejected: store adapter URL patterns in DB | ADR-0004 security
Confidence: high
Scope-risk: moderate
Directive: New trigger configs created via API must validate against
           TriggerConfigSchema (zod). Channel configs validate via the
           channel adapter's own configSchema.
Not-tested: production DB migration (will run during P7 cutover)
```
