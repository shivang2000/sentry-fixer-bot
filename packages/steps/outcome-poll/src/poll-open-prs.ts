/**
 * Per-PR poller. Given a `BotPrRow` (the subset of `prs` columns this
 * step needs) and a `GithubClient` (narrow interface tests + production
 * both implement), decide what outcome to record and return the values
 * the cron entry point should pass to `db.updatePrOutcome`.
 *
 * Outcome decision tree (mirrors the spec):
 *   merged && humanCommits === 0    → merged_clean
 *   merged && humanCommits >  0     → merged_with_edits
 *   !merged && closed_at != null    → closed_unmerged
 *   !merged && !closed && >14d open → stale_open
 *   otherwise                       → null (do nothing)
 *
 * `humanCommits` is computed by counting PR commits whose author is NOT
 * one of the bot logins. Defensive on lookup failure: returns null
 * rather than throwing so the cron can still record the outcome
 * (the spec says: "if commit-author lookup fails, log + record
 * `human_commits=NULL`").
 */

import { fetchReviewComments, type ReviewCommentRecord } from "./fetch-review-comments";

/**
 * GitHub App handle we recognise as bot-authored commits. Legacy
 * `sentry-fixer-bot[bot]` was dropped in alertforge-2.1.0 (P9); any
 * lingering legacy-handle commits on still-open PRs will now count as
 * human commits, which is conservative (over-counts edits, never
 * under-counts).
 */
export const BOT_LOGINS: ReadonlySet<string> = new Set(["alertforge[bot]"]);

/** Days a PR can be open before we declare it stale. */
export const STALE_THRESHOLD_DAYS = 14;

export type PrOutcome = "merged_clean" | "merged_with_edits" | "closed_unmerged" | "stale_open";

export interface BotPrRow {
  /** Row id from the `prs` table. */
  id: string;
  /** GitHub owner/repo slug for the API calls. */
  repo: string;
  /** PR number on that repo. */
  number: number;
  /** When the bot opened the PR. Used for the 14-day stale check. */
  openedAt: Date;
}

export interface GithubClient {
  getPullRequest(input: { owner: string; repo: string; pullNumber: number }): Promise<{
    merged: boolean;
    merged_at: string | null;
    closed_at: string | null;
    base: { sha: string };
    head: { sha: string };
    merge_commit_sha: string | null;
  }>;

  listCommits(input: { owner: string; repo: string; pullNumber: number }): Promise<
    Array<{
      sha: string;
      author?: { login?: string } | null;
      committer?: { login?: string } | null;
    }>
  >;

  listReviewComments(input: { owner: string; repo: string; pullNumber: number }): Promise<
    Array<{
      id: number;
      user: { login: string };
      body: string;
      created_at: string;
      path?: string;
    }>
  >;
}

export interface PrPollOutput {
  outcome: PrOutcome | null;
  /** Count of non-bot commits. `null` when the commit-list API failed. */
  humanCommits: number | null;
  /** Captured for closed_unmerged only; null otherwise. */
  reviewComments: ReviewCommentRecord[] | null;
}

/** Parses `owner/repo` from a `BotPrRow.repo` slug. Throws on malformed. */
function splitRepo(slug: string): { owner: string; repo: string } {
  const idx = slug.indexOf("/");
  if (idx <= 0 || idx === slug.length - 1) {
    throw new Error(`malformed repo slug: ${slug}`);
  }
  return { owner: slug.slice(0, idx), repo: slug.slice(idx + 1) };
}

/**
 * Count commits on the PR whose author is NOT a known bot handle.
 * Returns `null` on API failure (we still want to record the outcome,
 * just without the count — see spec).
 */
async function countHumanCommits(
  github: GithubClient,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<number | null> {
  try {
    const commits = await github.listCommits({ owner, repo, pullNumber });
    let nonBot = 0;
    for (const c of commits) {
      const author = c.author?.login ?? "";
      const committer = c.committer?.login ?? "";
      // Commit counts as bot-authored only if BOTH author and committer
      // are bot-recognised. Defensive: if either field is empty we treat
      // the commit as bot-authored (GitHub omits the author block on
      // unverified commits and the bot's commits often miss the author
      // login; falling back to "bot" avoids over-counting humans).
      const looksLikeBot =
        (BOT_LOGINS.has(author) || author === "") &&
        (BOT_LOGINS.has(committer) || committer === "");
      if (!looksLikeBot) nonBot += 1;
    }
    return nonBot;
  } catch {
    return null;
  }
}

/**
 * Decide the PR's outcome (if any) and gather the columns the caller
 * needs to set. Pure of any DB writes — the cron entry point owns the
 * update so it can keep transactions cohesive.
 */
export async function pollOpenPr(
  pr: BotPrRow,
  deps: { github: GithubClient; now?: () => Date },
): Promise<PrPollOutput> {
  const now = (deps.now ?? (() => new Date()))();
  const { owner, repo } = splitRepo(pr.repo);
  const state = await deps.github.getPullRequest({ owner, repo, pullNumber: pr.number });

  if (state.merged) {
    const humanCommits = await countHumanCommits(deps.github, owner, repo, pr.number);
    const outcome: PrOutcome =
      humanCommits === null
        ? "merged_clean" // defensive fallback when commit lookup failed; spec: humanCommits stays null
        : humanCommits > 0
          ? "merged_with_edits"
          : "merged_clean";
    return { outcome, humanCommits, reviewComments: null };
  }

  if (state.closed_at) {
    // Closed without merge. Capture reviewer comments for V2 modeling.
    const reviewComments = await fetchReviewComments(deps.github, {
      owner,
      repo,
      pullNumber: pr.number,
    });
    return { outcome: "closed_unmerged", humanCommits: 0, reviewComments };
  }

  const ageMs = now.getTime() - pr.openedAt.getTime();
  const staleAfterMs = STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  if (ageMs > staleAfterMs) {
    return { outcome: "stale_open", humanCommits: 0, reviewComments: null };
  }

  return { outcome: null, humanCommits: 0, reviewComments: null };
}
