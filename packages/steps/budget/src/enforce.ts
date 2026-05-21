import { createDb } from "@sentry-fixer-bot/db";
import { reposConfig } from "@sentry-fixer-bot/db/schema/admin";
import { budgets } from "@sentry-fixer-bot/db/schema/domain";
import { and, eq, sql } from "drizzle-orm";
import { type BudgetCheck, decideBudget } from "./decide";

export type { BudgetCheck };
export { decideBudget };

function today(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Read caps from repos_config, read today's budget row, decide. */
export async function checkRepoBudget(repo: string): Promise<BudgetCheck> {
  const db = createDb();
  const cfgRows = await db.select().from(reposConfig).where(eq(reposConfig.github, repo)).limit(1);
  const cfg = cfgRows[0];
  if (!cfg) return { allowed: true }; // unknown repo: caller handles routing

  const date = today();
  const budgetRows = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.repo, repo), eq(budgets.date, date)))
    .limit(1);
  const used = budgetRows[0];

  return decideBudget({
    usedTokens: used?.tokensUsed ?? 0,
    usedCostCents: used?.costCents ?? 0,
    capTokens: cfg.dailyTokenCap,
    capCostCents: cfg.dailyCostCapCents,
  });
}

/** Atomic upsert: increment today's usage + ensure caps are seeded. */
export async function recordUsage(input: {
  repo: string;
  tokens: number;
  costCents: number;
  capTokens: number;
  capCostCents: number;
}): Promise<void> {
  const db = createDb();
  const date = today();
  await db
    .insert(budgets)
    .values({
      repo: input.repo,
      date,
      tokensUsed: input.tokens,
      costCents: input.costCents,
      capTokens: input.capTokens,
      capCostCents: input.capCostCents,
    })
    .onConflictDoUpdate({
      target: [budgets.repo, budgets.date],
      set: {
        tokensUsed: sql`${budgets.tokensUsed} + ${input.tokens}`,
        costCents: sql`${budgets.costCents} + ${input.costCents}`,
      },
    });
}
