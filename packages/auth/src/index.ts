import { createDb } from "@sentry-fixer-bot/db";
import * as schema from "@sentry-fixer-bot/db/schema/auth";
import { env } from "@sentry-fixer-bot/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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
