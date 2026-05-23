/**
 * Fetch reviewer comments for a PR and trim them to fit the 16 KB cap.
 *
 * Cap exists because `prs.review_comments_jsonb` is a single jsonb
 * column we ingest only as evidence for V2 reviewer-style modeling —
 * we don't want a runaway 10 MB review thread to blow up the row.
 *
 * Truncation drops OLDEST entries first (most-recent feedback is the
 * highest-signal). Returns [] (not throw) on API failure so the
 * caller can still record the closed_unmerged outcome.
 */

import type { GithubClient } from "./poll-open-prs";

/** 16 KB total payload cap per the plan. */
export const MAX_REVIEW_COMMENTS_BYTES = 16 * 1024;

export interface ReviewCommentRecord {
  id: number;
  userLogin: string;
  body: string;
  createdAt: string;
  path?: string;
}

function recordBytes(record: ReviewCommentRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8");
}

function totalBytes(list: ReviewCommentRecord[]): number {
  return Buffer.byteLength(JSON.stringify(list), "utf8");
}

export async function fetchReviewComments(
  github: GithubClient,
  input: { owner: string; repo: string; pullNumber: number },
): Promise<ReviewCommentRecord[]> {
  let raw: Awaited<ReturnType<GithubClient["listReviewComments"]>>;
  try {
    raw = await github.listReviewComments(input);
  } catch {
    return [];
  }

  const sorted = [...raw].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const mapped: ReviewCommentRecord[] = sorted.map((c) => {
    const rec: ReviewCommentRecord = {
      id: c.id,
      userLogin: c.user.login,
      body: c.body,
      createdAt: c.created_at,
    };
    if (c.path !== undefined) rec.path = c.path;
    return rec;
  });

  if (totalBytes(mapped) <= MAX_REVIEW_COMMENTS_BYTES) {
    return mapped;
  }

  // Trim oldest first (sorted ascending). Drop one at a time so we keep
  // as many recent comments as the cap allows.
  let kept = mapped.slice();
  while (kept.length > 0 && totalBytes(kept) > MAX_REVIEW_COMMENTS_BYTES) {
    kept.shift();
  }
  // Edge case: a single comment is itself > 16 KB. Truncate its body so
  // we still record the reviewer identity + a preview.
  if (kept.length === 0 && mapped.length > 0) {
    const last = mapped[mapped.length - 1]!;
    const headerBytes = recordBytes({ ...last, body: "" });
    const remaining = MAX_REVIEW_COMMENTS_BYTES - headerBytes - 16;
    const truncatedBody =
      remaining > 0 ? `${last.body.slice(0, Math.max(0, remaining))}…[truncated]` : "[truncated]";
    kept = [{ ...last, body: truncatedBody }];
  }
  return kept;
}
