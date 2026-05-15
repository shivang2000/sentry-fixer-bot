import { describe, expect, it } from "bun:test";
import { decideBudget } from "./enforce";

describe("decideBudget", () => {
  it("allows when under both caps", () => {
    expect(
      decideBudget({ usedTokens: 100, usedCostCents: 50, capTokens: 1000, capCostCents: 2500 }),
    ).toEqual({ allowed: true });
  });

  it("denies on tokens cap (>= is denied, equal counts as exceeded)", () => {
    expect(
      decideBudget({ usedTokens: 1000, usedCostCents: 50, capTokens: 1000, capCostCents: 2500 }),
    ).toEqual({ allowed: false, reason: "tokens_exceeded" });
  });

  it("denies on cost cap", () => {
    expect(
      decideBudget({ usedTokens: 100, usedCostCents: 2500, capTokens: 1000, capCostCents: 2500 }),
    ).toEqual({ allowed: false, reason: "cost_exceeded" });
  });

  it("prefers tokens_exceeded when both are over (deterministic order)", () => {
    expect(
      decideBudget({ usedTokens: 9999, usedCostCents: 9999, capTokens: 1, capCostCents: 1 }),
    ).toEqual({ allowed: false, reason: "tokens_exceeded" });
  });
});
