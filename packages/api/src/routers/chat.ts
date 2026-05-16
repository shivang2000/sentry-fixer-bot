import { createDb } from "@sentry-fixer-bot/db";
import { chatMessages, chatSessions } from "@sentry-fixer-bot/db/schema/admin";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../index";

export const chatRouter = router({
  create: protectedProcedure
    .input(z.object({ repo: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = createDb();

      // F7: enforce one active session per user — close any prior active sessions
      await db
        .update(chatSessions)
        .set({ status: "superseded", endedAt: new Date() })
        .where(and(eq(chatSessions.userId, ctx.user.id), isNull(chatSessions.endedAt)));

      const inserted = await db
        .insert(chatSessions)
        .values({ userId: ctx.user.id, repo: input.repo ?? null, status: "pending" })
        .returning();
      return inserted[0];
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const db = createDb();
    return db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.userId, ctx.user.id))
      .orderBy(desc(chatSessions.startedAt))
      .limit(50);
  }),

  messages: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const db = createDb();
      const sess = await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, input.sessionId), eq(chatSessions.userId, ctx.user.id)))
        .limit(1);
      if (sess.length === 0) return [];
      return db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, input.sessionId))
        .orderBy(chatMessages.createdAt);
    }),

  end: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = createDb();
      await db
        .update(chatSessions)
        .set({ status: "closed", endedAt: new Date() })
        .where(and(eq(chatSessions.id, input.sessionId), eq(chatSessions.userId, ctx.user.id)));
      return { ok: true };
    }),

  delete: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const db = createDb();
      // Owner check: only delete the session if it belongs to the caller.
      const owned = await db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.id, input.sessionId), eq(chatSessions.userId, ctx.user.id)))
        .limit(1);
      if (owned.length === 0) return { ok: false as const, error: "not_found" };
      await db.delete(chatSessions).where(eq(chatSessions.id, input.sessionId));
      // Best-effort scrub of the per-session work dir on the state volume.
      // We do this after the DB delete so a partial fs failure doesn't leave
      // a row pointing at a gone path.
      const base = process.env.WORK_DIR ?? "/var/lib/sfb/work";
      try {
        const { rm } = await import("node:fs/promises");
        const { join } = await import("node:path");
        await rm(join(base, input.sessionId), { recursive: true, force: true });
      } catch {
        // ignore — work dir might not exist yet
      }
      return { ok: true as const };
    }),
});
