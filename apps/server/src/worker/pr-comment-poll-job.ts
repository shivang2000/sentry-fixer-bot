import { createDb } from "@sentry-fixer-bot/db";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq, or } from "drizzle-orm";
import { listPrComments } from "../github/pr-ops";
import { log } from "../log";
import { dispatchPrComment } from "../routes/github-webhook";

/**
 * Cron fallback that polls open sentry-fixer-bot PRs for /sfb comments
 * the GitHub App webhook may have missed (or that arrive while the
 * webhook is unconfigured). Same dispatch path as the webhook so the
 * /sfb prefix + reviewer allow-list filters apply identically.
 *
 * Scope: PRs in `waiting_human` (reviewer left a blocker) or `none`
 * state (reviewer might still want to amend a clean PR). We skip
 * `in_progress` because the follow-up worker is actively writing.
 *
 * Cadence (worker/index.ts): every 15m. The lastReviewedCommentAt
 * watermark on the PR row makes the same comment safe to receive
 * multiple times across webhook + poll deliveries.
 */
export async function processPrCommentPollJob(): Promise<void> {
  const db = createDb();
  const rows = await db
    .select({
      id: prs.id,
      repo: prs.repo,
      number: prs.number,
      lastReviewedCommentAt: prs.lastReviewedCommentAt,
    })
    .from(prs)
    .where(or(eq(prs.humanReviewState, "waiting_human"), eq(prs.humanReviewState, "none")))
    .limit(200);

  if (rows.length === 0) {
    return;
  }

  let enqueued = 0;
  for (const pr of rows) {
    try {
      const since = pr.lastReviewedCommentAt ?? undefined;
      const comments = await listPrComments({
        repo: pr.repo,
        prNumber: pr.number,
        since,
      });
      for (const c of comments) {
        // Skip stale rows where listPrComments returned items at the
        // exact watermark second (`since` is inclusive on the GH API).
        if (since && new Date(c.createdAt) <= since) continue;
        const r = await dispatchPrComment({
          repo: pr.repo,
          prNumber: pr.number,
          comment: c,
        });
        if (r.queued) enqueued += 1;
      }
    } catch (err) {
      log.warn(
        { prId: pr.id, err: err instanceof Error ? err.message : err },
        "[pr-comment-poll] fetch failed",
      );
    }
  }
  if (enqueued > 0) {
    log.info({ enqueued }, "[pr-comment-poll] tick");
  }
}
