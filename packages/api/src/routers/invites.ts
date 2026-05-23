import { createDb } from "@alertforge/db";
import { invites } from "@alertforge/db/schema/invites";
import { TRPCError } from "@trpc/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { adminProcedure, router } from "../index";

/**
 * Admin-only invites surface. Replaces the operator's previous
 * `psql -c "INSERT INTO invites ..."` workflow.
 *
 * Roles supported match the better-auth gate:
 *   instance_admin — full admin access, mirrors the bootstrap account
 *   member         — can sign in but is not granted admin-only routes
 */
export const invitesRouter = router({
  list: adminProcedure.query(async () => {
    const db = createDb();
    return db
      .select({
        id: invites.id,
        email: invites.email,
        role: invites.role,
        invitedBy: invites.invitedBy,
        consumedAt: invites.consumedAt,
        createdAt: invites.createdAt,
      })
      .from(invites)
      .orderBy(desc(invites.createdAt))
      .limit(200);
  }),

  create: adminProcedure
    .input(
      z.object({
        email: z.email().trim().toLowerCase(),
        role: z.enum(["instance_admin", "member"]).default("member"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = createDb();
      try {
        const inserted = await db
          .insert(invites)
          .values({
            email: input.email,
            role: input.role,
            invitedBy: ctx.user.id,
          })
          .returning({ id: invites.id });
        const row = inserted[0];
        if (!row) {
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "insert_returned_empty" });
        }
        return { id: row.id, email: input.email, role: input.role };
      } catch (err) {
        // Unique violation on email → friendly message rather than the
        // raw drizzle error. Drizzle surfaces postgres `23505` as a
        // generic Error; we sniff the message.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("duplicate key") || msg.includes("23505")) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `${input.email} already has an invite (consumed or pending).`,
          });
        }
        throw err;
      }
    }),

  /**
   * Revoke an invite. Only effective on unconsumed rows — once a user
   * has signed up against the invite, deleting the row would be a no-op
   * (the user account already exists). For that case, the admin should
   * go demote the user via the better-auth admin surface instead.
   */
  revoke: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input }) => {
    const db = createDb();
    const row = (await db.select().from(invites).where(eq(invites.id, input.id)).limit(1))[0];
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "invite_not_found" });
    }
    if (row.consumedAt) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "invite_already_consumed — revoking the user must be done via auth admin",
      });
    }
    await db.delete(invites).where(eq(invites.id, input.id));
    return { ok: true };
  }),
});
