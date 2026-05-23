/**
 * Cron registration for the daily outcome-poll sweep.
 *
 * Schedule: 02:00 UTC daily (well outside the European workday so the
 * GitHub API budget is fresh and the sweep doesn't compete with the
 * Sentry-poll cron). Cadence is fixed at "1d" because polling more
 * often doesn't help — outcomes are slow events that play out over
 * hours/days, not minutes.
 *
 * Per-PR work: ask GitHub for the PR's state, count human commits if
 * merged, fetch review comments if closed-unmerged, and write the
 * outcome columns. Failures per PR are isolated inside `pollOutcomes`
 * itself.
 *
 * The cron job runs through pg-boss like every other recurring job in
 * the system — no new infrastructure. We register a queue name +
 * worker + schedule in the worker bootstrap.
 */

import { createDb } from "@sentry-fixer-bot/db";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import {
  type BotPrRow,
  type GithubClient,
  type PollOutcomesDb,
  type PrOutcome,
  pollOutcomes,
  type ReviewCommentRecord,
} from "@sentry-fixer-bot/step-outcome-poll";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getInstallationOctokit } from "../github/app-auth";
import { log } from "../log";

export const JOB_OUTCOME_POLL = "outcome-poll" as const;
export const OUTCOME_POLL_CRON = "0 2 * * *"; // 02:00 UTC daily

function makeDbAdapter(): PollOutcomesDb {
  const db = createDb();
  return {
    async listOpenBotPrs(): Promise<BotPrRow[]> {
      const rows = await db
        .select({
          id: prs.id,
          repo: prs.repo,
          number: prs.number,
          openedAt: prs.openedAt,
        })
        .from(prs)
        .where(and(isNull(prs.outcome), gte(prs.openedAt, sql`now() - interval '14 days'`)));
      return rows.map((r) => ({
        id: r.id,
        repo: r.repo,
        number: r.number,
        openedAt: r.openedAt,
      }));
    },
    async updatePrOutcome(
      prId: string,
      values: {
        outcome: PrOutcome;
        outcomeRecordedAt: Date;
        humanCommits?: number | null;
        reviewCommentsJsonb?: ReviewCommentRecord[];
      },
    ): Promise<void> {
      const set: Record<string, unknown> = {
        outcome: values.outcome,
        outcomeRecordedAt: values.outcomeRecordedAt,
      };
      // `human_commits` is NOT NULL with default 0 in the schema. Spec
      // asks us to write null when the commit lookup failed; in practice
      // the column doesn't accept null, so we coerce to 0 and rely on
      // operators reading the warn log to know the count is suspect.
      if (values.humanCommits !== undefined) {
        set.humanCommits = values.humanCommits ?? 0;
      }
      if (values.reviewCommentsJsonb !== undefined) {
        set.reviewCommentsJsonb = values.reviewCommentsJsonb;
      }
      await db.update(prs).set(set).where(eq(prs.id, prId));
    },
  };
}

/**
 * Wraps Octokit calls to satisfy the `GithubClient` shape the step
 * package expects. Adapter logic lives here so the step package stays
 * free of @octokit/rest as a runtime dep.
 */
async function makeGithubClient(): Promise<GithubClient> {
  const octokit = await getInstallationOctokit();
  return {
    async getPullRequest(input) {
      const r = await octokit.pulls.get({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
      });
      const data = r.data as {
        merged: boolean;
        merged_at: string | null;
        closed_at: string | null;
        base: { sha: string };
        head: { sha: string };
        merge_commit_sha: string | null;
      };
      return {
        merged: data.merged,
        merged_at: data.merged_at,
        closed_at: data.closed_at,
        base: { sha: data.base.sha },
        head: { sha: data.head.sha },
        merge_commit_sha: data.merge_commit_sha,
      };
    },
    async listCommits(input) {
      const r = await octokit.pulls.listCommits({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
      });
      return (
        r.data as Array<{
          sha: string;
          author: { login?: string } | null;
          committer: { login?: string } | null;
        }>
      ).map((c) => {
        const out: {
          sha: string;
          author?: { login?: string } | null;
          committer?: { login?: string } | null;
        } = { sha: c.sha };
        if (c.author !== null) out.author = c.author;
        if (c.committer !== null) out.committer = c.committer;
        return out;
      });
    },
    async listReviewComments(input) {
      const r = await octokit.pulls.listReviewComments({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.pullNumber,
        per_page: 100,
      });
      return (
        r.data as Array<{
          id: number;
          user: { login: string } | null;
          body: string;
          created_at: string;
          path?: string;
        }>
      ).map((c) => {
        const rec: {
          id: number;
          user: { login: string };
          body: string;
          created_at: string;
          path?: string;
        } = {
          id: c.id,
          user: { login: c.user?.login ?? "unknown" },
          body: c.body,
          created_at: c.created_at,
        };
        if (c.path !== undefined) rec.path = c.path;
        return rec;
      });
    },
  };
}

/**
 * pg-boss worker callback. Invoked once per fired tick. The function
 * is intentionally tolerant — pollOutcomes already wraps every per-PR
 * call in try/catch.
 */
export async function processOutcomePollJob(): Promise<void> {
  try {
    const githubClient = await makeGithubClient();
    await pollOutcomes({
      db: makeDbAdapter(),
      log,
      githubFor: async () => githubClient,
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "outcome-poll: sweep failed (top-level)",
    );
  }
}
