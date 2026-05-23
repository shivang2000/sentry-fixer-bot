import { createDb } from "@alertforge/db";
import * as schema from "@alertforge/db/schema/auth";
import { invites } from "@alertforge/db/schema/invites";
import { env } from "@alertforge/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { LOCAL_BOARD_ID } from "./bootstrap-logic";
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
          // Gate: allow if no real users yet, or email matches bootstrap
          // admin, or there's an unconsumed invite for this email.
          //
          // We exclude the `local-board` synthetic admin (seeded in
          // local_trusted mode) from the "real users" count so a fresh
          // operator can sign up and become admin without `psql`. The
          // local-board user is not a person; it's a service account
          // for the loopback dev mode.
          before: async (newUser) => {
            const rows = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(schema.user)
              .where(ne(schema.user.id, LOCAL_BOARD_ID));
            const total = rows[0]?.count ?? 0;

            if (total === 0) return; // first real signup → allowed (promoted in `after`)
            if (
              env.ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL &&
              env.ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL === newUser.email
            ) {
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
          // Post-create: first real user becomes instance_admin; others
          // consume their invite (and inherit its role).
          after: async (createdUser) => {
            const rows = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(schema.user)
              .where(ne(schema.user.id, LOCAL_BOARD_ID));
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
      // Cookie prefix kept as "sfb" intentionally during the 2.0.x
      // back-compat window so existing sessions (cookies named
      // `sfb.session_token` etc.) keep authenticating after the rename
      // cutover. P9 will bump this to "alertforge" once the operator
      // accepts a session-invalidation event.
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
