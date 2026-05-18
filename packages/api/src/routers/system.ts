import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../index";
import { claudeUsageSnapshot } from "../run/claude-runner";
import { runCommand } from "../run/npm-runner";

export const systemRouter = router({
  runCommand: adminProcedure
    .input(z.object({ command: z.string().min(1).max(2048), cwd: z.string().optional() }))
    .mutation(async ({ input }) => {
      try {
        const result = await runCommand({ command: input.command, cwd: input.cwd });
        return result;
      } catch (err) {
        if (err instanceof TRPCError) throw err;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: err instanceof Error ? err.message : "run_failed",
        });
      }
    }),

  /**
   * Live snapshot of claude's `/usage`, `/extra-usage`, and `/context`
   * slash commands. Surfaced on the Usage page so the operator can see
   * subscription state + quota burn without leaving the dashboard.
   *
   * Spawns three claude --print invocations in parallel (~1-3s
   * combined). Cheap enough to call per-page-load + a periodic refetch
   * driven by the UI's react-query polling.
   */
  claudeUsage: adminProcedure.query(() => claudeUsageSnapshot()),
});
