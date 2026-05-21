/**
 * PipelineStep wrapper that captures the workspace diff before open-pr
 * commits it.
 *
 * Design decision (background-agent take per P3c plan):
 *   We kept @alertforge/step-open-pr bundled (commit + push + gh pr
 *   create stays in a single transaction). Splitting commit-push out
 *   into its own package would require coordinating intermediate
 *   ctx.workspace.pushedSha state across two steps that share cwd +
 *   branch + token — net cost > net benefit for V1. Plan-level
 *   guidance was explicit: "Let the background agent decide based on
 *   what's clean."
 *
 *   What commit-push DOES still own in this split: it captures the
 *   diff into ctx.diff so:
 *     - Downstream review-pr / fan-out / S3 archive can read the diff
 *       without re-shelling out to git.
 *     - The PR body renderer can render a "files changed" footer.
 *   commit-push does NOT actually run `git commit` / `git push` — that
 *   happens inside open-pr's bundled flow.
 *
 *   Trade-off accepted: if open-pr's commit-push half fails after this
 *   step's diff-capture succeeded, ctx.diff is a snapshot of work
 *   that was never persisted to origin. Operator inspecting the run
 *   sees the would-have-been diff, which is informative rather than
 *   misleading. Worst case: re-trigger the run.
 *
 * Skipped when cfg.stopAfter='budget' or when there's no workspace.
 *
 * Reads:  ctx.workspace, ctx.agent_output (skip when agent exit != 0)
 * Writes: ctx.diff (raw text, capped by CtxStore)
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";
import { type RunCommandFn, runCommand } from "../spawn";
import type { WorkspaceCtxValue } from "./workspace";

export interface WrapCommitPushOpts {
  /** Override for tests. */
  runScriptedCommand?: RunCommandFn;
}

export async function runCommitPushStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  _deps: StepDeps,
  opts: WrapCommitPushOpts = {},
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) return;
  const agentOutput = await ctx.read<{ exitCode: number }>("agent_output");
  if (agentOutput && agentOutput.exitCode !== 0) {
    // Agent bailed mid-flight; no useful diff to capture.
    return;
  }
  const cmdFn = opts.runScriptedCommand ?? runCommand;
  const diff = await cmdFn(["git", "diff", `origin/${workspace.baseBranch}...HEAD`], {
    cwd: workspace.dir,
  });
  // git diff sometimes returns empty pre-commit (no staged commits); fall
  // back to worktree-vs-HEAD diff so we still capture the staged-but-
  // uncommitted changes the agent made.
  const text = diff.stdout || (await cmdFn(["git", "diff", "HEAD"], { cwd: workspace.dir })).stdout;
  await ctx.write("diff", text);
}

export async function skipCommitPushIf(ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  if (cfg.stopAfter === "budget") return true;
  // Skip when the workspace is missing (i.e. workspace was skipped).
  return !(await ctx.exists("workspace"));
}

export function wrapCommitPushStep(opts: WrapCommitPushOpts = {}): PipelineStep {
  return {
    name: "commit-push",
    description: "Capture the agent's diff (commit + push happens in open-pr)",
    skipIf: skipCommitPushIf,
    async run(ctx, cfg, deps) {
      await runCommitPushStep(ctx, cfg, deps, opts);
    },
  };
}
