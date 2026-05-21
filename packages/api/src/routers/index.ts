import { protectedProcedure, publicProcedure, router } from "../index";
import { channelsRouter } from "./channels";
import { chatRouter } from "./chat";
import { cronRouter } from "./cron";
import { ghRouter } from "./gh";
import { invitesRouter } from "./invites";
import { mcpsRouter } from "./mcps";
import { reposRouter } from "./repos";
import { runsRouter } from "./runs";
import { settingsRouter } from "./settings";
import { setupRouter } from "./setup";
import { skillsRouter } from "./skills";
import { systemRouter } from "./system";
import { triggersRouter } from "./triggers";

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
  gh: ghRouter,
  setup: setupRouter,
  cron: cronRouter,
  invites: invitesRouter,
  triggers: triggersRouter,
  channels: channelsRouter,
});
export type AppRouter = typeof appRouter;
