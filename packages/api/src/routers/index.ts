import { protectedProcedure, publicProcedure, router } from "../index";
import { chatRouter } from "./chat";
import { mcpsRouter } from "./mcps";
import { reposRouter } from "./repos";
import { runsRouter } from "./runs";
import { settingsRouter } from "./settings";
import { skillsRouter } from "./skills";
import { systemRouter } from "./system";

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
  skills: skillsRouter,
  settings: settingsRouter,
  system: systemRouter,
});
export type AppRouter = typeof appRouter;
