import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../index";

const Severity = z.enum(["low", "medium", "high", "critical"]);

const Input = z.object({
  sentryProject: z.string().min(1),
  github: z.string().regex(/^[^/]+\/[^/]+$/, "expected owner/name"),
  defaultBranch: z.string().min(1).default("main"),
  // Optional. Empty/undefined → agent worker auto-detects from the
  // repo's package.json (prefers `test:coverage`, falls back to `test`,
  // skips the gate if neither exists).
  testCommand: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : null)),
  prReviewers: z.array(z.string()).default([]),
  dailyTokenCap: z.number().int().positive(),
  dailyCostCapCents: z.number().int().positive(),
  minSeverityToFix: Severity.default("medium"),
  enabled: z.boolean().default(true),
});

export const reposRouter = router({
  list: protectedProcedure.query(async () => {
    const db = createDb();
    return db.select().from(reposConfig).orderBy(reposConfig.sentryProject);
  }),

  byId: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const db = createDb();
    const rows = await db.select().from(reposConfig).where(eq(reposConfig.id, input.id)).limit(1);
    return rows[0] ?? null;
  }),

  create: adminProcedure.input(Input).mutation(async ({ input, ctx }) => {
    const db = createDb();
    const inserted = await db
      .insert(reposConfig)
      .values({ ...input, createdBy: ctx.user.id })
      .returning();
    return inserted[0];
  }),

  update: adminProcedure
    .input(Input.extend({ id: z.string().uuid() }))
    .mutation(async ({ input }) => {
      const { id, ...patch } = input;
      const db = createDb();
      const updated = await db
        .update(reposConfig)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(reposConfig.id, id))
        .returning();
      return updated[0];
    }),

  delete: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const db = createDb();
    await db.delete(reposConfig).where(eq(reposConfig.id, input.id));
    return { ok: true };
  }),
});
