import { createDb } from "@sentry-fixer-bot/db";
import * as schema from "@sentry-fixer-bot/db/schema/auth";
import { invites } from "@sentry-fixer-bot/db/schema/invites";
import { env } from "@sentry-fixer-bot/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveTrustedOrigins } from "./trusted-origins";

function inferPort(urlString: string, fallback: number): number {
  try {
    const url = new URL(urlString);
    if (url.port) return Number.parseInt(url.port, 10);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return fallback;
  }
}

export function createAuth() {
  const db = createDb();
  const port = inferPort(env.BETTER_AUTH_URL, 3000);

  const trustedOrigins = Array.from(
    new Set([
      env.CORS_ORIGIN, // web app origin (scaffolder default)
      ...resolveTrustedOrigins({
        bind: env.SERVER_BIND,
        port,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        deploymentMode: env.DEPLOYMENT_MODE,
      }),
    ]),
  );

  // Cookie posture:
  // - HTTPS (public deploy):  sameSite=none + secure (cross-site auth requires it)
  // - HTTP localhost (dev):   sameSite=lax  + secure=false (browsers reject secure on http://)
  const isHttps = env.BETTER_AUTH_URL.startsWith("https://");

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: schema,
    }),
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    databaseHooks: {
      user: {
        create: {
          // Gate: allow if no users yet, or email matches bootstrap admin,
          // or there's an unconsumed invite for this email.
          before: async (newUser) => {
            const rows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.user);
            const total = rows[0]?.count ?? 0;

            if (total === 0) return; // first signup → allowed (promoted in `after`)
            if (env.SFB_BOOTSTRAP_ADMIN_EMAIL && env.SFB_BOOTSTRAP_ADMIN_EMAIL === newUser.email) {
              return;
            }
            const matched = await db
              .select()
              .from(invites)
              .where(and(eq(invites.email, newUser.email), isNull(invites.consumedAt)))
              .limit(1);
            if (matched.length === 0) {
              throw new Error("signup_requires_invite");
            }
          },
          // Post-create: first user becomes instance_admin; otherwise consume invite.
          after: async (createdUser) => {
            const rows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.user);
            const total = rows[0]?.count ?? 0;

            if (total === 1) {
              await db
                .update(schema.user)
                .set({ role: "instance_admin" })
                .where(eq(schema.user.id, createdUser.id));
              return;
            }
            const matched = await db
              .select()
              .from(invites)
              .where(and(eq(invites.email, createdUser.email), isNull(invites.consumedAt)))
              .limit(1);
            const invite = matched[0];
            if (invite) {
              await db
                .update(invites)
                .set({ consumedAt: new Date() })
                .where(eq(invites.id, invite.id));
              if (invite.role === "instance_admin") {
                await db
                  .update(schema.user)
                  .set({ role: "instance_admin" })
                  .where(eq(schema.user.id, createdUser.id));
              }
            }
          },
        },
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      cookiePrefix: "sfb",
      defaultCookieAttributes: {
        sameSite: isHttps ? "none" : "lax",
        secure: isHttps,
        httpOnly: true,
      },
    },
    plugins: [],
  });
}

export const auth = createAuth();
