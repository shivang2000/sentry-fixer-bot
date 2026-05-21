import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { channelConfigs, triggers } from "@sentry-fixer-bot/db/schema/triggers";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, router } from "../index";

const PresetSchema = z.enum(["triage_only", "auto_fix", "auto_fix_review", "custom"]);

// V1: Sentry-only. P5+ extends as new source adapters register.
const SourceTypeSchema = z.enum(["sentry"]);

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
});
