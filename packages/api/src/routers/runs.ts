import { createDb } from "@sentry-fixer-bot/db";
import { alerts, prs, runs } from "@sentry-fixer-bot/db/schema/domain";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

export const runsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = createDb();
      return db
        .select({
          run: runs,
          alert: alerts,
          pr: prs,
        })
        .from(runs)
        .innerJoin(alerts, eq(alerts.id, runs.alertId))
        .leftJoin(prs, eq(prs.runId, runs.id))
        .orderBy(desc(runs.startedAt))
        .limit(input?.limit ?? 50);
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const db = createDb();
    const rows = await db.select().from(runs).where(eq(runs.id, input.id)).limit(1);
    return rows[0];
  }),
});
