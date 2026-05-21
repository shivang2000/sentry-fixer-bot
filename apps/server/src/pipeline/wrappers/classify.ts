/**
 * PipelineStep wrapper around @alertforge/step-classify.
 *
 * The legacy `classify()` function calls the headless `claude` CLI to
 * triage an alert; the wrapper instead routes through the pipeline's
 * injectable `ModelProvider` (deps.modelProvider) so the integration
 * test can return canned responses without spawning a subprocess. Real
 * production swaps in an Anthropic-SDK provider via the deps-factory.
 *
 * Per the LlmStep contract:
 *   - selectInput projects ONLY the fields the prompt needs from ctx
 *     (alert title + stack trace from event_detail).
 *   - buildPrompt receives the projected TInput and never sees CtxStore.
 *   - parseOutput reuses the existing tested `parseTriageJson`.
 *   - applyToCtx writes the triage result to ctx.triage.
 */

import type {
  CtxStore,
  LlmStep,
  NormalizedAlert,
  PipelineStep,
  PromptMessages,
} from "@alertforge/core";
import { wrapLlmStep } from "@alertforge/core";
import { parseTriageJson, type TriageResult } from "@alertforge/step-classify";

export interface ClassifyInput {
  alertTitle: string;
  stackTrace: string;
}

const SYSTEM_PROMPT =
  'You triage production exception alerts. For each alert you receive, classify severity (low | medium | high | critical) and identify suspected file paths from the stack trace. Respond as JSON only: {"severity":"...","summary":"...","suspectedFiles":["path/to/file.ts"]}.';

export function buildClassifyPrompt(input: ClassifyInput): PromptMessages {
  return {
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `TITLE:\n${input.alertTitle}\n\nSTACK:\n${input.stackTrace}`,
      },
    ],
  };
}

export async function selectClassifyInput(ctx: CtxStore): Promise<ClassifyInput> {
  const alert = await ctx.read<NormalizedAlert>("alert");
  // event_detail may carry an enriched payload with stackTrace; if
  // missing, we still classify on title alone.
  const detail = await ctx.read<NormalizedAlert & { stackTrace?: string }>("event_detail");
  return {
    alertTitle: alert?.title ?? "(no title)",
    stackTrace: detail?.stackTrace ?? "",
  };
}

export async function applyClassifyToCtx(ctx: CtxStore, out: TriageResult): Promise<void> {
  await ctx.write("triage", out);
}

export function wrapClassifyStep(): PipelineStep {
  const llmStep: LlmStep<ClassifyInput, TriageResult> = {
    name: "classify",
    description: "LLM triage: severity + suspectedFiles + summary",
    modelKey: "classify",
    selectInput: selectClassifyInput,
    buildPrompt: buildClassifyPrompt,
    parseOutput: parseTriageJson,
    applyToCtx: applyClassifyToCtx,
  };
  return wrapLlmStep(llmStep);
}
