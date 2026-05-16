import { createDb } from "@sentry-fixer-bot/db";
import { healthSnapshots, mcpInstalls } from "@sentry-fixer-bot/db/schema/admin";
import { sql } from "drizzle-orm";

import { adminProcedure, protectedProcedure, router } from "../index";
import { claudeAuthStatus, claudeMcpList } from "../run/claude-runner";
import { ghAuthStatus } from "../run/gh-runner";
import { hasEnvSecret } from "../secrets/env-file";

export type SetupStep = {
  id: "claude" | "github" | "sentry" | "mcp";
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
  const [claude, gh] = await Promise.all([
    claudeAuthStatus().catch(() => ({ loggedIn: false }) as { loggedIn: false }),
    ghAuthStatus().catch(() => ({ authenticated: false }) as { authenticated: false }),
  ]);

  const claudeAccount = "account" in claude ? claude.account : undefined;
  const githubLoggedIn = gh.authenticated || Boolean(process.env.GITHUB_APP_ID);

  const sentryTokenSet = hasEnvSecret("SENTRY_API_TOKEN");
  const sentryOrgSet = hasEnvSecret("SENTRY_ORG_SLUG");
  const sentryConfigured = sentryTokenSet && sentryOrgSet;

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
  const mcpDone = expected.size > 0 && mcpMissing.length === 0;

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
        ? "API token + org slug present"
        : `Paste ${sentryTokenSet ? "" : "SENTRY_API_TOKEN, "}${sentryOrgSet ? "" : "SENTRY_ORG_SLUG "}via /settings.`,
      actionHref: "/settings",
    },
    {
      id: "mcp",
      label: "MCP servers ready",
      done: mcpDone,
      detail: mcpDone
        ? `${mcpReady.length} MCP server(s) connected: ${mcpReady.join(", ")}`
        : mcpMissing.length > 0
          ? `Missing: ${mcpMissing.join(", ")} — see /doctor`
          : "No MCPs registered yet — visit /mcps",
      actionHref: "/doctor",
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
});
