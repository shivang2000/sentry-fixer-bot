import { createDb } from "@sentry-fixer-bot/db";
import { healthSnapshots, mcpInstalls } from "@sentry-fixer-bot/db/schema/admin";
import { sql } from "drizzle-orm";

import { adminProcedure, protectedProcedure, router } from "../index";
import { claudeAuthStatus, claudeMcpList } from "../run/claude-runner";
import { ghAuthStatus } from "../run/gh-runner";
import { sentryAuthStatus } from "../run/sentry-runner";
import { hasEnvSecret } from "../secrets/env-file";

export type SetupStep = {
  id: "claude" | "github" | "sentry";
  label: string;
  done: boolean;
  detail: string;
  actionHref?: string;
};

export type SetupStatus = {
  steps: SetupStep[];
  ready: boolean;
  checkedAt: string;
  mcps: { ready: string[]; missing: string[] };
};

/**
 * Probe every piece of mutable state the agent depends on. Cheap enough
 * to call per-page-load but the health-check cron writes the result to
 * the health_snapshots table so the dashboard can render in O(1).
 */
export async function computeSetupStatus(): Promise<SetupStatus> {
  const [claude, gh, sentry] = await Promise.all([
    claudeAuthStatus().catch(() => ({ loggedIn: false }) as { loggedIn: false }),
    ghAuthStatus().catch(() => ({ authenticated: false }) as { authenticated: false }),
    sentryAuthStatus().catch(() => ({ loggedIn: false }) as { loggedIn: false }),
  ]);

  const claudeAccount = "account" in claude ? claude.account : undefined;
  const githubLoggedIn = gh.authenticated || Boolean(process.env.GITHUB_APP_ID);

  // Sentry is considered configured if EITHER the CLI is logged in
  // (sentry auth status returns loggedIn:true) OR the env-file path
  // has both legacy keys pasted. CLI takes precedence — operator who
  // ran `sentry auth login` should see green without also pasting
  // SENTRY_API_TOKEN manually.
  const sentryCliLoggedIn = sentry.loggedIn;
  const sentryTokenSet = hasEnvSecret("SENTRY_API_TOKEN");
  const sentryOrgSet = hasEnvSecret("SENTRY_ORG_SLUG");
  const sentryConfigured = sentryCliLoggedIn || (sentryTokenSet && sentryOrgSet);
  const sentryAccount = "account" in sentry ? sentry.account : undefined;

  const db = createDb();
  const installed = await db.select({ catalogId: mcpInstalls.catalogId }).from(mcpInstalls);
  const expected = new Set(installed.map((r) => r.catalogId));

  let mcpList: { entries: { name: string; ok: boolean }[]; raw: string };
  try {
    mcpList = await claudeMcpList();
  } catch {
    mcpList = { entries: [], raw: "" };
  }
  const reported = new Set(mcpList.entries.filter((e) => e.ok).map((e) => e.name));
  const mcpReady = [...expected].filter((id) => reported.has(id));
  const mcpMissing = [...expected].filter((id) => !reported.has(id));

  const steps: SetupStep[] = [
    {
      id: "claude",
      label: "Log in to Claude",
      done: claude.loggedIn,
      detail: claude.loggedIn
        ? `Signed in${claudeAccount ? ` as ${claudeAccount}` : ""}`
        : "Run `claude /login` inside a chat session, or click below.",
      actionHref: "/settings",
    },
    {
      id: "github",
      label: "Log in to GitHub",
      done: githubLoggedIn,
      detail: githubLoggedIn
        ? "gh CLI is authenticated"
        : "Sign in via /settings or run `gh auth login --web` in a chat session.",
      actionHref: "/settings",
    },
    {
      id: "sentry",
      label: "Configure Sentry",
      done: sentryConfigured,
      detail: sentryConfigured
        ? sentryCliLoggedIn
          ? `Signed in via sentry CLI${sentryAccount ? ` (${sentryAccount})` : ""}`
          : "API token + org slug present"
        : `Run \`sentry auth login\` in the wizard shell, or paste ${sentryTokenSet ? "" : "SENTRY_API_TOKEN, "}${sentryOrgSet ? "" : "SENTRY_ORG_SLUG "}via /settings.`,
      actionHref: "/settings",
    },
  ];

  return {
    steps,
    ready: steps.every((s) => s.done),
    checkedAt: new Date().toISOString(),
    mcps: { ready: mcpReady, missing: mcpMissing },
  };
}

export async function writeHealthSnapshot(status: SetupStatus): Promise<void> {
  const db = createDb();
  await db
    .insert(healthSnapshots)
    .values({
      id: "current",
      payload: status,
      ready: status.ready,
      checkedAt: new Date(status.checkedAt),
    })
    .onConflictDoUpdate({
      target: healthSnapshots.id,
      set: {
        payload: status,
        ready: status.ready,
        checkedAt: new Date(status.checkedAt),
      },
    });
}

export const setupRouter = router({
  // Live probe — bypasses the snapshot. Used by the doctor page's
  // "Re-run probes" button and by the wizard's initial render.
  status: protectedProcedure.query(() => computeSetupStatus()),

  // Cheap read of the snapshot table. Dashboard polls this.
  snapshot: protectedProcedure.query(async () => {
    const db = createDb();
    const rows = await db.select().from(healthSnapshots).where(sql`id = 'current'`).limit(1);
    return rows[0] ?? null;
  }),

  claudeMcpListRaw: adminProcedure.query(async () => {
    const list = await claudeMcpList();
    return list;
  }),

  /**
   * Information the home-page card needs to render the GitHub webhook
   * setup section: the delivery URL the operator should paste into
   * their GitHub App's "Webhook URL" field, and whether the matching
   * shared secret has been saved yet.
   *
   * The URL is derived from PUBLIC_BASE_URL when set (production), and
   * falls back to the request origin via `BETTER_AUTH_URL` so dev
   * containers still produce something sensible. Always suffixes the
   * fixed `/webhooks/github` path.
   */
  githubWebhookInfo: protectedProcedure.query(() => {
    const base = process.env.PUBLIC_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "";
    const url = base ? `${base.replace(/\/$/, "")}/webhooks/github` : "/webhooks/github";
    return {
      url,
      configured: hasEnvSecret("GITHUB_WEBHOOK_SECRET"),
      events: ["issue_comment"],
      contentType: "application/json",
    };
  }),

  /**
   * Same shape as githubWebhookInfo but for the Sentry side. The Sentry
   * webhook endpoint at /webhooks/sentry was the first event surface
   * shipped on this server; the card on the home page lets operators
   * configure it without leaving the wizard, mirroring the GitHub flow
   * for consistency.
   *
   * `events` reflects what the existing handler in sentry-webhook.ts
   * actually filters on (issue.created); kept here so the UI can
   * remind the operator which Sentry resource to subscribe to.
   */
  sentryWebhookInfo: protectedProcedure.query(() => {
    const base = process.env.PUBLIC_BASE_URL ?? process.env.BETTER_AUTH_URL ?? "";
    const url = base ? `${base.replace(/\/$/, "")}/webhooks/sentry` : "/webhooks/sentry";
    return {
      url,
      configured: hasEnvSecret("SENTRY_WEBHOOK_SECRET"),
      resources: ["issue"],
    };
  }),
});
