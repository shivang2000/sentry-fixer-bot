export type BudgetCheck =
  | { allowed: true }
  | { allowed: false; reason: "tokens_exceeded" | "cost_exceeded" };

/** Pure decision: given today's usage + caps, is one more run allowed? */
export function decideBudget(input: {
  usedTokens: number;
  usedCostCents: number;
  capTokens: number;
  capCostCents: number;
}): BudgetCheck {
  if (input.usedTokens >= input.capTokens) return { allowed: false, reason: "tokens_exceeded" };
  if (input.usedCostCents >= input.capCostCents) return { allowed: false, reason: "cost_exceeded" };
  return { allowed: true };
}
