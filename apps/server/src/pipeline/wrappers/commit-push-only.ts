/**
 * PipelineStep wrapper that commits + pushes to the PR's EXISTING
 * branch — does NOT call `gh pr create`.
 *
 * Design decision (P3c.3): inline the three git commands (status,
 * add, commit, push) here rather than extract a new
 * `@alertforge/step-commit-push` package. Rationale:
 *   - The legacy `commitAndPushIfChanged` in pr-followup-job.ts is
 *     ~30 LOC of git invocation; turning it into a package adds
 *     workspace plumbing (package.json, tsconfig, exports) for ~30
 *     LOC of glue. Net cost > net benefit at this stage.
 *   - The primary path's `wrapCommitPushStep` does something DIFFERENT
 *     (captures diff text into ctx.diff; the actual commit/push is
 *     bundled with `gh pr create` inside @alertforge/step-open-pr).
 *     Two wrappers with different responsibilities + shared name
 *     would be confusing; explicit `commit-push-only` signals intent.
 *   - The followup path's commit message matches the legacy
 *     `commitAndPushIfChanged` wording so PR timelines stay
 *     consistent for users.
 *
 * Skip rules:
 *   - PrGuardHandle.terminated.
 *   - ctx.workspace missing (attach-workspace was skipped).
 *   - ctx.agent_output.exitCode != 0 (claude bailed; no diff to push).
 *   - ctx.test_result.passed === false (tests failed; don't push
 *     broken code — legacy behaviour).
 *   - ctx.secret_scan.blocked = true (strict-mode finding; never
 *     ship credentials).
 *   - No dirty worktree (claude produced no diff for this
 *     instruction; legacy logs a `no diff` warning + replies on PR).
 *
 * Reads:  ctx.workspace, ctx.agent_output, ctx.test_result,
 *         ctx.secret_scan, ctx.instruction (author for commit msg)
 * Writes: ctx.diff (captured text), no ctx.pr update (the followup
 *         path's PR existed before runPipeline).
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";
import { type RunCommandFn, runCommand } from "../spawn";
import type { AgentOutput } from "./fix-agent";
import type { InstructionCtxValue } from "./followup-fix-agent";
import { stripSfbPrefix } from "./followup-fix-agent";
import type { PrGuardHandle } from "./pr-guard";
import type { SecretScanCtxValue } from "./secret-scan";
import type { TestResultCtxValue } from "./test-gate";
import type { WorkspaceCtxValue } from "./workspace";

/**
 * Outcome record the downstream pr-followup-comment step reads to
 * decide which reply body to post + whether to flip the PR to ready.
 *
 * Why not use ctx fields directly: the comment step needs a
 * collapsed decision ("was the push successful, or was it blocked
 * for X reason") and threading it through ctx as a richer flag is
 * cleaner than re-deriving the OR-of-skip-reasons in two places.
 */
export interface CommitPushOnlyOutcome {
  pushed: boolean;
  reason?: "no_diff" | "tests_failed" | "secret_blocked" | "agent_failed" | "terminated";
}

export interface CommitPushOnlyHandle {
  outcome?: CommitPushOnlyOutcome;
}

export interface WrapCommitPushOnlyOpts {
  /** Override for tests. */
  runScriptedCommand?: RunCommandFn;
  /** PR-guard handle so we skip when terminated. */
  prGuardHandle: PrGuardHandle;
  /** Mutable handle the comment step reads to compose the PR reply. */
  outcomeHandle: CommitPushOnlyHandle;
}

