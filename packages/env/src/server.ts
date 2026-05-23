import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    // --- Scaffold-provided ---
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    // --- alertforge: deployment mode + bind ---
    DEPLOYMENT_MODE: z.enum(["local_trusted", "authenticated"]).default("local_trusted"),
    SERVER_BIND: z.enum(["loopback", "lan", "tailnet", "custom"]).default("loopback"),
    SERVER_BIND_HOST: z.string().optional(),
    PUBLIC_BASE_URL: z.url().optional(),

    // --- Sentry ---
    SENTRY_WEBHOOK_SECRET: z.string().min(1).optional(),
    SENTRY_API_TOKEN: z.string().min(1).optional(),
    SENTRY_ORG_SLUG: z.string().min(1).optional(),

    // --- Anthropic ---
    ANTHROPIC_API_KEY: z.string().min(1).optional(),

    // --- S3 ---
    S3_BUCKET: z.string().min(1).optional(),
    S3_REGION: z.string().min(1).optional(),

    // --- GitHub App ---
    GITHUB_APP_ID: z.string().min(1).optional(),
    GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
    GITHUB_APP_INSTALLATION_ID: z.string().min(1).optional(),
    // Optional. When set, the /webhooks/github endpoint verifies the
    // X-Hub-Signature-256 header on incoming issue_comment events so
    // /alertforge commands on PRs can drive the follow-up loop in
    // real-time. Unset → endpoint returns 503 and the cron fallback is
    // the only way comments get processed.
    GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),

    // --- Agent runtime ---
    WORK_DIR: z.string().min(1).default("/var/lib/alertforge/work"),
    CLAUDE_BIN: z.string().min(1).default("claude"),
    CLAUDE_MODEL: z.string().min(1).default("claude-sonnet-4-6"),
    AGENT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(900),

    // --- Optional bootstrap admin (skip first-signup-becomes-admin race) ---
    ALERTFORGE_BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
