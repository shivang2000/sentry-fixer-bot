/**
 * PipelineStep wrapper around @alertforge/step-workspace.
 *
 * Creates a per-run isolated git worktree by delegating to the legacy
 * `createWorkspace` function. The wrapper records the workspace dir +
 * branch into ctx.workspace so downstream steps (fix-agent, test-gate,
 * commit-push, open-pr) can read it back without re-discovering.
 *
 * The actual cleanup of the worktree is the caller's responsibility
 * (see processAgentJob's finally block in P3c.2). Wrapper does NOT
 * cleanup because the cfg.stopAfter='budget' path can short-circuit
 * past workspace via skipIf — there's no workspace to clean up in
 * that branch.
 *
 * Skipped when cfg.stopAfter='budget' (triage_only preset) — see
 * spec ctx field allocation table.
 *
 * Reads:  ctx.trigger (for repo + baseBranch — falls back to opts)
 * Writes: ctx.workspace (dir, branch)
 */

import type {
  CtxStore,
  PipelineStep,
  ResolvedConfig,
  ResolveToken,
  StepDeps,
} from "@alertforge/core";
import { createWorkspace } from "@alertforge/step-workspace";

export interface WorkspaceCtxValue {
  dir: string;
  branch: string;
  /** Persisted across the pipeline; the cleanup closure isn't serialised. */
  baseBranch: string;
}

export type CreateWorkspaceFn = (input: {
  runId: string;
  repo: string;
  baseBranch: string;
  resolveToken: ResolveToken;
}) => Promise<{ dir: string; branch: string; cleanup: () => Promise<void> }>;

export interface WrapWorkspaceOpts {
  /** Override for tests; production uses the real legacy fn. */
  createWorkspaceFn?: CreateWorkspaceFn;
  /** runId comes from the AgentJob payload; deps-factory threads it through. */
  runId: string;
  /** owner/name repo string from the AgentJob. */
  repo: string;
  /** baseBranch from repos_config; deps-factory looks it up at the worker boundary. */
  baseBranch: string;
}

/**
 * Mutable handle the worker keeps so the finally-block in processAgentJob
 * can call cleanup() after the run ends. The wrapper writes only the
 * serialisable shape to ctx; the live handle is exposed back through
 * this side-channel object that the deps-factory hands the wrapper.
 */
export interface WorkspaceHandle {
  cleanup?: () => Promise<void>;
}

export async function runWorkspaceStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapWorkspaceOpts,
  handle: WorkspaceHandle,
): Promise<void> {
  const fn = opts.createWorkspaceFn ?? createWorkspace;
  const resolveToken = deps.resolveToken;
  if (!resolveToken) {
    throw new Error("workspace step requires deps.resolveToken");
  }
  await deps.appendLog?.({
    level: "info",
    source: "workspace",
    message: `Cloning ${opts.repo}@${opts.baseBranch} into work dir…`,
  });
  const ws = await fn({
    runId: opts.runId,
    repo: opts.repo,
    baseBranch: opts.baseBranch,
    resolveToken,
  });
  handle.cleanup = ws.cleanup;
  const value: WorkspaceCtxValue = {
    dir: ws.dir,
    branch: ws.branch,
    baseBranch: opts.baseBranch,
  };
  await ctx.write("workspace", value);
  await deps.appendLog?.({
    level: "info",
    source: "workspace",
    message: `Workspace ready: ${ws.dir} (branch ${ws.branch})`,
  });
}

export async function skipWorkspaceIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  // triage_only preset: budget step is the terminal in-pipe step before
  // fan-out, so workspace is wasted compute.
  return cfg.stopAfter === "budget";
}

export function wrapWorkspaceStep(
  opts: WrapWorkspaceOpts,
  handle: WorkspaceHandle = {},
): PipelineStep {
  return {
    name: "workspace",
    description: "Create per-run git worktree",
    skipIf: skipWorkspaceIf,
    async run(ctx, cfg, deps) {
      await runWorkspaceStep(ctx, cfg, deps, opts, handle);
    },
  };
}
