import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { env } from "@sentry-fixer-bot/env/server";
import { getInstallationToken } from "../github/app-auth";

export type Workspace = {
  dir: string;
  branch: string;
  cleanup: () => Promise<void>;
};

/**
 * Create a per-run isolated git workspace.
 * - Clones <repo> at <baseBranch> into /<WORK_DIR>/<runId>/
 * - Creates a new branch sfb/<runId>
 * Caller must call cleanup() in a finally block.
 */
export async function createWorkspace(input: {
  runId: string;
  repo: string; // "owner/name"
  baseBranch: string;
}): Promise<Workspace> {
  const dir = join(env.WORK_DIR, input.runId);
  await mkdir(dir, { recursive: true });

  const token = await getInstallationToken();
  const cloneUrl = `https://x-access-token:${token}@github.com/${input.repo}.git`;
  const branch = `sfb/${input.runId}`;

  const clone = Bun.spawn(
    ["git", "clone", "--depth", "1", "--branch", input.baseBranch, cloneUrl, dir],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if ((await clone.exited) !== 0) {
    const err = await new Response(clone.stderr).text();
    throw new Error(`git clone failed: ${err}`);
  }

  const checkout = Bun.spawn(["git", "checkout", "-b", branch], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await checkout.exited) !== 0) {
    const err = await new Response(checkout.stderr).text();
    throw new Error(`git checkout failed: ${err}`);
  }

  return {
    dir,
    branch,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
