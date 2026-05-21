/**
 * PipelineStep wrapper around @alertforge/step-budget.
 *
 * Reads today's usage row + the repo's caps from the DB, decides
 * whether to proceed, and writes the result to ctx.budget. When the
 * budget is exhausted, the wrapper sets `cfg.stopAfter = "budget"` so
 * runPipeline short-circuits to fan-out-channels without spinning a
 * workspace or running the agent (mirrors legacy behavior in
 * apps/server/src/worker/agent-job.ts).
 *
 * The legacy `checkRepoBudget` reads `repos_config` to find the caps;
 * here we accept either the legacy DB-driven function via factory
 * arg or fall back to the cfg.budget numbers (matches the resolved
 * trigger config). The wrapper prefers the legacy path in production
 * (so repos_config stays the source of truth during the 2.0.x window)
 * and the cfg path in tests.
 *
 * Reads:  ctx.trigger (for repo + budget caps; falls back to cfg)
 * Writes: ctx.budget; sets cfg.stopAfter='budget' on deny.
 */

import type {
  CtxStore,
  PipelineStep,
  ResolvedConfig,
  StepDeps,
  TriggerRow,
} from "@alertforge/core";
import { decideBudget } from "@alertforge/step-budget";

export interface BudgetCtxValue {
  allowed: boolean;
  reason?: "tokens_exceeded" | "cost_exceeded";
}

export type CheckBudgetFn = (input: {
  repo: string;
  cfg: ResolvedConfig;
}) => Promise<BudgetCtxValue>;

export type RecordUsageFn = (input: {
  repo: string;
  tokens: number;
  costCents: number;
}) => Promise<void>;

export interface WrapBudgetOpts {
  checkBudgetFn?: CheckBudgetFn;
  recordUsageFn?: RecordUsageFn;
  /** Repo string; threaded through from the AgentJob payload in production. */
  repo: string;
}

const DEFAULT_CHECK: CheckBudgetFn = async ({ cfg }) => {
  // In-cfg fallback. Without a DB query we use the daily caps from the
  // resolved config as the budget and assume zero usage today (no
  // backing store). Production swaps in the DB-driven implementation
  // via the factory option.
  return decideBudget({
    usedTokens: 0,
    usedCostCents: 0,
    capTokens: cfg.budget.dailyTokens,
    capCostCents: cfg.budget.dailyCostCents,
  });
};

export async function runBudgetStep(
  ctx: CtxStore,
  cfg: ResolvedConfig,
  _deps: StepDeps,
  opts: WrapBudgetOpts,
): Promise<void> {
  const checkBudget = opts.checkBudgetFn ?? DEFAULT_CHECK;
  // Look up the repo. Tests stamp it in via the factory option.
  const trigger = await ctx.read<TriggerRow>("trigger");
  const repo = opts.repo || trigger?.repoId || "";
  const decision = await checkBudget({ repo, cfg });
  await ctx.write("budget", decision);
  if (!decision.allowed) {
    // Mutate cfg.stopAfter so runPipeline short-circuits to
    // fan-out-channels. This is the documented protocol (see
    // ResolvedConfig.stopAfter in @alertforge/core/types).
    cfg.stopAfter = "budget";
  }
}

export function wrapBudgetStep(opts: WrapBudgetOpts): PipelineStep {
  return {
    name: "budget",
    description: "Daily token+cost cap enforcement",
    async run(ctx, cfg, deps) {
      await runBudgetStep(ctx, cfg, deps, opts);
    },
  };
}
