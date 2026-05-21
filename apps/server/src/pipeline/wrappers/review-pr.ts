/**
 * PipelineStep wrapper around @alertforge/step-review-pr.
 *
 * Runs an adversarial second-pass claude review against the PR diff,
 * posts findings as a PR comment, and flips the PR to draft when the
 * verdict is "blocker". Writes the verdict + body to ctx.review.
 *
 * Skipped when cfg.toggles.autoReview = false (default for auto_fix
 * preset) — only auto_fix_review enables it.
 *
 * Reads:  ctx.workspace, ctx.pr, ctx.agent_output, ctx.alert,
 *         ctx.trigger (for model — uses cfg.models.review)
 * Writes: ctx.review
 *
 * Note: the underlying `runReviewer` itself spawns a claude agent +
 * uses its own diff-collection. The wrapper is injectable so the
 * integration test can return a canned verdict without spawning.
 */

import type {
  CtxStore,
  NormalizedAlert,
  PipelineStep,
  ResolvedConfig,
  StepDeps,
} from "@alertforge/core";
import type { AppendRunLog } from "@alertforge/step-fix-agent";
import type { AgentOutput } from "./fix-agent";
import type { PrCtxValue } from "./open-pr";
import type { WorkspaceCtxValue } from "./workspace";

export interface ReviewCtxValue {
  verdict: "blocker" | "nit" | "approve" | "unknown";
  body: string;
  exitCode: number;
  durationMs: number;
}

export type RunReviewerFn = (input: {
  cwd: string;
  repo: string;
  baseBranch: string;
  alertTitle: string;
  agentSummary: string;
  runId?: string;
  appendLog?: AppendRunLog;
}) => Promise<{
  verdict: "blocker" | "nit" | "approve" | "unknown";
  body: string;
  exitCode: number;
  durationMs: number;
}>;

export interface WrapReviewPrOpts {
  /** Override for tests. */
  runReviewerFn?: RunReviewerFn;
  /** Repo from AgentJob. */
  repo: string;
  /** Run id for stream-routing. */
  runId: string;
}

export async function runReviewPrStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapReviewPrOpts,
): Promise<void> {
  const workspace = await ctx.read<WorkspaceCtxValue>("workspace");
  const alert = await ctx.read<NormalizedAlert>("alert");
  const agentOutput = await ctx.read<AgentOutput>("agent_output");
  // PR may not exist yet on degenerate paths (no diff, secret-blocked).
  // Either way, review needs the workspace + the diff to assess.
  if (!workspace || !alert || !agentOutput) return;

  const runReviewer = opts.runReviewerFn ?? (await loadRunReviewerReal());
  // appendLog adapter: legacy reviewer wants the (runId, level, source,
  // message) shape on a single call. deps.appendLog drops runId since
  // it's curried in the deps factory, so we adapt back.
  const appendLogAdapter: AppendRunLog | undefined = deps.appendLog
    ? async (line) => {
        await deps.appendLog?.({
          level: line.level,
          source: line.source,
          message: line.message,
        });
      }
    : undefined;
  const reviewerInput: Parameters<RunReviewerFn>[0] = {
    cwd: workspace.dir,
    repo: opts.repo,
    baseBranch: workspace.baseBranch,
    alertTitle: alert.title,
    agentSummary: agentOutput.summary,
    runId: opts.runId,
  };
  if (appendLogAdapter) reviewerInput.appendLog = appendLogAdapter;
  const review = await runReviewer(reviewerInput);
  await ctx.write("review", review);
  // Surface the verdict on the timeline.
  await deps.appendLog?.({
    level: review.verdict === "blocker" ? "warn" : "info",
    source: "reviewer",
    message: `Review verdict=${review.verdict} (exit ${review.exitCode})`,
  });

  // If a blocker was found AND a PR exists, the consumer (worker)
  // flips the PR to draft + posts the review as a comment. The
  // wrapper does NOT do that itself — those are side-effects on
  // GitHub that belong outside the pure pipeline; they live in the
  // worker's onStepEnd hook in P3c.2. The ctx.review is the source
  // of truth.
  void agentOutput; // already captured above
}

export async function skipReviewPrIf(_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> {
  return !cfg.toggles.autoReview;
}

export function wrapReviewPrStep(opts: WrapReviewPrOpts): PipelineStep {
  return {
    name: "review-pr",
    description: "Adversarial second-pass code review of the agent's diff",
    skipIf: skipReviewPrIf,
    async run(ctx, cfg, deps) {
      await runReviewPrStep(ctx, cfg, deps, opts);
    },
  };
}

async function loadRunReviewerReal(): Promise<RunReviewerFn> {
  const m = await import("@alertforge/step-review-pr");
  return m.runReviewer;
}

// Helpful re-export so the test imports stay short.
export type { PrCtxValue };
