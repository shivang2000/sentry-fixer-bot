/**
 * PipelineStep wrapper around the source adapter's `fetchEventDetail`
 * call. Look up the adapter by `alert.sourceType` from `deps.sources`
 * (populated by the @alertforge/core registry) and invoke its enriched
 * fetch — typically Sentry's getLatestEvent + extractStackTrace.
 *
 * Skipped when the adapter declines to expose fetchEventDetail (some
 * future adapters may have nothing to enrich beyond the webhook
 * payload).
 *
 * Reads:  ctx.alert
 * Writes: ctx.event_detail (the enriched alert with stackTrace)
 */

import type {
  CtxStore,
  EnrichedAlert,
  NormalizedAlert,
  PipelineStep,
  ResolvedConfig,
  StepDeps,
} from "@alertforge/core";

export async function runFetchEventStep(
  ctx: CtxStore,
  _cfg: ResolvedConfig,
  deps: StepDeps,
): Promise<void> {
  const alert = await ctx.read<NormalizedAlert>("alert");
  if (!alert) return;
  const adapter = deps.sources.get(alert.sourceType);
  if (!adapter?.fetchEventDetail) return;
  let enriched: EnrichedAlert;
  try {
    enriched = await adapter.fetchEventDetail(alert, {
      log: deps.log,
    });
  } catch (err) {
    // Source enrichment is best-effort. If Sentry's API hiccups we
    // record an empty enrichment so downstream steps still see an
    // event_detail field and can fall back to the title-only alert.
    await deps.appendLog?.({
      level: "warn",
      source: "fetch-event",
      message: `source.fetchEventDetail failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    enriched = alert;
  }
  await ctx.write("event_detail", enriched);
}

export async function skipFetchEventIf(ctx: CtxStore, _cfg: ResolvedConfig): Promise<boolean> {
  // If no alert yet, nothing to enrich. Defensive: in practice the
  // worker always writes `alert` before invoking runPipeline.
  return !(await ctx.exists("alert"));
}

export function wrapFetchEventStep(): PipelineStep {
  return {
    name: "fetch-event",
    description: "Source adapter enrichment (stack trace + breadcrumbs)",
    skipIf: skipFetchEventIf,
    run: runFetchEventStep,
  };
}
