/**
 * `pollOutcomes` — cron entry point.
 *
 * Walks every PR with outcome IS NULL and openedAt within the 14-day
 * window, asks GitHub what state each is in, and records the resulting
 * outcome. Per-PR failures are isolated (try/catch + warn log) so one
 * dead PR doesn't kill the whole sweep.
 *
 * The function is pure of any DB / GitHub dependency — both are
 * injected via `deps`. The production wiring in
 * `apps/server/src/cron/outcome-poll.ts` builds the deps from drizzle +
 * the GitHub App Octokit; tests inject the stubs from
 * `__tests__/fixtures.ts`.
 */

import type { Logger } from "@alertforge/core";
import type { ReviewCommentRecord } from "./fetch-review-comments";
import { type BotPrRow, type GithubClient, type PrOutcome, pollOpenPr } from "./poll-open-prs";

export {
  fetchReviewComments,
  MAX_REVIEW_COMMENTS_BYTES,
  type ReviewCommentRecord,
} from "./fetch-review-comments";
export type {
  BotPrRow,
  GithubClient,
  PrOutcome,
  PrPollOutput,
} from "./poll-open-prs";
export { BOT_LOGINS, pollOpenPr, STALE_THRESHOLD_DAYS } from "./poll-open-prs";

export interface PollOutcomesDb {
  /**
   * Returns every PR row that still needs an outcome and is within the
   * 14-day poll window. Implementation in apps/server runs the drizzle
   * query: `select id, repo, number, opened_at from prs where outcome
   * is null and opened_at >= now() - interval '14 days'`.
   */
  listOpenBotPrs(): Promise<BotPrRow[]>;
  /**
   * Update the outcome columns on a single PR row. Implementation in
   * apps/server runs the drizzle `update prs set …`.
   */
  updatePrOutcome(
    prId: string,
    values: {
      outcome: PrOutcome;
      outcomeRecordedAt: Date;
      humanCommits?: number | null;
      reviewCommentsJsonb?: ReviewCommentRecord[];
    },
  ): Promise<void>;
}

export interface PollOutcomesDeps {
  db: PollOutcomesDb;
  log: Logger;
  /**
   * Resolve a per-PR GitHub client. Tests use this to swap in canned
   * responses per PR. Production typically returns the same global
   * Octokit-backed client for every PR.
   */
  githubFor(pr: BotPrRow): Promise<GithubClient>;
  /** Override for tests. */
  now?(): Date;
}

export async function pollOutcomes(deps: PollOutcomesDeps): Promise<void> {
  const openPrs = await deps.db.listOpenBotPrs();
  let recorded = 0;
  let failures = 0;
  for (const pr of openPrs) {
    try {
      const gh = await deps.githubFor(pr);
      const out = await pollOpenPr(pr, { github: gh, ...(deps.now ? { now: deps.now } : {}) });
      if (!out.outcome) continue;
      const values: Parameters<PollOutcomesDb["updatePrOutcome"]>[1] = {
        outcome: out.outcome,
        outcomeRecordedAt: (deps.now ?? (() => new Date()))(),
      };
      if (out.humanCommits !== null) {
        values.humanCommits = out.humanCommits;
      } else {
        values.humanCommits = null;
      }
      if (out.reviewComments !== null) {
        values.reviewCommentsJsonb = out.reviewComments;
      }
      await deps.db.updatePrOutcome(pr.id, values);
      recorded += 1;
    } catch (err) {
      failures += 1;
      deps.log.warn(
        {
          prId: pr.id,
          repo: pr.repo,
          number: pr.number,
          err: err instanceof Error ? err.message : String(err),
        },
        "outcome-poll: per-PR poll failed",
      );
    }
  }
  deps.log.info({ total: openPrs.length, recorded, failures }, "outcome-poll: sweep complete");
}
