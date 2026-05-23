import { type Logger, registry } from "@alertforge/core";
import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { alerts } from "@sentry-fixer-bot/db/schema/domain";
import { channelConfigs, triggers } from "@sentry-fixer-bot/db/schema/triggers";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { adminProcedure, router } from "../index";

let bossInstance: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const { env } = await import("@sentry-fixer-bot/env/server");
  bossInstance = new PgBoss({ connectionString: env.DATABASE_URL });
  await bossInstance.start();
  return bossInstance;
}

// Minimal console-backed Logger matching @alertforge/core's contract.
// Source adapters expect a `log` on their deps; this thin shim avoids
// importing pino into the api package solely for adapter calls.
function makeLogger(bindings: Record<string, unknown> = {}): Logger {
  const fmt = (obj: object | string, msg?: string) =>
    typeof obj === "string"
      ? { msg: msg ?? obj, ...bindings }
      : { ...bindings, ...(obj as object), ...(msg ? { msg } : {}) };
  return {
    debug: (o, m) => console.debug(fmt(o, m)),
    info: (o, m) => console.info(fmt(o, m)),
    warn: (o, m) => console.warn(fmt(o, m)),
    error: (o, m) => console.error(fmt(o, m)),
    child: (more) => makeLogger({ ...bindings, ...more }),
  };
}

const PresetSchema = z.enum(["triage_only", "auto_fix", "auto_fix_review", "custom"]);

// P6: source type is validated against the registry at create time rather
// than a hard-coded enum. Keeps the router open to PostHog / PagerDuty
// adapters without a router-level schema change.
const SourceTypeSchema = z.string().min(1);

