import { createDb } from "@sentry-fixer-bot/db";
import { alerts, prs, runs } from "@sentry-fixer-bot/db/schema/domain";
import { TRPCError } from "@trpc/server";
import { desc, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../index";

let bossInstance: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const { env } = await import("@sentry-fixer-bot/env/server");
  bossInstance = new PgBoss({ connectionString: env.DATABASE_URL });
  await bossInstance.start();
  return bossInstance;
}

type SentryIssueDetail = {
  id: string;
  shortId: string;
  title: string;
  level: string;
  project: { slug: string; name: string };
  firstSeen: string;
  lastSeen: string;
  metadata?: { type?: string; value?: string };
};

async function fetchSentryIssue(issueId: string): Promise<SentryIssueDetail> {
  const { env } = await import("@sentry-fixer-bot/env/server");
  if (!env.SENTRY_API_TOKEN) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "SENTRY_API_TOKEN not configured — paste in /settings or run sentry auth login.",
    });
  }
  const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
    headers: { Authorization: `Bearer ${env.SENTRY_API_TOKEN}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Sentry returned ${res.status} for issue ${issueId}`,
    });
  }
  return (await res.json()) as SentryIssueDetail;
}

function parseIssueId(input: string): string {
  // Accept raw id or full URL: /issues/<id>/?...
  const m = input.match(/issues\/(\d+)/) ?? input.match(/^(\d+)$/);
  if (!m) throw new TRPCError({ code: "BAD_REQUEST", message: "could_not_parse_issue_id" });
  return m[1] as string;
}

export const runsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const db = createDb();
      return db
        .select({
          run: runs,
          alert: alerts,
          pr: prs,
        })
        .from(runs)
        .innerJoin(alerts, eq(alerts.id, runs.alertId))
        .leftJoin(prs, eq(prs.runId, runs.id))
        .orderBy(desc(runs.startedAt))
        .limit(input?.limit ?? 50);
    }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ input }) => {
    const db = createDb();
    const rows = await db.select().from(runs).where(eq(runs.id, input.id)).limit(1);
    return rows[0];
  }),

  /**
   * Synthesizes a webhook-style alert from a Sentry issue id (or full
   * URL) and enqueues the same JOB_TRIAGE the real webhook fires. Used
   * to dry-run the full pipeline without waiting for Sentry to send a
   * real alert. Admin only.
   *
   * Flow:
   *  1. Parse the issue id from the input (URL or numeric id).
   *  2. Fetch /api/0/issues/<id>/ via Sentry API to get title + level +
   *     project slug + first/last seen.
   *  3. upsertAlert with a "manual:" dedup_key prefix so it won't
   *     collide with webhook / cron arrivals for the same issue.
   *  4. publishJob(JOB_TRIAGE, { alertId }).
   */
  triggerMock: adminProcedure
    .input(z.object({ issue: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const issueId = parseIssueId(input.issue);
      const issue = await fetchSentryIssue(issueId);

      const db = createDb();
      const dedupKey = `manual:${issue.project.slug}:${issue.id}:${Date.now()}`;

      const inserted = await db
        .insert(alerts)
        .values({
          sentryIssueId: issue.id,
          sentryProject: issue.project.slug,
          fingerprint: issue.shortId ?? issue.id,
          dedupKey,
          title: issue.title,
          level: issue.level,
          firstSeenAt: new Date(issue.firstSeen),
          lastSeenAt: new Date(issue.lastSeen),
          rawPayloadS3: `manual:${dedupKey}`,
        })
        .onConflictDoUpdate({
          target: alerts.dedupKey,
          set: {
            webhookCount: sql`${alerts.webhookCount} + 1`,
            lastSeenAt: new Date(issue.lastSeen),
          },
        })
        .returning({ id: alerts.id });
      const alertId = inserted[0]?.id;
      if (!alertId) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "alert_upsert_failed" });
      }

      const boss = await getBoss();
      const jobId = await boss.send("triage", { alertId });

      return {
        ok: true as const,
        alertId,
        jobId,
        sentryProject: issue.project.slug,
        title: issue.title,
      };
    }),
});
