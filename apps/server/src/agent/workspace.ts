import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@sentry-fixer-bot/env/server";
import { resolveGithubToken } from "../github/auth";

export type Workspace = {
  dir: string;
  branch: string;
  cleanup: () => Promise<void>;
};

function cacheDirFor(repo: string): string {
  // /sfb/state/repos/<owner>__<name>.git — bare-ish working clone,
  // reused across runs. Per-run worktree branches off this.
  const base = `${process.env.SFB_STATE_DIR ?? "/sfb/state"}/repos`;
  return join(base, repo.replace("/", "__"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function spawn(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ exit: number; stderr: string }> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  return { exit, stderr };
}

/**
 * Create a per-run isolated workspace using a cached repo clone +
 * `git worktree`. First run for a repo clones to /sfb/state/repos/
 * <owner>__<name>; later runs `git fetch` + `worktree add` for a fresh
 * branch off the just-fetched base. The cache survives container
 * restarts.
 *
 * cleanup() removes the worktree but leaves the cached clone intact.
 */
export async function createWorkspace(input: {
  runId: string;
  repo: string;
  baseBranch: string;
}): Promise<Workspace> {
  const token = await resolveGithubToken();
  const cloneUrl = `https://x-access-token:${token}@github.com/${input.repo}.git`;
  const cache = cacheDirFor(input.repo);
  const branch = `sfb/${input.runId}`;
  const dir = join(env.WORK_DIR, input.runId);

  // First-time clone.
  if (!(await exists(cache))) {
    await mkdir(cache, { recursive: true });
    const res = await spawn(["git", "clone", "--filter=blob:none", cloneUrl, cache]);
    if (res.exit !== 0) {
      throw new Error(`git clone failed: ${res.stderr}`);
    }
  } else {
    // Fetch updates on subsequent runs. Update remote URL so token
    // rotates (gh tokens expire ~8h; cached URL would 401 next clone).
    await spawn(["git", "remote", "set-url", "origin", cloneUrl], { cwd: cache });
    const res = await spawn(["git", "fetch", "--prune", "origin"], { cwd: cache });
    if (res.exit !== 0) {
      throw new Error(`git fetch failed: ${res.stderr}`);
    }
  }

  // Create a worktree at WORK_DIR/<runId> branching off the freshly
  // fetched origin/<baseBranch>. `-B` resets the branch if it
  // somehow exists already.
  await mkdir(env.WORK_DIR, { recursive: true });
  const wt = await spawn(
    ["git", "worktree", "add", "-B", branch, dir, `origin/${input.baseBranch}`],
    { cwd: cache },
  );
  if (wt.exit !== 0) {
    throw new Error(`git worktree add failed: ${wt.stderr}`);
  }

  return {
    dir,
    branch,
    cleanup: async () => {
      // Remove worktree (keeps branch ref) then rm the dir. Branch
      // ref lingers in cache; harmless and lets us re-attach if the
      // operator wants to inspect later.
      await spawn(["git", "worktree", "remove", "--force", dir], { cwd: cache });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Re-attach a worktree to an EXISTING branch in the cached clone. Used
 * by the pr-followup worker: a human reviewer left a `/sfb` comment on
 * a PR the bot opened, and we need to apply more changes to the same
 * branch. The branch ref was preserved by `createWorkspace`'s cleanup
 * (worktree removed, branch kept).
 *
 * Fetches origin first so we pick up anything pushed to the branch
 * upstream since the original run.
 */
export async function attachWorkspace(input: {
  followupId: string;
  repo: string;
  branch: string;
}): Promise<Workspace> {
  const token = await resolveGithubToken();
  const cloneUrl = `https://x-access-token:${token}@github.com/${input.repo}.git`;
  const cache = cacheDirFor(input.repo);
  const dir = join(env.WORK_DIR, `followup-${input.followupId}`);

  if (!(await exists(cache))) {
    throw new Error(
      `repo cache missing for ${input.repo} — cannot follow up on a PR whose original clone is gone`,
    );
  }
  await spawn(["git", "remote", "set-url", "origin", cloneUrl], { cwd: cache });
  const fetch = await spawn(["git", "fetch", "--prune", "origin"], { cwd: cache });
  if (fetch.exit !== 0) {
    throw new Error(`git fetch failed: ${fetch.stderr}`);
  }
  await mkdir(env.WORK_DIR, { recursive: true });
  const wt = await spawn(["git", "worktree", "add", dir, input.branch], { cwd: cache });
  if (wt.exit !== 0) {
    throw new Error(`git worktree add (re-attach) failed: ${wt.stderr}`);
  }

  return {
    dir,
    branch: input.branch,
    cleanup: async () => {
      await spawn(["git", "worktree", "remove", "--force", dir], { cwd: cache });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
