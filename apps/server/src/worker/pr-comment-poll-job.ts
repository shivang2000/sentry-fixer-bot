import { createDb } from "@sentry-fixer-bot/db";
import { prs } from "@sentry-fixer-bot/db/schema/domain";
import { eq, or } from "drizzle-orm";
import { listPrComments } from "../github/pr-ops";
import { log } from "../log";
import { dispatchPrComment } from "../routes/github-webhook";
import { appendRunLog } from "../runs/log";

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
      runId: prs.runId,
      repo: prs.repo,
      number: prs.number,
      lastReviewedCommentAt: prs.lastReviewedCommentAt,
    })
    .from(prs)
    .where(or(eq(prs.humanReviewState, "waiting_human"), eq(prs.humanReviewState, "none")))
    .limit(200);

  if (rows.length === 0) {
    log.info("[pr-comment-poll] tick — no PRs awaiting /sfb input.");
    return;
  }

  let enqueued = 0;
  let scanned = 0;
  for (const pr of rows) {
    try {
      const since = pr.lastReviewedCommentAt ?? undefined;
      const comments = await listPrComments({
        repo: pr.repo,
        prNumber: pr.number,
        since,
      });
      let prDispatched = 0;
      for (const c of comments) {
        // Skip stale rows where listPrComments returned items at the
        // exact watermark second (`since` is inclusive on the GH API).
        if (since && new Date(c.createdAt) <= since) continue;
        scanned += 1;
        const r = await dispatchPrComment({
          repo: pr.repo,
          prNumber: pr.number,
          comment: c,
        });
        if (r.queued) {
          enqueued += 1;
          prDispatched += 1;
        }
      }
      // Per-PR run_log line so the operator can see at /runs/<id> that
      // the cron actually looked at this PR + whether it found
      // something to act on. Quiet when nothing new — the line below
      // only fires when we dispatched at least one comment.
      if (prDispatched > 0) {
        await appendRunLog({
          runId: pr.runId,
          level: "info",
          source: "pr-comment-poll",
          message: `Cron tick dispatched ${prDispatched} /sfb comment(s) for PR #${pr.number}.`,
        });
      }
    } catch (err) {
      log.warn(
        { prId: pr.id, err: err instanceof Error ? err.message : err },
        "[pr-comment-poll] fetch failed",
      );
    }
  }
  log.info(
    { prs: rows.length, scanned, enqueued },
    enqueued > 0
      ? "[pr-comment-poll] tick — dispatched"
      : "[pr-comment-poll] tick — no commands waiting",
  );
}
