import { protectedProcedure, publicProcedure, router } from "../index";
import { chatRouter } from "./chat";
import { mcpsRouter } from "./mcps";
import { reposRouter } from "./repos";
import { runsRouter } from "./runs";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => "OK"),
  whoami: protectedProcedure.query(({ ctx }) => ({
    id: ctx.user.id,
    email: ctx.user.email,
    role: ctx.user.role,
  })),
  repos: reposRouter,
  runs: runsRouter,
  mcps: mcpsRouter,
  chat: chatRouter,
});
export type AppRouter = typeof appRouter;
