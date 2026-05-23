import { createDb } from "@alertforge/db";
import { reposConfig } from "@alertforge/db/schema/admin";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../index";
import { ghAuthStatus, ghListRepos } from "../run/gh-runner";

const AddInput = z.object({
  repos: z
    .array(
      z.object({
        nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
        defaultBranch: z.string().min(1).default("main"),
      }),
    )
    .min(1)
    .max(50),
  // Per-batch defaults the operator confirms in the picker dialog.
  testCommand: z.string().min(1).default("bun test"),
  dailyTokenCap: z.number().int().positive().default(1_000_000),
  dailyCostCapCents: z.number().int().positive().default(500),
});

export const ghRouter = router({
  authStatus: protectedProcedure.query(async () => {
    try {
      return await ghAuthStatus();
    } catch (err) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: err instanceof Error ? err.message : "gh_status_failed",
      });
    }
  }),

  listRepos: adminProcedure.query(async () => {
    try {
      return await ghListRepos(100);
    } catch (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: err instanceof Error ? err.message : "gh_list_failed",
      });
    }
  }),

  addRepos: adminProcedure.input(AddInput).mutation(async ({ input, ctx }) => {
    const db = createDb();
    const existing = await db.select({ github: reposConfig.github }).from(reposConfig);
    const have = new Set(existing.map((r) => r.github));

    const toInsert = input.repos
      .filter((r) => !have.has(r.nameWithOwner))
      .map((r) => ({
        sentryProject: r.nameWithOwner,
        github: r.nameWithOwner,
        defaultBranch: r.defaultBranch,
        testCommand: input.testCommand,
        prReviewers: [],
        dailyTokenCap: input.dailyTokenCap,
        dailyCostCapCents: input.dailyCostCapCents,
        minSeverityToFix: "medium" as const,
        enabled: true,
        createdBy: ctx.user.id,
      }));

    if (toInsert.length === 0) return { inserted: 0, skipped: input.repos.length };
    const inserted = await db.insert(reposConfig).values(toInsert).returning();
    return { inserted: inserted.length, skipped: input.repos.length - inserted.length };
  }),
});
