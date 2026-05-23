import { createContext } from "@alertforge/api/context";
import { appRouter } from "@alertforge/api/routers/index";
import { auth } from "@alertforge/auth";
import { bootstrapLocalTrustedAdmin, maybeEmitClaimUrl } from "@alertforge/auth/bootstrap";
import { runStartupDoctor } from "@alertforge/auth/doctor";
import { env } from "@alertforge/env/server";
import { trpcServer } from "@hono/trpc-server";
import { initLogger } from "evlog";
import { type BetterAuthInstance, createAuthMiddleware } from "evlog/better-auth";
import { type EvlogVariables, evlog } from "evlog/hono";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import "./register-adapters";
import { bootstrapDefaults } from "./bootstrap-defaults";
import { boardClaim } from "./routes/board-claim";
import { chatWs, websocket } from "./routes/chat-ws";
import { githubWebhook } from "./routes/github-webhook";
import { health } from "./routes/health";
import { webhooksGeneric } from "./routes/webhooks-generic";

initLogger({
  env: { service: "alertforge-server" },
});

await bootstrapLocalTrustedAdmin();
await runStartupDoctor();
await maybeEmitClaimUrl();
await bootstrapDefaults();

// Container mode runs a single Bun process, so we also start the worker
// loop in-band. pg-boss handlers + the Sentry-poll cron all hang off the
// same boss instance the webhook handler publishes to. EC2 mode keeps the
// dedicated alertforge-worker.service.
if (process.env.ALERTFORGE_RUN_MODE === "container") {
  await import("./worker/index");
}

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

app.route("/", health);
app.route("/", boardClaim);
app.route("/", webhooksGeneric);
app.route("/", githubWebhook);
app.route("/", chatWs);

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (_opts, context) => {
      return createContext({ context });
    },
  }),
);

// Production: serve built web app from apps/server/public/ (populated by
// `bun run build` which copies apps/web/dist/* over).
if (env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./apps/server/public" }));
  app.get("*", serveStatic({ path: "./apps/server/public/index.html" }));
} else {
  app.get("/", (c) => c.text("OK"));
}

// Bun needs `websocket` exposed on the default export so it can attach the
// WS handler to Bun.serve. `export default app` alone misses it — Hono's
// `app.fetch` is forwarded, but `websocket` has to ride alongside.
export default {
  fetch: app.fetch,
  websocket,
};
