/**
 * Integration test for the `pollOutcomes` cron entry point.
 *
 * Verifies:
 *   - Lists every PR with outcome IS NULL and openedAt within the
 *     14-day window (DB stub returns 4 PRs across all four outcome
 *     states).
 *   - Each PR's outcome update lands on the db stub with the right
 *     status (merged_clean | merged_with_edits | closed_unmerged |
 *     stale_open).
 *   - Review comments are captured ONLY for closed_unmerged.
 *   - One failing PR (network error from GitHub) doesn't kill the
 *     sweep: subsequent PRs still get updated, and the failure is
 *     logged at warn level.
 *   - openedAt < 14d AND no terminal state → no DB update at all.
 */

import { describe, expect, it } from "bun:test";
import { pollOutcomes } from "../index";
import { FakeGithub, makeBotPr, REVIEW_COMMENTS_FIXTURE } from "./fixtures";

interface StubLogEntry {
  level: string;
  message: string;
  data?: unknown;
}

interface DbUpdateCall {
  prId: string;
  values: {
    outcome: string | null;
    outcomeRecordedAt: Date;
    humanCommits?: number | null;
    reviewCommentsJsonb?: unknown;
  };
}

class StubLogger {
  readonly entries: StubLogEntry[] = [];
  debug = (obj: object | string, msg?: string) => this.record("debug", obj, msg);
  info = (obj: object | string, msg?: string) => this.record("info", obj, msg);
  warn = (obj: object | string, msg?: string) => this.record("warn", obj, msg);
  error = (obj: object | string, msg?: string) => this.record("error", obj, msg);
  child = () => this;
  private record(level: string, obj: object | string, msg?: string) {
    this.entries.push({
      level,
      message: typeof obj === "string" ? obj : (msg ?? ""),
      data: typeof obj === "string" ? undefined : obj,
    });
  }
}

class StubDb {
  readonly listResult: ReturnType<typeof makeBotPr>[] = [];
  readonly updates: DbUpdateCall[] = [];
  async listOpenBotPrs() {
    return this.listResult;
  }
  async updatePrOutcome(prId: string, values: DbUpdateCall["values"]) {
    this.updates.push({ prId, values });
  }
}

function makeGithubFor(
  state: "merged_clean" | "merged_with_edits" | "closed_unmerged" | "stale_open" | "throws",
) {
  const now = new Date().toISOString();
  switch (state) {
    case "merged_clean":
      return new FakeGithub({
        prState: {
          merged: true,
          merged_at: now,
          closed_at: now,
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
      });
    case "merged_with_edits":
      return new FakeGithub({
        prState: {
          merged: true,
          merged_at: now,
          closed_at: now,
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
        ],
      });
    case "closed_unmerged":
      return new FakeGithub({
        prState: {
          merged: false,
          merged_at: null,
          closed_at: now,
          base: { sha: "base" },
          head: { sha: "head" },
          merge_commit_sha: null,
        },
        reviewComments: REVIEW_COMMENTS_FIXTURE,
      });
    case "stale_open":
      return new FakeGithub({
        prState: {
          merged: false,
          merged_at: null,
          closed_at: null,
          base: { sha: "base" },
          head: { sha: "head" },
          merge_commit_sha: null,
        },
      });
    case "throws":
      return new FakeGithub({}); // prState missing → getPullRequest throws.
  }
}

describe("pollOutcomes", () => {
  it("walks every open PR and records the correct outcome per state", async () => {
    const db = new StubDb();
    const log = new StubLogger();

    db.listResult.push(
      makeBotPr({ id: "pr-merged-clean", openedAt: new Date(Date.now() - 3 * 86400_000) }),
      makeBotPr({ id: "pr-merged-edits", openedAt: new Date(Date.now() - 3 * 86400_000) }),
      makeBotPr({ id: "pr-closed", openedAt: new Date(Date.now() - 2 * 86400_000) }),
      makeBotPr({ id: "pr-stale", openedAt: new Date(Date.now() - 15 * 86400_000) }),
    );

    const githubByPr: Record<string, FakeGithub> = {
      "pr-merged-clean": makeGithubFor("merged_clean"),
      "pr-merged-edits": makeGithubFor("merged_with_edits"),
      "pr-closed": makeGithubFor("closed_unmerged"),
      "pr-stale": makeGithubFor("stale_open"),
    };

    await pollOutcomes({
      db,
      log,
      githubFor: async (pr) => githubByPr[pr.id]!,
    });

    expect(db.updates.length).toBe(4);
    const byId = Object.fromEntries(db.updates.map((u) => [u.prId, u]));
    expect(byId["pr-merged-clean"]?.values.outcome).toBe("merged_clean");
    expect(byId["pr-merged-clean"]?.values.humanCommits).toBe(0);
    expect(byId["pr-merged-edits"]?.values.outcome).toBe("merged_with_edits");
    expect(byId["pr-merged-edits"]?.values.humanCommits).toBe(1);
    expect(byId["pr-closed"]?.values.outcome).toBe("closed_unmerged");
    expect(byId["pr-stale"]?.values.outcome).toBe("stale_open");
  });

  it("captures review comments only for closed_unmerged", async () => {
    const db = new StubDb();
    const log = new StubLogger();
    db.listResult.push(
      makeBotPr({ id: "pr-closed", openedAt: new Date(Date.now() - 2 * 86400_000) }),
      makeBotPr({ id: "pr-stale", openedAt: new Date(Date.now() - 15 * 86400_000) }),
    );

    const githubByPr: Record<string, FakeGithub> = {
      "pr-closed": makeGithubFor("closed_unmerged"),
      "pr-stale": makeGithubFor("stale_open"),
    };

    await pollOutcomes({
      db,
      log,
      githubFor: async (pr) => githubByPr[pr.id]!,
    });

    const closedUpdate = db.updates.find((u) => u.prId === "pr-closed");
    const staleUpdate = db.updates.find((u) => u.prId === "pr-stale");
    expect(closedUpdate?.values.reviewCommentsJsonb).toBeDefined();
    expect(staleUpdate?.values.reviewCommentsJsonb).toBeUndefined();
  });

  it("continues sweeping after one PR's poll throws", async () => {
    const db = new StubDb();
    const log = new StubLogger();
    db.listResult.push(
      makeBotPr({ id: "pr-bad" }),
      makeBotPr({ id: "pr-good", openedAt: new Date(Date.now() - 3 * 86400_000) }),
    );

    await pollOutcomes({
      db,
      log,
      githubFor: async (pr) =>
        pr.id === "pr-bad" ? makeGithubFor("throws") : makeGithubFor("merged_clean"),
    });

    expect(db.updates.length).toBe(1);
    expect(db.updates[0]?.prId).toBe("pr-good");
    expect(log.entries.some((e) => e.level === "warn")).toBe(true);
  });

  it("does NOT write an update when the PR has no terminal state yet", async () => {
    const db = new StubDb();
    const log = new StubLogger();
    db.listResult.push(
      makeBotPr({ id: "pr-open-young", openedAt: new Date(Date.now() - 2 * 86400_000) }),
    );

    const gh = new FakeGithub({
      prState: {
        merged: false,
        merged_at: null,
        closed_at: null,
        base: { sha: "base" },
        head: { sha: "head" },
        merge_commit_sha: null,
      },
    });

    await pollOutcomes({
      db,
      log,
      githubFor: async () => gh,
    });

    expect(db.updates.length).toBe(0);
  });
});
