/**
 * Happy-path integration test for the outcome-poll cron loop.
 *
 * Walks ONE PR fixture through every terminal state by re-running the
 * sweep with a different `FakeGithub` response on each pass:
 *
 *   1. PR open <14d, not merged, not closed → outcome stays null.
 *   2. Operator merges PR with one bot commit → merged_clean.
 *
 * Then walks separate PRs through merged_with_edits + closed_unmerged
 * + stale_open. Asserts the cron emits the right `updatePrOutcome`
 * call for each.
 */

import { describe, expect, it } from "bun:test";
import { pollOutcomes } from "../index";
import { FakeGithub, makeBotPr, REVIEW_COMMENTS_FIXTURE } from "./fixtures";

interface RecordedUpdate {
  prId: string;
  outcome: string;
  humanCommits: number | null | undefined;
  hasReviewComments: boolean;
}

class StubDb {
  prs: ReturnType<typeof makeBotPr>[] = [];
  updates: RecordedUpdate[] = [];
  async listOpenBotPrs() {
    // After a poll records an outcome the row should leave the
    // "outcome is null" set. We simulate that by removing it from the
    // listing when an update arrives.
    return this.prs.filter((p) => !this.updates.some((u) => u.prId === p.id));
  }
  async updatePrOutcome(
    prId: string,
    values: {
      outcome: string;
      humanCommits?: number | null;
      reviewCommentsJsonb?: unknown;
    },
  ) {
    this.updates.push({
      prId,
      outcome: values.outcome,
      humanCommits: values.humanCommits,
      hasReviewComments: values.reviewCommentsJsonb !== undefined,
    });
  }
}

const SILENT = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return SILENT;
  },
};

describe("outcome-poll — integration", () => {
  it("walks a PR through young-open → merged_clean as the GitHub state evolves", async () => {
    const db = new StubDb();
    const pr = makeBotPr({
      id: "pr-evolving",
      openedAt: new Date(Date.now() - 3 * 86400_000),
    });
    db.prs.push(pr);

    // Pass 1: PR is open <14d, not merged. No outcome.
    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () =>
        new FakeGithub({
          prState: {
            merged: false,
            merged_at: null,
            closed_at: null,
            base: { sha: "base" },
            head: { sha: "head" },
            merge_commit_sha: null,
          },
        }),
    });
    expect(db.updates.length).toBe(0);

    // Pass 2: PR is now merged with only bot commits.
    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () =>
        new FakeGithub({
          prState: {
            merged: true,
            merged_at: new Date().toISOString(),
            closed_at: new Date().toISOString(),
            base: { sha: "base" },
            head: { sha: "head" },
            merge_commit_sha: "merge",
          },
          commits: [
            {
              sha: "c1",
              author: { login: "alertforge[bot]" },
              committer: { login: "alertforge[bot]" },
            },
          ],
        }),
    });
    expect(db.updates).toEqual([
      { prId: "pr-evolving", outcome: "merged_clean", humanCommits: 0, hasReviewComments: false },
    ]);

    // Pass 3: PR is no longer in the open set; no further updates.
    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () => new FakeGithub({}),
    });
    expect(db.updates.length).toBe(1);
  });

  it("records merged_with_edits when a human committed before merge", async () => {
    const db = new StubDb();
    db.prs.push(makeBotPr({ id: "pr-edits", openedAt: new Date(Date.now() - 2 * 86400_000) }));

    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () =>
        new FakeGithub({
          prState: {
            merged: true,
            merged_at: new Date().toISOString(),
            closed_at: new Date().toISOString(),
            base: { sha: "base" },
            head: { sha: "head" },
            merge_commit_sha: "merge",
          },
          commits: [
            {
              sha: "c1",
              author: { login: "alertforge[bot]" },
              committer: { login: "alertforge[bot]" },
            },
            { sha: "c2", author: { login: "alice" }, committer: { login: "alice" } },
            { sha: "c3", author: { login: "alice" }, committer: { login: "alice" } },
          ],
        }),
    });
    expect(db.updates[0]?.outcome).toBe("merged_with_edits");
    expect(db.updates[0]?.humanCommits).toBe(2);
  });

  it("records closed_unmerged + captures review comments when the human rejects", async () => {
    const db = new StubDb();
    db.prs.push(makeBotPr({ id: "pr-closed", openedAt: new Date(Date.now() - 5 * 86400_000) }));

    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () =>
        new FakeGithub({
          prState: {
            merged: false,
            merged_at: null,
            closed_at: new Date().toISOString(),
            base: { sha: "base" },
            head: { sha: "head" },
            merge_commit_sha: null,
          },
          reviewComments: REVIEW_COMMENTS_FIXTURE,
        }),
    });
    expect(db.updates[0]?.outcome).toBe("closed_unmerged");
    expect(db.updates[0]?.hasReviewComments).toBe(true);
  });

  it("records stale_open after 14 days with no terminal action", async () => {
    const db = new StubDb();
    db.prs.push(makeBotPr({ id: "pr-stale", openedAt: new Date(Date.now() - 16 * 86400_000) }));

    await pollOutcomes({
      db,
      log: SILENT,
      githubFor: async () =>
        new FakeGithub({
          prState: {
            merged: false,
            merged_at: null,
            closed_at: null,
            base: { sha: "base" },
            head: { sha: "head" },
            merge_commit_sha: null,
          },
        }),
    });
    expect(db.updates[0]?.outcome).toBe("stale_open");
    expect(db.updates[0]?.hasReviewComments).toBe(false);
  });
});
