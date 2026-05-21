/**
 * PipelineStep wrapper that posts the reply comment on the PR and
 * flips its draft/ready state based on the followup outcome.
 *
 * Decision table (matches legacy pr-followup-job.ts behaviour):
 *
 *   outcome.pushed=true        → markPrReady (if PR was draft);
 *                                 comment "applied per @reviewer".
 *   outcome.reason=no_diff      → no state flip; comment "no diff
 *                                 produced — try a more specific /sfb".
 *   outcome.reason=tests_failed → no state flip; comment surfacing
 *                                 the test failure tail.
 *   outcome.reason=secret_blocked → no state flip; comment surfacing
 *                                 the secret-scan finding.
 *   outcome.reason=agent_failed → no state flip; comment surfacing the
 *                                 non-zero agent exit code.
 *
 * Reads:  ctx.pr (FollowupPrCtxValue), ctx.instruction,
 *         ctx.test_result, ctx.secret_scan, ctx.agent_output
 *         + opts.outcomeHandle (set by commit-push-only)
 * Writes: nothing on ctx; calls deps-provided GitHub PR ops.
 *
 * The wrapper does NOT advance prs.lastReviewedCommentAt — that's a
 * worker `finally`-block concern (idempotency boundary, fired even
 * if the pipeline itself throws).
 */

import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "@alertforge/core";
import type { CommitPushOnlyHandle } from "./commit-push-only";
import type { AgentOutput } from "./fix-agent";
import type { InstructionCtxValue } from "./followup-fix-agent";
import { stripSfbPrefix } from "./followup-fix-agent";
import type { FollowupPrCtxValue, PrGuardHandle } from "./pr-guard";
import type { SecretScanCtxValue } from "./secret-scan";
import type { TestResultCtxValue } from "./test-gate";

export type CommentOnPrFn = (input: {
  repo: string;
  prNumber: number;
  body: string;
}) => Promise<string | null>;

export type MarkPrReadyFn = (input: { repo: string; prNumber: number }) => Promise<number>;
export type ConvertPrToDraftFn = (input: { repo: string; prNumber: number }) => Promise<number>;

export interface WrapPrFollowupCommentOpts {
  /** PR-guard handle so we skip when terminated. */
  prGuardHandle: PrGuardHandle;
  /** Outcome from commit-push-only — drives the reply branching. */
  outcomeHandle: CommitPushOnlyHandle;
  /** Production: pr-ops.commentOnPr; tests: capturing stub. */
  commentOnPrFn: CommentOnPrFn;
  /** Production: pr-ops.markPrReady; tests: capturing stub. */
  markPrReadyFn: MarkPrReadyFn;
  /** Production: pr-ops.convertPrToDraft; tests: capturing stub. */
  convertPrToDraftFn?: ConvertPrToDraftFn;
  /** Max attempts the agent was given; used for the test-failed reply. */
  maxAttempts?: number;
}

export async function runPrFollowupCommentStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
  opts: WrapPrFollowupCommentOpts,
): Promise<void> {
  const pr = await ctx.read<FollowupPrCtxValue>("pr");
  if (!pr) {
    await deps.appendLog?.({
      level: "warn",
      source: "pr-followup-comment",
      message: "ctx.pr missing — skipping comment.",
    });
    return;
  }
  const outcome = opts.outcomeHandle.outcome;
  const instruction = await ctx.read<InstructionCtxValue>("instruction");
  const instructionText = instruction ? stripSfbPrefix(instruction.body) : "";
  const reviewer = instruction?.author ?? "reviewer";

  // Successful push: mark ready + post applied comment.
  if (outcome?.pushed) {
    if (pr.isDraft) {
      const rc = await opts.markPrReadyFn({ repo: pr.repo, prNumber: pr.number });
      if (rc !== 0) {
        await deps.appendLog?.({
          level: "warn",
          source: "pr-followup-comment",
          message: `markPrReady returned ${rc}; PR may still be draft.`,
        });
      }
    }
    await opts.commentOnPrFn({
      repo: pr.repo,
      prNumber: pr.number,
      body: `✅ sentry-fixer-bot: applied \`${instructionText.slice(0, 160)}\` per @${reviewer}. New commit pushed; re-review or send another \`/sfb\` instruction.`,
    });
    await deps.appendLog?.({
      level: "info",
      source: "pr-followup-comment",
      message: `PR #${pr.number} ready + reply posted.`,
    });
    return;
  }

  // Failure paths — no state flip; surface the reason on the PR.
  const reason = outcome?.reason ?? "terminated";
  switch (reason) {
    case "tests_failed": {
      const test = await ctx.read<TestResultCtxValue>("test_result");
      const maxAttempts = opts.maxAttempts ?? 3;
      const cmd = test?.command ?? "tests";
      const stderrTail = test?.stderrTail ?? "";
      await opts.commentOnPrFn({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🛑 sentry-fixer-bot: ran your \`/sfb\` instruction and tried ${maxAttempts} attempts to make \`${cmd}\` pass, but tests are still failing. Not pushing. Tail of stderr:\n\n\`\`\`\n${stderrTail.slice(-1500)}\n\`\`\``,
      });
      break;
    }
    case "secret_blocked": {
      const ss = await ctx.read<SecretScanCtxValue>("secret_scan");
      await opts.commentOnPrFn({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🛑 sentry-fixer-bot: your \`/sfb\` instruction produced a diff that triggered ${ss?.findings.length ?? 0} secret-scan finding(s). No commit pushed — see /runs/<id> for details.`,
      });
      break;
    }
    case "agent_failed": {
      const agentOut = await ctx.read<AgentOutput & { exitCode?: number }>("agent_output");
      const exitCode = agentOut?.exitCode ?? -1;
      await opts.commentOnPrFn({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🤖 sentry-fixer-bot: tried to apply \`${instructionText.slice(0, 120)}\` but the agent exited ${exitCode}. Comment again with a refined \`/sfb\` instruction or push fixes manually.`,
      });
      break;
    }
    case "no_diff": {
      await opts.commentOnPrFn({
        repo: pr.repo,
        prNumber: pr.number,
        body: `🤖 sentry-fixer-bot: ran your \`/sfb\` instruction but the agent didn't produce any diff. Try a more specific instruction (e.g. \`/sfb add a null check in src/foo.ts before line 42\`).`,
      });
      break;
    }
    case "terminated": {
      // pr-guard halted; the worker's finally-block already
      // surfaced via run_log + watermark. Don't double-comment.
      break;
    }
  }
}

export function skipPrFollowupCommentIfFactory(handle: PrGuardHandle) {
  return async (_ctx: CtxStore, cfg: ResolvedConfig): Promise<boolean> => {
    if (cfg.stopAfter === "budget") return true;
    if (handle.terminated) return true;
    return false;
  };
}

export function wrapPrFollowupCommentStep(opts: WrapPrFollowupCommentOpts): PipelineStep {
  return {
    name: "pr-followup-comment",
    description: "Reply on the PR + flip draft/ready based on the followup outcome",
    skipIf: skipPrFollowupCommentIfFactory(opts.prGuardHandle),
    async run(ctx, cfg, deps) {
      await runPrFollowupCommentStep(ctx, cfg, deps, opts);
    },
  };
}
