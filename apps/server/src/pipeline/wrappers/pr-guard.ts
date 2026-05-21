/**
 * PipelineStep wrapper that guards the followup pipeline against
 * acting on a PR that's already closed or merged.
 *
 * Background: a human reviewer may close (or someone may merge) the
 * PR between followup-job dispatch and pickup. Pushing more commits
 * to a closed/merged PR is invisible to the reviewer + wastes claude
 * tokens. Legacy `pr-followup-job.ts` performed this check inline
 * before re-attaching the worktree; in the pipeline driver the same
 * check becomes the FIRST followup-pipeline step.
 *
 * Design: the wrapper uses a mutable side-channel `PrGuardHandle`
 * (analogous to WorkspaceHandle / TestRecorder) so downstream steps
 * can consult `handle.terminated` in their `skipIf`. This is cleaner
 * than widening `ResolvedConfig.stopAfter` to accept a `"pr-guard"`
 * sentinel (which would require an alertforge-core type change) and
 * cleaner than walking ctx to find a marker (which would persist
 * forensic noise into the on-disk store).
 *
 * The watermark-advance + DB humanReviewState flip stay in the
 * worker's `finally` block — both are idempotency / boundary
 * concerns and shouldn't live inside a step.
 *
 * Reads:  ctx.pr (richer shape: {repo, number, branch, url, ...})
 * Writes: nothing on ctx; mutates the injected PrGuardHandle.
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";

/**
 * PR state the live GitHub API returns. Mirrors PrState in
 * apps/server/src/github/pr-ops.ts; declared here to keep the wrapper
 * free of an apps/server dependency at the type level.
 */
export type PrGuardState = "open" | "closed" | "merged" | "unknown";

/**
 * Injectable PR-state lookup. Production passes
 * `getPrState` from apps/server/src/github/pr-ops.ts; tests pass a
 * stub returning whatever state the scenario needs.
 */
export type GetPrStateFn = (input: { repo: string; prNumber: number }) => Promise<PrGuardState>;

/**
 * Mutable handle shared between wrapPrGuardStep and all downstream
 * followup wrappers' `skipIf` predicates. When pr-guard finds the PR
 * terminated, it sets `terminated=true` and downstream skipIfs return
 * true for the rest of the pipeline.
 *
 * Why a handle vs. ctx field: a ctx field would survive into the S3
 * archive and confuse forensic readers ("did the pipeline run or
 * not?"). A handle scoped to the request keeps the signal tight.
 */
export interface PrGuardHandle {
  terminated: boolean;
  state?: PrGuardState;
}

/**
 * Richer PR shape the followup worker writes into `ctx.pr` BEFORE
 * calling runPipeline. The primary worker's open-pr wrapper writes a
 * thinner shape (just {number, url, isDraft, needsHuman}); the
 * followup pipeline needs branch + repo to re-attach a worktree and
 * push commits.
 *
 * Cast at the read site rather than introducing a new CtxField — both
 * paths logically refer to "the same PR", just at different
 * lifecycle points. (See P3c.3 design notes for the rationale.)
 */
export interface FollowupPrCtxValue {
  repo: string;
  number: number;
  branch: string;
  url: string;
  isDraft: boolean;
  needsHuman: boolean;
}

export interface WrapPrGuardOpts {
  /** Side-channel filled in by the guard, read by downstream skipIfs. */
  handle: PrGuardHandle;
  /** Override for tests; production uses github/pr-ops getPrState. */
  getPrStateFn: GetPrStateFn;
}

export async function runPrGuardStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapPrGuardOpts,
): Promise<void> {
  const pr = await ctx.read<FollowupPrCtxValue>("pr");
  if (!pr) {
    // No PR target — there's nothing for the followup pipeline to act
    // on. Mark terminated so downstream steps skip; the worker will
    // already have logged the missing-PR case.
    opts.handle.terminated = true;
    return;
  }
  const state = await opts.getPrStateFn({ repo: pr.repo, prNumber: pr.number });
  opts.handle.state = state;
  if (state === "closed" || state === "merged") {
    opts.handle.terminated = true;
    await deps.appendLog?.({
      level: "warn",
      source: "pr-guard",
      message: `PR #${pr.number} is ${state} — no action taken; pipeline will halt.`,
    });
    return;
  }
  await deps.appendLog?.({
    level: "info",
    source: "pr-guard",
    message: `PR #${pr.number} state=${state}; proceeding with followup.`,
  });
}

/**
 * Shared skipIf factory that downstream followup-pipeline wrappers
 * import to short-circuit when the guard halted the run. Exported so
 * each follow-up wrapper can compose it with their own skip rules.
 */
export function skipIfPrGuardTerminated(handle: PrGuardHandle) {
  return async (_ctx: CtxStore, _cfg: ResolvedConfig): Promise<boolean> => handle.terminated;
}

export function wrapPrGuardStep(opts: WrapPrGuardOpts): PipelineStep {
  return {
    name: "pr-guard",
    description: "Check PR live-state; halt the followup pipeline if closed/merged",
    async run(ctx, cfg, deps) {
      await runPrGuardStep(ctx, cfg, deps, opts);
    },
  };
}
