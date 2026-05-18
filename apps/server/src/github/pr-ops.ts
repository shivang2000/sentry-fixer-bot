import { resolveGithubToken } from "./auth";

/**
 * Post a comment on a PR via `gh pr comment`. Returns the comment URL
 * on success. Tolerant on failure — review feedback is best-effort; we
 * never want a failed comment to break the agent run.
 */
export async function commentOnPr(input: {
  repo: string;
  prNumber: number;
  body: string;
}): Promise<string | null> {
  const token = await resolveGithubToken();
  const proc = Bun.spawn(
    ["gh", "pr", "comment", String(input.prNumber), "--repo", input.repo, "--body", input.body],
    { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exit !== 0) return null;
  return out.trim() || null;
}

/**
 * Flip a PR back to draft state via `gh pr ready --undo`. Used when the
 * reviewer pass returns a blocker verdict on an already-ready PR.
 *
 * `gh pr ready --undo` is supported as of gh 2.45 — operator's bootstrap
 * image pins gh ≥ 2.50, so this is safe. Returns exit code, no throw,
 * so the caller decides how to surface.
 */
export async function convertPrToDraft(input: { repo: string; prNumber: number }): Promise<number> {
  const token = await resolveGithubToken();
  const proc = Bun.spawn(
    ["gh", "pr", "ready", String(input.prNumber), "--repo", input.repo, "--undo"],
    { env: { ...process.env, GITHUB_TOKEN: token }, stdout: "pipe", stderr: "pipe" },
  );
  return proc.exited;
}

/**
 * Mark a draft PR as ready for review. Used when a follow-up loop
 * successfully addresses the reviewer's blockers — bot flips the PR
 * back to ready so humans see it again in their review queue.
 */
export async function markPrReady(input: { repo: string; prNumber: number }): Promise<number> {
  const token = await resolveGithubToken();
  const proc = Bun.spawn(["gh", "pr", "ready", String(input.prNumber), "--repo", input.repo], {
    env: { ...process.env, GITHUB_TOKEN: token },
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

export type PrComment = {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  url: string;
};

/**
 * Fetch comments on a PR via the GitHub API directly. We use the REST
 * `issues/{n}/comments` endpoint (PR comments live in the issues tree)
 * rather than `gh pr view --json comments`, which returns review
 * comments scoped to file lines — different shape and we want top-level
 * comments for the /sfb follow-up path.
 */
export async function listPrComments(input: {
  repo: string;
  prNumber: number;
  since?: Date;
}): Promise<PrComment[]> {
  const token = await resolveGithubToken();
  const url = new URL(
    `https://api.github.com/repos/${input.repo}/issues/${input.prNumber}/comments`,
  );
  url.searchParams.set("per_page", "100");
  if (input.since) {
    url.searchParams.set("since", input.since.toISOString());
  }
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const raw = (await res.json()) as Array<{
    id: number;
    body: string;
    user: { login: string };
    created_at: string;
    html_url: string;
  }>;
  return raw.map((c) => ({
    id: String(c.id),
    body: c.body,
    author: c.user.login,
    createdAt: c.created_at,
    url: c.html_url,
  }));
}
