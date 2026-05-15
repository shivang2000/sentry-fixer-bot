import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@sentry-fixer-bot/api/context";
import { appRouter } from "@sentry-fixer-bot/api/routers/index";
import { auth } from "@sentry-fixer-bot/auth";
import { bootstrapLocalTrustedAdmin, maybeEmitClaimUrl } from "@sentry-fixer-bot/auth/bootstrap";
import { env } from "@sentry-fixer-bot/env/server";
import { initLogger } from "evlog";
import { type BetterAuthInstance, createAuthMiddleware } from "evlog/better-auth";
import { type EvlogVariables, evlog } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { boardClaim } from "./routes/board-claim";

initLogger({
  env: { service: "sentry-fixer-bot-server" },
});

await bootstrapLocalTrustedAdmin();
await maybeEmitClaimUrl();

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
  exclude: ["/api/auth/**"],
  maskEmail: true,
});

const app = new Hono<EvlogVariables>();

app.use(evlog());
app.use("*", async (c, next) => {
  await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
  await next();
});

app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.route("/", boardClaim);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

export default app;
