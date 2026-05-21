/**
 * PipelineStep wrapper for the human-PR-reviewer follow-up loop.
 *
 * The follow-up workflow proper lives in pr-followup-job.ts (a
 * separate worker that re-attaches to the same branch and runs another
 * agent pass). The DEFAULT_STEPS slot for "follow-up" exists for V2
 * synchronous loops where the main run waits for human review and
 * iterates inline.
 *
 * For now, this wrapper is a structural placeholder:
 *   - Always skipped when cfg.toggles.followUpLoop is false (every
 *     current preset, including custom unless explicitly turned on).
 *   - When enabled, writes a stub ctx.follow_up record indicating
 *     "follow-up enabled — awaiting human review" so the pipeline
 *     completes deterministically + downstream notifications see a
 *     shape they can describe.
 *
 * The full LLM-driven follow-up still routes through pr-followup-job
 * which P3c.3 will flip; this slot reserves the order in the canonical
 * step list.
 *
 * Reads:  ctx.pr, ctx.alert
 * Writes: ctx.follow_up
 */

import type { CtxStore, LlmStep, PipelineStep, PromptMessages } from "@alertforge/core";
import { wrapLlmStep } from "@alertforge/core";
import type { PrCtxValue } from "./open-pr";

export interface FollowUpInput {
  prNumber: number;
  prUrl: string;
  alertTitle: string;
}

export interface FollowUpOutput {
  /** When true the follow-up worker should pick up where this run leaves off. */
  enabled: true;
  prNumber: number;
  prUrl: string;
}

export async function selectFollowUpInput(ctx: CtxStore): Promise<FollowUpInput> {
  const pr = await ctx.read<PrCtxValue>("pr");
  const alert = await ctx.read<{ title: string }>("alert");
  return {
    prNumber: pr?.number ?? 0,
    prUrl: pr?.url ?? "",
    alertTitle: alert?.title ?? "",
  };
}

export function buildFollowUpPrompt(_input: FollowUpInput): PromptMessages {
  // V1 follow-up loop never calls the model from inside this step.
  // We still satisfy the LlmStep contract by returning a no-op prompt;
  // the model provider is invoked with an empty messages array which
  // the queued test provider treats as a default "{}" response. The
  // result is discarded by parseOutput below.
  return { messages: [] };
}

export function parseFollowUpOutput(_raw: string): FollowUpOutput {
  return { enabled: true, prNumber: 0, prUrl: "" };
}

export async function applyFollowUpToCtx(ctx: CtxStore, _out: FollowUpOutput): Promise<void> {
  const pr = await ctx.read<PrCtxValue>("pr");
  await ctx.write("follow_up", {
    enabled: true,
    prNumber: pr?.number ?? 0,
    prUrl: pr?.url ?? "",
    awaitingHuman: true,
  });
}

export function wrapFollowUpStep(): PipelineStep {
  const llmStep: LlmStep<FollowUpInput, FollowUpOutput> = {
    name: "follow-up",
    description: "Reserve slot for human-comment-driven follow-up loop",
    modelKey: "followUp",
    async skipIf(_ctx, cfg) {
      return !cfg.toggles.followUpLoop;
    },
    selectInput: selectFollowUpInput,
    buildPrompt: buildFollowUpPrompt,
    parseOutput: parseFollowUpOutput,
    applyToCtx: applyFollowUpToCtx,
  };
  return wrapLlmStep(llmStep);
}
