/**
 * Test fixtures for the outcome-poll step. Provides:
 *   - `FakeGithub` — a tiny stub of the Octokit-shaped surface
 *     `pollOpenPr` needs. Tests configure the canned response per call.
 *   - `makeBotPr` — synthesizes a `BotPrRow` with sensible defaults.
 *   - `REVIEW_COMMENTS_FIXTURE` — sample review-comment payload.
 */

import type { BotPrRow, GithubClient, PrPollOutput } from "../poll-open-prs";

export interface FakeGithubOptions {
  prState?: {
    merged: boolean;
    merged_at: string | null;
    closed_at: string | null;
    base: { sha: string };
    head: { sha: string };
    merge_commit_sha: string | null;
  };
  commits?: Array<{
    sha: string;
    author?: { login?: string } | null;
    committer?: { login?: string } | null;
  }>;
  commitsThrow?: boolean;
  reviewComments?: Array<{
    id: number;
    user: { login: string };
    body: string;
    created_at: string;
    path?: string;
  }>;
  reviewCommentsThrow?: boolean;
}

export class FakeGithub implements GithubClient {
  readonly calls: Array<{ op: string; args: unknown }> = [];
  constructor(private readonly opts: FakeGithubOptions = {}) {}

  async getPullRequest(input: { owner: string; repo: string; pullNumber: number }) {
    this.calls.push({ op: "getPullRequest", args: input });
    if (!this.opts.prState) {
      throw new Error("FakeGithub: prState not configured");
    }
    return this.opts.prState;
  }

  async listCommits(input: { owner: string; repo: string; pullNumber: number }) {
    this.calls.push({ op: "listCommits", args: input });
    if (this.opts.commitsThrow) {
      throw new Error("simulated GitHub commits API failure");
    }
    return this.opts.commits ?? [];
  }

  async listReviewComments(input: { owner: string; repo: string; pullNumber: number }) {
    this.calls.push({ op: "listReviewComments", args: input });
    if (this.opts.reviewCommentsThrow) {
      throw new Error("simulated GitHub review-comments API failure");
    }
    return this.opts.reviewComments ?? [];
  }
}

export function makeBotPr(overrides: Partial<BotPrRow> = {}): BotPrRow {
  return {
    id: "pr-1",
    repo: "acme/api",
    number: 42,
    openedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

export const REVIEW_COMMENTS_FIXTURE = [
  {
    id: 1,
    user: { login: "alice" },
    body: "Why are we doing it this way and not using the existing helper?",
    created_at: "2026-05-22T10:00:00Z",
    path: "src/foo.ts",
  },
  {
    id: 2,
    user: { login: "bob" },
    body: "Missing test for the async branch.",
    created_at: "2026-05-22T11:30:00Z",
    path: "src/foo.ts",
  },
];

export type _AnyOutput = PrPollOutput;
