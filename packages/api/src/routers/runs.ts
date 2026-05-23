import { createDb } from "@alertforge/db";
import { repos } from "@alertforge/db/schema/admin";
import { alerts, prs, runLogs, runs } from "@alertforge/db/schema/domain";
import { triggers } from "@alertforge/db/schema/triggers";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, gte, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { z } from "zod";
import { adminProcedure, protectedProcedure, router } from "../index";

const WindowSchema = z.enum(["24h", "7d"]);
function windowToCutoff(w: z.infer<typeof WindowSchema>): Date {
  const ms = w === "24h" ? 24 * 3600_000 : 7 * 24 * 3600_000;
  return new Date(Date.now() - ms);
}

let bossInstance: PgBoss | null = null;
async function getBoss(): Promise<PgBoss> {
  if (bossInstance) return bossInstance;
  const { env } = await import("@alertforge/env/server");
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
  const { getSentryToken } = await import("../run/sentry-runner");
  const token = await getSentryToken();
  if (!token) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Sentry not configured — run `sentry auth login` from the wizard or paste SENTRY_API_TOKEN in /settings.",
    });
  }
  const res = await fetch(`https://sentry.io/api/0/issues/${issueId}/`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
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
    const rows = await db
      .select({ run: runs, alert: alerts, pr: prs })
      .from(runs)
      .innerJoin(alerts, eq(alerts.id, runs.alertId))
      .leftJoin(prs, eq(prs.runId, runs.id))
      .where(eq(runs.id, input.id))
      .limit(1);
    return rows[0] ?? null;
  }),

  // Live log tail. UI polls every 2s passing the last `seq` it has.
  // Server returns rows with `seq > lastSeq` ordered ascending. 500
  // per fetch is enough for human-readable bursts; throttle the writer
  // upstream if you need bigger.
  logs: protectedProcedure
    .input(z.object({ runId: z.string().uuid(), afterSeq: z.number().int().min(0).default(0) }))
    .query(async ({ input }) => {
      const db = createDb();
      return db
        .select()
        .from(runLogs)
        .where(and(eq(runLogs.runId, input.runId), gt(runLogs.seq, input.afterSeq)))
        .orderBy(asc(runLogs.seq))
        .limit(500);
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

  /**
   * Roll up run costs by trigger over a window. Admin-only — surfaces
   * dollar amounts and PR counts that are operator-business.
   *
   * Returns one row per trigger that has had ≥1 run in the window,
   * with the trigger's repo + preset joined in so the /usage UI can
   * render a card per trigger without a follow-up call.
   */
  usageByTrigger: adminProcedure
    .input(z.object({ window: WindowSchema.default("24h") }))
    .query(async ({ input }) => {
      const db = createDb();
      const cutoff = windowToCutoff(input.window);
      const rows = await db
        .select({
          triggerId: triggers.id,
          triggerName: triggers.name,
          preset: triggers.preset,
          sourceType: triggers.sourceType,
          sourceProject: triggers.sourceProject,
          repoGithub: repos.github,
          dailyCostCapCents: repos.dailyCostCapCents,
          runCount: sql<number>`count(${runs.id})::int`.as("run_count"),
          prCount: sql<number>`count(distinct ${prs.id})::int`.as("pr_count"),
          totalCostCents: sql<number>`coalesce(sum(${runs.costCents}), 0)::int`.as(
            "total_cost_cents",
          ),
          totalTokensInput: sql<number>`coalesce(sum(${runs.tokensInput}), 0)::int`.as(
            "total_tokens_input",
          ),
          totalTokensOutput: sql<number>`coalesce(sum(${runs.tokensOutput}), 0)::int`.as(
            "total_tokens_output",
          ),
        })
        .from(triggers)
        .innerJoin(repos, eq(repos.id, triggers.repoId))
        .leftJoin(runs, and(eq(runs.triggerId, triggers.id), gte(runs.startedAt, cutoff)))
        .leftJoin(prs, eq(prs.runId, runs.id))
        .groupBy(
          triggers.id,
          triggers.name,
          triggers.preset,
          triggers.sourceType,
          triggers.sourceProject,
          repos.github,
          repos.dailyCostCapCents,
        )
        .orderBy(desc(sql`total_cost_cents`));
      return rows;
    }),

  /**
   * Roll up run costs by pipeline step over a window. Admin-only.
   *
   * Each run records the steps it completed in jsonb column
   * `steps_completed`; we explode that array via `jsonb_array_elements_text`
   * and group by step name. Cost is apportioned evenly across steps —
   * V1 keeps the rollup honest-by-default until P8 lands per-step cost
   * accounting on the runs table.
   */
  usageByStep: adminProcedure
    .input(z.object({ window: WindowSchema.default("24h") }))
    .query(async ({ input }) => {
      const db = createDb();
      const cutoff = windowToCutoff(input.window);
      const result = await db.execute<{
        step_name: string;
        run_count: number;
        total_cost_cents: number;
        total_tokens_input: number;
        total_tokens_output: number;
      }>(sql`
        with exploded as (
          select
            r.id as run_id,
            r.cost_cents,
            r.tokens_input,
            r.tokens_output,
            coalesce(jsonb_array_length(r.steps_completed), 0) as step_count,
            jsonb_array_elements_text(r.steps_completed) as step_name
          from ${runs} r
          where r.started_at >= ${cutoff}
            and r.steps_completed is not null
            and jsonb_typeof(r.steps_completed) = 'array'
            and jsonb_array_length(r.steps_completed) > 0
        )
        select
          step_name,
          count(distinct run_id)::int as run_count,
          coalesce(sum(cost_cents / nullif(step_count, 0)), 0)::int as total_cost_cents,
          coalesce(sum(tokens_input / nullif(step_count, 0)), 0)::int as total_tokens_input,
          coalesce(sum(tokens_output / nullif(step_count, 0)), 0)::int as total_tokens_output
        from exploded
        group by step_name
        order by total_cost_cents desc
      `);
      // node-postgres adapter returns { rows: [...] }; bun-sql returns
      // an array directly. Handle both shapes for portability.
      const rows = (result as { rows?: unknown }).rows ?? result;
      return Array.isArray(rows)
        ? (rows as Array<{
            step_name: string;
            run_count: number;
            total_cost_cents: number;
            total_tokens_input: number;
            total_tokens_output: number;
          }>)
        : [];
    }),

  /**
   * P8 — daily outcome roll-up per trigger for the OutcomeChart UI
   * component. Returns one row per day with the four outcome counts so
   * the chart can stack-bar them. Days with zero activity are emitted
   * as zero rows so the chart length is consistent.
   *
   * Joins prs → runs to filter by trigger_id; groups by date of
   * `outcome_recorded_at` (NULL outcomes are excluded — they're still
   * in flight). When the trigger has no recorded outcomes yet the
   * function returns []; the component renders the empty state.
   */
  outcomeChart: adminProcedure
    .input(
      z.object({
        triggerId: z.string().uuid(),
        days: z.number().int().min(1).max(180).default(30),
      }),
    )
    .query(async ({ input }) => {
      const db = createDb();
      const result = await db.execute<{
        bucket: string;
        merged_clean: number;
        merged_with_edits: number;
        closed_unmerged: number;
        stale_open: number;
      }>(sql`
        with days as (
          select generate_series(
            (current_date - (${input.days - 1})::int)::date,
            current_date,
            '1 day'::interval
          )::date as bucket
        ),
        outcomes as (
          select
            ${prs.outcomeRecordedAt}::date as bucket,
            count(*) filter (where ${prs.outcome} = 'merged_clean')::int as merged_clean,
            count(*) filter (where ${prs.outcome} = 'merged_with_edits')::int as merged_with_edits,
            count(*) filter (where ${prs.outcome} = 'closed_unmerged')::int as closed_unmerged,
            count(*) filter (where ${prs.outcome} = 'stale_open')::int as stale_open
          from ${prs}
          inner join ${runs} on ${runs.id} = ${prs.runId}
          where ${runs.triggerId} = ${input.triggerId}
            and ${prs.outcomeRecordedAt} is not null
            and ${prs.outcomeRecordedAt} >= current_date - (${input.days - 1})::int
          group by 1
        )
        select
          to_char(d.bucket, 'YYYY-MM-DD') as bucket,
          coalesce(o.merged_clean, 0)::int as merged_clean,
          coalesce(o.merged_with_edits, 0)::int as merged_with_edits,
          coalesce(o.closed_unmerged, 0)::int as closed_unmerged,
          coalesce(o.stale_open, 0)::int as stale_open
        from days d
        left join outcomes o on o.bucket = d.bucket
        order by d.bucket asc
      `);
      const rows = (result as { rows?: unknown }).rows ?? result;
      return Array.isArray(rows)
        ? (rows as Array<{
            bucket: string;
            merged_clean: number;
            merged_with_edits: number;
            closed_unmerged: number;
            stale_open: number;
          }>)
        : [];
    }),
});