const TriggerConfigSchema = z
  .object({
    toggles: z
      .object({
        autoReview: z.boolean(),
        followUpLoop: z.boolean(),
        secretScanStrict: z.enum(["block", "warn"]),
      })
      .partial()
      .optional(),
    models: z
      .object({
        classify: z.string(),
        fix: z.string(),
        review: z.string(),
        followUp: z.string(),
      })
      .partial()
      .optional(),
    budget: z
      .object({
        dailyTokens: z.number().int().positive(),
        dailyCostCents: z.number().int().nonnegative(),
      })
      .partial()
      .optional(),
    sourceConfig: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const CreateInput = z.object({
  repoId: z.string().uuid(),
  sourceType: SourceTypeSchema,
  sourceProject: z.string().min(1),
  name: z.string().min(1),
  preset: PresetSchema.default("auto_fix"),
  config: TriggerConfigSchema.optional(),
});

const UpdateInput = z.object({
  id: z.string().uuid(),
  enabled: z.boolean().optional(),
  preset: PresetSchema.optional(),
  name: z.string().min(1).optional(),
  config: TriggerConfigSchema.optional(),
});

type DetectUrlResult = {
  adapterType: string;
  adapterDisplayName: string;
  sourceProject: string;
  externalId: string;
  matchingTrigger: {
    id: string;
    name: string;
    preset: string;
    repoId: string;
    repoGithub: string;
  } | null;
};

export const triggersRouter = router({
  /**
   * List every trigger with its repo + channelConfigs joined in for
   * the /triggers index page. Admin-only because the page surfaces
   * webhook URLs + channel webhook URLs that are operator-secrets.
   */
  list: adminProcedure.query(async () => {
    const db = createDb();
    return db
      .select({
        trigger: triggers,
        repo: reposConfig,
      })
      .from(triggers)
      .innerJoin(reposConfig, eq(reposConfig.id, triggers.repoId))
      .orderBy(desc(triggers.createdAt));
  }),

  byId: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const db = createDb();
    const triggerRows = await db.select().from(triggers).where(eq(triggers.id, input.id)).limit(1);
    const trigger = triggerRows[0];
    if (!trigger) return null;

    const repoRows = await db
      .select()
      .from(reposConfig)
      .where(eq(reposConfig.id, trigger.repoId))
      .limit(1);
    const channels = await db
      .select()
      .from(channelConfigs)
      .where(eq(channelConfigs.triggerId, trigger.id));

    return { trigger, repo: repoRows[0] ?? null, channels };
  }),

  create: adminProcedure.input(CreateInput).mutation(async ({ input }) => {
    if (!registry.sources.has(input.sourceType)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `unknown_source_type: ${input.sourceType}`,
      });
    }

    const db = createDb();

    const repoRows = await db
      .select({ id: reposConfig.id })
      .from(reposConfig)
      .where(eq(reposConfig.id, input.repoId))
      .limit(1);
    if (!repoRows[0]) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "unknown_repo_id" });
    }

    const inserted = await db
      .insert(triggers)
      .values({
        repoId: input.repoId,
        sourceType: input.sourceType,
        sourceProject: input.sourceProject,
        name: input.name,
        preset: input.preset,
        ...(input.config ? { config: input.config } : {}),
      })
      .returning();
    return inserted[0];
  }),

  update: adminProcedure.input(UpdateInput).mutation(async ({ input }) => {
    const db = createDb();
    const updated = await db
      .update(triggers)
      .set({
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.preset !== undefined && { preset: input.preset }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.config !== undefined && { config: input.config }),
        updatedAt: new Date(),
      })
      .where(eq(triggers.id, input.id))
      .returning();
    if (!updated[0]) {
      throw new TRPCError({ code: "NOT_FOUND", message: "trigger_not_found" });
    }
    return updated[0];
  }),

  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const db = createDb();
    await db.delete(triggers).where(eq(triggers.id, input.id));
    return { ok: true as const };
  }),

  /**
   * Catalog of available source adapters, sourced from the singleton
   * registry populated at apps/server boot via register-adapters.ts.
   * urlPatterns are serialized into { source, flags } pairs so the UI
   * can recreate `new RegExp(source, flags)` client-side for instant
   * detect-without-roundtrip on URL inputs (the server still owns the
   * authoritative detect via detectUrl).
   */
  listSourceAdapters: adminProcedure.query(() => {
    const out = [] as Array<{
      type: string;
      displayName: string;
      urlPatterns: Array<{ source: string; flags: string }>;
      catalogEntry: {
        description: string;
        setupGuide: string;
        requiresEnvKeys: string[];
        urlExamples: string[];
      };
      requiresEnvKeysPresent: Record<string, boolean>;
    }>;
    for (const adapter of registry.sources.values()) {
      out.push({
        type: adapter.type,
        displayName: adapter.displayName,
        urlPatterns: adapter.urlPatterns.map((p) => ({ source: p.source, flags: p.flags })),
        catalogEntry: { ...adapter.catalogEntry },
        requiresEnvKeysPresent: Object.fromEntries(
          adapter.catalogEntry.requiresEnvKeys.map((k) => [k, !!process.env[k]]),
        ),
      });
    }
    return out;
  }),

  /**
   * URL → adapter detection + matching trigger lookup. Admin-only.
   *
   * Walks every registered source adapter's urlPatterns; first match
   * wins. Calls adapter.parseUrl to extract sourceProject + externalId.
   * Then looks up an enabled trigger with the same (sourceType,
   * sourceProject) pair so the UI can surface "matching trigger" or
   * "no trigger configured".
   *
   * Returns null when no adapter recognized the URL (UI surfaces a
   * "configure a source first" hint) — we return null rather than
   * throwing so the debounced detect query can run on every keystroke
   * without flickering errors.
   */
  detectUrl: adminProcedure
    .input(z.object({ url: z.string().min(1) }))
    .query(async ({ input }): Promise<DetectUrlResult | null> => {
      for (const adapter of registry.sources.values()) {
        const parsed = adapter.parseUrl(input.url);
        if (!parsed) continue;

        const db = createDb();
        // sourceProject can be "*" when the URL didn't encode it
        // (Sentry's bare /issues/<id>/ form). Match on sourceType only
        // in that case; the runFromUrl mutation will pin the real
        // project after fetchByExternalId returns the issue.
        const whereProject =
          parsed.sourceProject === "*"
            ? eq(triggers.sourceType, adapter.type)
            : and(
                eq(triggers.sourceType, adapter.type),
                eq(triggers.sourceProject, parsed.sourceProject),
              );
        const rows = await db
          .select({
            id: triggers.id,
            name: triggers.name,
            preset: triggers.preset,
            repoId: triggers.repoId,
            repoGithub: reposConfig.github,
          })
          .from(triggers)
          .innerJoin(reposConfig, eq(reposConfig.id, triggers.repoId))
          .where(and(whereProject, eq(triggers.enabled, true)))
          .limit(1);

        const matchingTrigger = rows[0]
          ? {
              id: rows[0].id,
              name: rows[0].name,
              preset: rows[0].preset,
              repoId: rows[0].repoId,
              repoGithub: rows[0].repoGithub,
            }
          : null;

        return {
          adapterType: adapter.type,
          adapterDisplayName: adapter.displayName,
          sourceProject: parsed.sourceProject,
          externalId: parsed.externalId,
          matchingTrigger,
        };
      }
      return null;
    }),

  /**
   * Generalized version of runs.triggerMock. Uses the source adapter
   * registry to fetch-by-external-id, upsert into alerts, and enqueue
   * the same triage job the real webhook fires. Admin-only.
   *
   * Errors:
   *   BAD_REQUEST  — no adapter matches the URL
   *   NOT_FOUND    — adapter recognized URL but no enabled trigger
   *                  exists for (sourceType, resolved sourceProject)
   *   adapter      — adapter.fetchByExternalId may throw; surfaces as
   *                  TRPCError code=INTERNAL_SERVER_ERROR with the
   *                  adapter's message preserved.
   */
  runFromUrl: adminProcedure
    .input(
      z.object({
        url: z.string().min(1),
        mode: z.enum(["preset", "triage_only"]).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      // Resolve adapter via URL.
      const adapters = [...registry.sources.values()];
      let adapter: (typeof adapters)[number] | null = null;
      let parsed: { sourceProject: string; externalId: string } | null = null;
      for (const a of adapters) {
        const p = a.parseUrl(input.url);
        if (p) {
          adapter = a;
          parsed = p;
          break;
        }
      }
      if (!adapter || !parsed) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Source not recognized. Configure one in /sources first.",
        });
      }

      const log = makeLogger({ source: adapter.type, route: "triggers.runFromUrl" });

      let normalized: Awaited<ReturnType<typeof adapter.fetchByExternalId>>;
      try {
        normalized = await adapter.fetchByExternalId(parsed.sourceProject, parsed.externalId, {
          log,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
      }

      // After fetch we know the real sourceProject; lookup matching
      // enabled trigger.
      const db = createDb();
      const triggerRows = await db
        .select({
          id: triggers.id,
          name: triggers.name,
          preset: triggers.preset,
        })
        .from(triggers)
        .where(
          and(
            eq(triggers.sourceType, adapter.type),
            eq(triggers.sourceProject, normalized.sourceProject),
            eq(triggers.enabled, true),
          ),
        )
        .limit(1);
      const trigger = triggerRows[0];
      if (!trigger) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No enabled trigger configured for ${adapter.type}/${normalized.sourceProject}.`,
        });
      }

      const dedupKey = `manual:${adapter.type}:${normalized.sourceProject}:${normalized.externalId}:${Date.now()}`;
      const inserted = await db
        .insert(alerts)
        .values({
          sentryIssueId: normalized.externalId,
          sentryProject: normalized.sourceProject,
          fingerprint: normalized.fingerprint,
          dedupKey,
          title: normalized.title,
          level: normalized.level,
          firstSeenAt: normalized.firstSeenAt,
          lastSeenAt: normalized.lastSeenAt,
          rawPayloadS3: normalized.rawPayloadS3Key,
        })
        .onConflictDoUpdate({
          target: alerts.dedupKey,
          set: {
            webhookCount: sql`${alerts.webhookCount} + 1`,
            lastSeenAt: normalized.lastSeenAt,
          },
        })
        .returning({ id: alerts.id });
      const alertId = inserted[0]?.id;
      if (!alertId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "alert_upsert_failed" });
      }

      const boss = await getBoss();
      const jobId = await boss.send("triage", { alertId });

      return {
        ok: true as const,
        alertId,
        jobId,
        triggerId: trigger.id,
        triggerName: trigger.name,
        preset: input.mode === "triage_only" ? "triage_only" : trigger.preset,
        sourceType: adapter.type,
        sourceProject: normalized.sourceProject,
        externalId: normalized.externalId,
        title: normalized.title,
      };
    }),
});
