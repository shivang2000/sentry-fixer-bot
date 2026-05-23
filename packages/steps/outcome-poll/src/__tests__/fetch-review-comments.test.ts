/**
 * Tests for `fetchReviewComments` and its 16 KB truncation guard.
 *
 * - Returns ordered list (most-recent first) so truncation drops the
 *   OLDEST entries when over the cap, per spec: "keep most-recent
 *   reviewer comments".
 * - Below 16 KB: returns every comment unchanged.
 * - Above 16 KB: drops oldest until under cap.
 * - Empty list: returns [].
 */

import { describe, expect, it } from "bun:test";
import { fetchReviewComments, MAX_REVIEW_COMMENTS_BYTES } from "../fetch-review-comments";
import { FakeGithub } from "./fixtures";

describe("fetchReviewComments", () => {
  it("returns every comment when under the 16 KB cap", async () => {
    const gh = new FakeGithub({
      reviewComments: [
        {
          id: 1,
          user: { login: "alice" },
          body: "small",
          created_at: "2026-05-22T10:00:00Z",
          path: "x.ts",
        },
        {
          id: 2,
          user: { login: "bob" },
          body: "tiny",
          created_at: "2026-05-22T11:00:00Z",
          path: "x.ts",
        },
      ],
    });
    const out = await fetchReviewComments(gh, { owner: "acme", repo: "api", pullNumber: 1 });
    expect(out.length).toBe(2);
    expect(out[0]?.userLogin).toBe("alice");
    expect(out[1]?.userLogin).toBe("bob");
  });

  it("returns [] when no review comments exist", async () => {
    const gh = new FakeGithub({ reviewComments: [] });
    const out = await fetchReviewComments(gh, { owner: "acme", repo: "api", pullNumber: 1 });
    expect(out).toEqual([]);
  });

  it("truncates OLDEST entries when total payload exceeds 16 KB", async () => {
    // 200 large comments, each ~200 bytes — total > 16 KB.
    const longBody = "x".repeat(200);
    const comments = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      user: { login: `user-${i}` },
      body: longBody,
      created_at: new Date(2026, 4, 1 + Math.floor(i / 10)).toISOString(),
      path: `f${i}.ts`,
    }));
    const gh = new FakeGithub({ reviewComments: comments });
    const out = await fetchReviewComments(gh, { owner: "acme", repo: "api", pullNumber: 1 });
    const bytes = Buffer.byteLength(JSON.stringify(out), "utf8");
    expect(bytes).toBeLessThanOrEqual(MAX_REVIEW_COMMENTS_BYTES);
    expect(out.length).toBeLessThan(comments.length);
    // Most-recent IDs preserved (truncation drops oldest first).
    const ids = out.map((c) => c.id);
    expect(ids[ids.length - 1]).toBe(200);
  });

  it("returns [] (not throw) when the API call fails", async () => {
    const gh = new FakeGithub({ reviewCommentsThrow: true });
    const out = await fetchReviewComments(gh, { owner: "acme", repo: "api", pullNumber: 1 });
    expect(out).toEqual([]);
  });
});
