/**
 * PipelineStep wrapper around @alertforge/step-workspace's
 * `attachWorkspace` function for the followup pipeline.
 *
 * The primary pipeline uses `createWorkspace` (fresh worktree off
 * origin/<baseBranch>); the followup pipeline uses `attachWorkspace`
 * (re-attach to the PR's EXISTING branch in the cached clone).
 *
 * Skipped when:
 *   - cfg.stopAfter='budget' (defensive — followup path doesn't
 *     normally trip the budget step, but the wrapper plays well with
 *     the shared pipeline runner).
 *   - PrGuardHandle.terminated (PR is closed/merged; nothing to do).
 *
 * Reads:  ctx.pr (FollowupPrCtxValue shape — branch + repo)
 * Writes: ctx.workspace (dir, branch, baseBranch="")
 */

import type {
  CtxStore,
  PipelineStep,
  ResolvedConfig,
  ResolveToken,
  StepDeps,
} from "@alertforge/core";
import { attachWorkspace } from "@alertforge/step-workspace";
import type { FollowupPrCtxValue, PrGuardHandle } from "./pr-guard";
import type { WorkspaceCtxValue, WorkspaceHandle } from "./workspace";

export type AttachWorkspaceFn = (input: {
  followupId: string;
  repo: string;
  branch: string;
  resolveToken: ResolveToken;
}) => Promise<{ dir: string; branch: string; cleanup: () => Promise<void> }>;

export interface WrapAttachWorkspaceOpts {
  /** Override for tests; production uses attachWorkspace from step-workspace. */
  attachWorkspaceFn?: AttachWorkspaceFn;
  /** The PR's followup id (typically the comment id, per legacy parity). */
  followupId: string;
  /** owner/name repo string — comes from the worker's pr row. */
  repo: string;
  /** Branch name — comes from the worker's pr row (sfb/<originalRunId>). */
  branch: string;
  /** PR-guard handle so we skip when terminated. */
  prGuardHandle: PrGuardHandle;
}

export async function runAttachWorkspaceStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapAttachWorkspaceOpts,
  handle: WorkspaceHandle,
): Promise<void> {
  const fn = opts.attachWorkspaceFn ?? attachWorkspace;
  const resolveToken = deps.resolveToken;
  if (!resolveToken) {
    throw new Error("attach-workspace step requires deps.resolveToken");
  }

  // Prefer ctx.pr (richer followup shape) over opts when both exist —
  // worker stamps the canonical PR target into ctx so the wrapper
  // stays test-driveable without re-threading every prop.
  const prTarget = await ctx.read<FollowupPrCtxValue>("pr");
  const repo = prTarget?.repo ?? opts.repo;
  const branch = prTarget?.branch ?? opts.branch;

  await deps.appendLog?.({
    level: "info",
    source: "attach-workspace",
    message: `Re-attaching worktree to ${repo}:${branch}…`,
  });
  const ws = await fn({
    followupId: opts.followupId,
    repo,
    branch,
    resolveToken,
  });
  handle.cleanup = ws.cleanup;
  const value: WorkspaceCtxValue = {
    dir: ws.dir,
    branch: ws.branch,
    // The followup path doesn't have a "base branch" in the
    // origin/<branch> sense — it pushes to the PR's branch directly.
    // commit-push-only consumes `branch`, not baseBranch, so the
    // empty-string is benign.
    baseBranch: "",
  };
  await ctx.write("workspace", value);
  await deps.appendLog?.({
    level: "info",
    source: "attach-workspace",
    message: `Worktree attached at ${ws.dir} (branch ${ws.branch}).`,
  });
}

export function skipAttachWorkspaceIfFactory(handle: PrGuardHandle) {
  return async (_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> => {
    if (cfg.stopAfter === "budget") return true;
    if (handle.terminated) return true;
    return false;
  };
}

export function wrapAttachWorkspaceStep(
  opts: WrapAttachWorkspaceOpts,
  handle: WorkspaceHandle = {},
): PipelineStep {
  return {
    name: "attach-workspace",
    description: "Re-attach a worktree to the PR's existing branch",
    skipIf: skipAttachWorkspaceIfFactory(opts.prGuardHandle),
    async run(ctx, cfg, deps) {
      await runAttachWorkspaceStep(ctx, cfg, deps, opts, handle);
    },
  };
}
