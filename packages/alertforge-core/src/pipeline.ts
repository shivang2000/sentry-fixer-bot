import type { CtxStore, PipelineStep, ResolvedConfig, StepDeps } from "./types";

export interface PipelineHooks {
  onStepStart?(stepName: string): Promise<void> | void;
  onStepEnd?(stepName: string, durationMs: number): Promise<void> | void;
  onStepSkip?(stepName: string): Promise<void> | void;
  onStepError?(stepName: string, err: unknown): Promise<void> | void;
}

/**
 * Iterate steps in order. For each step:
 *   1. Call skipIf — if true, record skip and continue.
 *   2. Run the step against (ctx, cfg, deps).
 *   3. If cfg.stopAfter matches the step.name (e.g. "budget" for
 *      triage_only preset), short-circuit to the fan-out-channels step
 *      and return.
 *   4. Propagate errors after invoking onStepError.
 *
 * The runner does not persist ctx itself — steps manage their own
 * ctx writes via the CtxStore interface. The runner is responsible
 * for ordering and lifecycle hooks only.
 */
export async function runPipeline(
  ctx: CtxStore,
  cfg: ResolvedConfig,
  steps: PipelineStep[],
  deps: StepDeps,
  hooks: PipelineHooks = {},
): Promise<void> {
  for (const step of steps) {
    if (step.skipIf && (await step.skipIf(ctx, cfg))) {
      await hooks.onStepSkip?.(step.name);
      continue;
    }

    await hooks.onStepStart?.(step.name);
    const t0 = Date.now();
    try {
      await step.run(ctx, cfg, deps);
    } catch (err) {
      await hooks.onStepError?.(step.name, err);
      throw err;
    }
    await hooks.onStepEnd?.(step.name, Date.now() - t0);

    if (cfg.stopAfter && step.name === cfg.stopAfter) {
      const fanOut = steps.find((s) => s.name === "fan-out-channels");
      if (fanOut) {
        if (fanOut.skipIf && (await fanOut.skipIf(ctx, cfg))) return;
        await hooks.onStepStart?.(fanOut.name);
        const t1 = Date.now();
        try {
          await fanOut.run(ctx, cfg, deps);
        } catch (err) {
          await hooks.onStepError?.(fanOut.name, err);
          throw err;
        }
        await hooks.onStepEnd?.(fanOut.name, Date.now() - t1);
      }
      return;
    }
  }
}