export async function runCommitPushOnlyStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapCommitPushOnlyOpts,
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  if (!workspace) {
    opts.outcomeHandle.outcome = { pushed: false, reason: "terminated" };
    return;
  }
  const agentOutput = await ctx.read<AgentOutput & { exitCode?: number }>("agent_output");
  if (agentOutput && (agentOutput as { exitCode?: number }).exitCode !== 0) {
    opts.outcomeHandle.outcome = { pushed: false, reason: "agent_failed" };
    return;
  }
  const secretScan = await ctx.read<SecretScanCtxValue>("secret_scan");
  if (secretScan?.blocked) {
    await deps.appendLog?.({
      level: "error",
      source: "commit-push-only",
      message: `Secret scan blocked push: ${secretScan.findings.length} finding(s).`,
    });
    opts.outcomeHandle.outcome = { pushed: false, reason: "secret_blocked" };
    return;
  }
  const testResult = await ctx.read<TestResultCtxValue>("test_result");
  if (testResult && testResult.passed === false) {
    await deps.appendLog?.({
      level: "warn",
      source: "commit-push-only",
      message: "Tests failed; not pushing.",
    });
    opts.outcomeHandle.outcome = { pushed: false, reason: "tests_failed" };
    return;
  }

  const cmdFn = opts.runScriptedCommand ?? runCommand;
  const resolveToken = deps.resolveToken;
  if (!resolveToken) {
    throw new Error("commit-push-only: deps.resolveToken missing");
  }

  // Check for a dirty worktree first; matches legacy
  // `commitAndPushIfChanged`. A clean tree means claude produced no
  // diff for this instruction — legacy logs a warning + asks the
  // user to refine; we delegate that surfacing to the comment step.
  const status = await cmdFn(["git", "status", "--porcelain"], { cwd: workspace.dir });
  if (!status.stdout.trim()) {
    opts.outcomeHandle.outcome = { pushed: false, reason: "no_diff" };
    await deps.appendLog?.({
      level: "warn",
      source: "commit-push-only",
      message: "Claude produced no diff for this instruction.",
    });
    return;
  }

  // Capture the diff for forensic + S3 archive (mirrors primary
  // path's commit-push wrapper writing ctx.diff).
  const diffOut = await cmdFn(["git", "diff", "HEAD"], { cwd: workspace.dir });
  if (diffOut.stdout) {
    await ctx.write("diff", diffOut.stdout);
  }

  const instruction = await ctx.read<InstructionCtxValue>("instruction");
  const reviewerHandle = instruction?.author ?? "reviewer";
  const instrText = instruction ? stripSfbPrefix(instruction.body) : "(empty)";
  const commitMsg = `sfb followup: ${instrText.slice(0, 80)}\n\nApplied per @${reviewerHandle}.`;

  await cmdFn(["git", "add", "-A"], { cwd: workspace.dir });
  // Legacy parity: commit identity matches what's in
  // pr-followup-job.ts so timeline authors stay consistent.
  await cmdFn(
    [
      "git",
      "-c",
      "user.email=sentry-fixer-bot@users.noreply.github.com",
      "-c",
      "user.name=sentry-fixer-bot",
      "commit",
      "-m",
      commitMsg,
    ],
    { cwd: workspace.dir },
  );
  const token = await resolveToken();
  await cmdFn(["git", "push", "origin", workspace.branch], {
    cwd: workspace.dir,
    env: { GITHUB_TOKEN: token },
  });

  opts.outcomeHandle.outcome = { pushed: true };
  await deps.appendLog?.({
    level: "info",
    source: "commit-push-only",
    message: `Pushed new commit to ${workspace.branch}.`,
  });
}

export function skipCommitPushOnlyIfFactory(handle: PrGuardHandle) {
  return async (ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> => {
    if (cfg.stopAfter === "budget") return true;
    if (handle.terminated) return true;
    if (!(await ctx.exists("workspace"))) return true;
    return false;
  };
}

export function wrapCommitPushOnlyStep(opts: WrapCommitPushOnlyOpts): PipelineStep {
  return {
    name: "commit-push-only",
    description: "Commit + push to the PR's existing branch (no gh pr create)",
    skipIf: skipCommitPushOnlyIfFactory(opts.prGuardHandle),
    async run(ctx, cfg, deps) {
      await runCommitPushOnlyStep(ctx, cfg, deps, opts);
    },
  };
}
