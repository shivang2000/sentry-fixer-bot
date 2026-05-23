/**
 * Tests for `pollOpenPr` — the per-PR helper that talks to GitHub and
 * decides what `outcome` (if any) to set on the row. The cron sweep
 * loops over PRs in `pollOutcomes` and delegates to this helper.
 *
 * Verifies the four state transitions:
 *   - merged with no human commits → merged_clean
 *   - merged with human commits    → merged_with_edits
 *   - closed without merge         → closed_unmerged
 *   - open > 14d                   → stale_open
 * And the no-op case (open < 14d, not closed): outcome stays null.
 */

import { describe, expect, it } from "bun:test";
import { pollOpenPr } from "../poll-open-prs";
import { FakeGithub, makeBotPr, REVIEW_COMMENTS_FIXTURE } from "./fixtures";

describe("pollOpenPr", () => {
  it("records merged_clean when PR is merged and only the bot has commits", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: true,
        merged_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: "merge-sha",
      },
      commits: [
        {
          sha: "c1",
          author: { login: "alertforge[bot]" },
          committer: { login: "alertforge[bot]" },
        },
        {
          sha: "c2",
          author: { login: "alertforge[bot]" },
          committer: { login: "alertforge[bot]" },
        },
      ],
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBe("merged_clean");
    expect(out.humanCommits).toBe(0);
    expect(out.reviewComments).toBeNull();
  });

  it("records merged_with_edits when human committed before merge", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: true,
        merged_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: "merge-sha",
      },
      commits: [
        {
          sha: "c1",
          author: { login: "alertforge[bot]" },
          committer: { login: "alertforge[bot]" },
        },
        { sha: "c2", author: { login: "alice" }, committer: { login: "alice" } },
        { sha: "c3", author: { login: "bob" }, committer: { login: "bob" } },
      ],
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBe("merged_with_edits");
    expect(out.humanCommits).toBe(2);
  });

  it("records closed_unmerged when PR is closed without a merge", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: false,
        merged_at: null,
        closed_at: new Date().toISOString(),
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: null,
      },
      reviewComments: REVIEW_COMMENTS_FIXTURE,
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBe("closed_unmerged");
    expect(out.humanCommits).toBe(0);
    expect(out.reviewComments).not.toBeNull();
    expect(Array.isArray(out.reviewComments)).toBe(true);
    expect(out.reviewComments?.length).toBe(REVIEW_COMMENTS_FIXTURE.length);
  });

  it("records stale_open when PR has been open > 14 days", async () => {
    const pr = makeBotPr({
      openedAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000),
    });
    const gh = new FakeGithub({
      prState: {
        merged: false,
        merged_at: null,
        closed_at: null,
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: null,
      },
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBe("stale_open");
    expect(out.reviewComments).toBeNull();
  });

  it("returns no outcome when PR is open and < 14 days old", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: false,
        merged_at: null,
        closed_at: null,
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: null,
      },
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBeNull();
  });

  it("no longer recognises sentry-fixer-bot[bot] as a bot — legacy handle is treated as human (P9 cleanup)", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: true,
        merged_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: "merge-sha",
      },
      commits: [
        {
          sha: "c1",
          author: { login: "sentry-fixer-bot[bot]" },
          committer: { login: "sentry-fixer-bot[bot]" },
        },
      ],
    });
    const out = await pollOpenPr(pr, { github: gh });
    // Legacy handle no longer counted as a bot, so the commit counts
    // as a human edit → merged_with_edits.
    expect(out.outcome).toBe("merged_with_edits");
    expect(out.humanCommits).toBe(1);
  });

  it("treats commit-author lookup failure as humanCommits=null without throwing", async () => {
    const pr = makeBotPr({ openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const gh = new FakeGithub({
      prState: {
        merged: true,
        merged_at: new Date().toISOString(),
        closed_at: new Date().toISOString(),
        base: { sha: "base-sha" },
        head: { sha: "head-sha" },
        merge_commit_sha: "merge-sha",
      },
      commitsThrow: true,
    });
    const out = await pollOpenPr(pr, { github: gh });
    expect(out.outcome).toBe("merged_clean");
    expect(out.humanCommits).toBeNull();
  });
});
